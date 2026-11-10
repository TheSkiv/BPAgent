const express              = require('express');
const router               = express.Router();

function formatReceived(dateStr) {
  try {
    const d = new Date(dateStr);
    const dd  = String(d.getDate()).padStart(2, '0');
    const mm  = String(d.getMonth() + 1).padStart(2, '0');
    const hh  = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm} ${hh}:${min}`;
  } catch {
    return dateStr || '';
  }
}
const { isAuthorized, checkConnection, fetchRecentEmails, fetchEmailsMatching, fetchAttachmentText } = require('../core/imapMail');
const { extractAll, extractPlatePairs, extractPlates, stripHtml, waybillWeightKg } = require('../core/emailExtract');
const { extractOrders } = require('../core/aiExtract');

// AI email extraction is the active path; set AI_EXTRACT=false to fall back to the (paused)
// deterministic regex algorithm.
const AI_EXTRACT = process.env.AI_EXTRACT !== 'false';

// Deterministic fallback, normalized to the same shape aiExtract returns.
function extractOrdersDeterministic(emails) {
  return emails.map(email => {
    const ex = extractAll(email.body, email.subject);
    let pairs = [];
    if (ex.plates.length === 2) {
      pairs = [{ plates: ex.plates, driver: ex.driver_name }];
    } else if (ex.plates.length > 2 && ex.plates.length % 2 === 0) {
      pairs = extractPlatePairs(email.body);
      if (!pairs.length) {
        for (let i = 0; i < ex.plates.length; i += 2)
          pairs.push({ plates: [ex.plates[i], ex.plates[i + 1]], driver: '' });
      }
    }
    const orders = pairs.map(p => ({
      plates: p.plates, driver: p.driver || '', cargo: ex.cargo,
      weight: ex.is_bulk ? '' : ex.weight, bulk: ex.is_bulk,
    }));
    return { relevant: orders.length > 0, orders };
  });
}
const { appendOrderRow, removeNotCheckRows, refreshCargo, updateOrderCargo, updateOrderFields, todayOrderPlates } = require('../core/ordersExcel');
const { classifySender, addToCheck, isConfirmed } = require('../core/senders');
const { markDone, isDone, normalizePlate } = require('../core/doneTracker');
const orderStore = require('../core/orderStore');
const { ensureOrder } = orderStore;
const { saveEmailData }    = require('../core/emailCache');
const { syncCargo }        = require('../core/syncCargo');

const { TERMINAL_EMAILS } = require('../core/terminals');

const PRK_TERMINAL_SENDER = 'terminal@bpa.lt';

// terminal@bpa.lt only ever sends confirmations, never new orders (see CLAUDE.md). An email
// from them addressed to either terminal dispatch address counts as confirmation the truck
// was handed off — a PDF attachment is not required.
const TERMINAL_DISPATCH_ADDRESSES = new Set(Object.values(TERMINAL_EMAILS));

function addressedToDispatch(toHeader) {
  const found = (toHeader || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  return found.some(a => TERMINAL_DISPATCH_ADDRESSES.has(a.toLowerCase()));
}

// terminal@bpa.lt's gate-pass subjects are "Birios trąšos <grade> - <plate>" — the source order
// email (Transwina etc.) only ever says generic "MOP", never the g/s grade. This is the one
// place that grade becomes known.
function extractCargoGrade(subject) {
  const m = String(subject || '').match(/trąšos\s+([A-Za-zĄ-Ž0-9()]+)\s*-/i);
  return m ? m[1].trim() : '';
}

// MOP potash always ships bulk here regardless of wording (see CLAUDE.md BULK detection rule) —
// correct a generic "MOP" placeholder to the specific gMOP/sMOP grade once terminal reveals it.
function correctMopGrade(tracked, subject) {
  const grade = extractCargoGrade(subject);
  if (!grade || !/mop/i.test(grade)) return;

  // Cargo already names this grade (e.g. "sMOP 60K (miltinis)") — it's more detailed than the
  // terminal subject, don't clobber it. Just make sure bulk is set.
  if (tracked.cargo && new RegExp(grade, 'i').test(tracked.cargo)) {
    if (!tracked.bulk) {
      orderStore.updateOrderFields(tracked.id, { bulk: true });
      updateOrderFields(tracked.plate, { bulk: true });
    }
    return;
  }

  // Bare/generic cargo (e.g. plain "MOP", or empty) — safe to replace with the specific grade.
  orderStore.updateOrderFields(tracked.id, { cargo: grade, bulk: true });
  updateOrderFields(tracked.plate, { cargo: grade, bulk: true });
  console.log(`PRK confirmed by ${PRK_TERMINAL_SENDER}: ${tracked.plate} cargo corrected "${tracked.cargo}" → "${grade}"`);
}

// Scans today's terminal confirmation emails (from terminal@bpa.lt, addressed to terminal
// dispatch) and marks any today's-order plate found in the subject/body as done — except a
// BULK order, where this email is only the gate-pass request (weight/PRK still to follow).
async function markConfirmedPlatesDone() {
  const orderPlates = todayOrderPlates();
  if (!orderPlates.length) return 0;

  // normalized plate part -> full order plate string ("MTV610//EP012")
  const partToOrder = new Map();
  for (const full of orderPlates) {
    for (const part of full.split('//')) {
      const n = normalizePlate(part);
      if (n) partToOrder.set(n, full);
    }
  }

  const emails = await fetchEmailsMatching(`from:${PRK_TERMINAL_SENDER}`);
  const marked = new Set();

  for (const email of emails) {
    if (!addressedToDispatch(email.to)) continue;
    const plates = extractPlates(stripHtml(`${email.subject}\n${email.body}`));
    for (const p of plates) {
      const full = partToOrder.get(normalizePlate(p));
      if (!full) continue;

      // Correct MOP grade/bulk on every non-cancelled order for this plate today, not just the
      // still-open one — a plate may already be closed (done) by the time terminal's subject
      // reveals the specific grade.
      for (const o of orderStore.findByPlate(full)) {
        if (o.state !== 'cancelled') correctMopGrade(o, email.subject);
      }

      let tracked = orderStore.activeOrderForPlate(full);
      if (tracked) tracked = orderStore.getOrder(tracked.id); // re-fetch after correction above

      if (tracked && tracked.bulk) {
        if (tracked.state === 'gate_pass_ordered' || orderStore.CLOSED_STATES.includes(tracked.state)) continue;
        orderStore.setState(tracked.id, 'gate_pass_ordered', { actor: 'terminal', detail: 'PRK request sent to KKT dispatch (bulk — gate pass, not final)' });
        marked.add(full);
        console.log(`PRK confirmed by ${PRK_TERMINAL_SENDER}: ${full} gate pass ordered (bulk)`);
        continue;
      }

      // A saved draft is already in the done list (it blocks a second RUN PRK) but its order is
      // still open, `drafted` — the dispatch email is what closes it (ROADMAP A11).
      if (!isDone(full) || tracked?.state === 'drafted') {
        markDone(full);
        if (tracked) orderStore.setState(tracked.id, 'done', { actor: 'terminal', detail: 'PRK confirmed by terminal@bpa.lt' });
        marked.add(full);
        console.log(`PRK confirmed by ${PRK_TERMINAL_SENDER}: marked ${full} done`);
      }
    }
  }
  return marked.size;
}

// GET /gmail/status — actually connects (IMAP has no OAuth session to just check the presence
// of; either the configured credentials work right now or they don't).
router.get('/status', async (req, res) => {
  if (!isAuthorized()) return res.json({ authorized: false });
  res.json({ authorized: await checkConnection() });
});

// Core of GET /gmail/emails, factored out so the auto-poll timer below can call the exact
// same logic without going through HTTP. Returns { emails, summary } or throws (AUTH_REQUIRED
// on an expired token, same as before).
async function pollAndProcessEmails({ max, query }) {
    // The stock reports are the list the office rechecks daily — refresh the cargo list from them
    // on every RECHECK so cargo names and vessels never go stale (operator, 2026-11-09).
    try {
      const sync = await syncCargo();
      if (sync.synced || sync.updated) console.log(`Cargo list from stock: ${sync.synced} added, ${sync.updated} vessel(s) updated`);
      for (const e of sync.errors) console.warn('Cargo list from stock:', e);
    } catch (err) {
      console.warn('Cargo list refresh failed:', err.message);
    }
    await removeNotCheckRows();
    const emails = await fetchRecentEmails(max, query);

    // 1) Sender filter — notcheck ignored, unknown flagged. Collect the rest for extraction.
    const results = [];
    const kept    = []; // { email, ri }

    for (const email of emails) {
      const senderStatus = await classifySender(email.from);
      if (senderStatus === 'notcheck') {
        results.push({ id: email.id, subject: email.subject, from: email.from,
          date: email.date, body: '', plates: [], driver: '', cargo: '',
          status: 'ignored', skipReason: 'Sender in Not Check list' });
        continue;
      }
      if (senderStatus === 'unknown') {
        await addToCheck(email.from, true); // red highlight — unreviewed
        console.log(`Unknown sender flagged for review: ${email.from}`);
      }
      const ri = results.push({ id: email.id, subject: email.subject, from: email.from,
        date: email.date, body: email.body, plates: [], driver: '', cargo: '',
        status: 'no_plates', skipReason: '' }) - 1;
      kept.push({ email, ri });
    }

    // 2) Pull text out of PDF attachments (waybills etc.) — often the only place cargo/weight
    // actually lives when the body is just a signature block. Best-effort: a parse failure on
    // one attachment must not block the rest of the batch.
    await Promise.all(kept.map(async ({ email }) => {
      const atts = email.attachments || [];
      if (!atts.length) return;
      const texts = [];
      for (const att of atts) {
        try {
          const text = await fetchAttachmentText(email.id, att.attachmentId, att.filename);
          if (text.trim()) texts.push(text.trim());
        } catch (err) {
          console.error(`PDF parse failed for ${att.filename}:`, err.message);
        }
      }
      if (texts.length) email.attachmentText = texts.join('\n\n---\n\n');
      email.attachmentTexts = texts;
    }));

    // 3) Extract orders — AI batches (default) or the paused deterministic algorithm.
    const keptEmails  = kept.map(k => k.email);
    const extractions = AI_EXTRACT
      ? await extractOrders(keptEmails)
      : extractOrdersDeterministic(keptEmails);

    // Several waybills for one truck are one load: the truck's weight is their sum. The model
    // took one of two 12 t waybills for MLL371//RZ817 (2026-11-10). Checked here without the
    // model: a one-truck, non-bulk order whose email has 2+ waybills, each with a readable
    // quantity, gets their sum when the extracted weight differs from it.
    keptEmails.forEach((email, k) => {
      const ext = extractions[k];
      const texts = email.attachmentTexts || [];
      if (!ext?.relevant || ext.orders.length !== 1 || ext.orders[0].bulk || texts.length < 2) return;
      const weights = texts.map(waybillWeightKg);
      if (weights.some(w => !w)) return;
      const sum = weights.reduce((a, b) => a + b, 0);
      if (Number(ext.orders[0].weight) !== sum) {
        console.log(`Weight: ${ext.orders[0].plates.join('/')} has ${weights.length} waybills (${weights.join(' + ')} kg) — weight ${ext.orders[0].weight || 'none'} → ${sum}`);
        ext.orders[0].weight = sum;
      }
    });

    // 4) Persist each email's orders into today's Excel.
    for (let k = 0; k < kept.length; k++) {
      const { email, ri } = kept[k];
      const ext    = extractions[k] || { relevant: false, orders: [] };
      const result = results[ri];

      if (!ext.relevant || !ext.orders.length) {
        result.status     = ext.relevant ? 'no_plates' : 'ignored';
        result.skipReason = ext.relevant ? '' : 'Not a truck order';
        continue;
      }

      const savedPlates   = [];
      const skippedPlates = [];
      const drivers       = [];

      for (const order of ext.orders) {
        const plate = order.plates.join('//');
        result.plates.push(...order.plates);
        if (order.driver) drivers.push(order.driver);
        if (order.cargo && !result.cargo) result.cargo = order.cargo;

        saveEmailData(plate, {
          from:        email.from,
          subject:     email.subject,
          body:        email.body,
          messageId:   email.id,
          attachments: email.attachments || [],
        });

        try {
          const saveResult = appendOrderRow({
            plate,
            driver:   order.driver,
            cargo:    order.cargo,
            weight:   order.bulk ? '' : order.weight,
            bulk:     order.bulk,
            sender:   email.from,
            received: formatReceived(email.date),
          });
          if (saveResult.skipped) updateOrderCargo(plate, order.cargo, order.bulk ? '' : order.weight);
          if (saveResult.saved) savedPlates.push(plate);
          else skippedPlates.push(plate);

          // State-store record, keyed on plate + source email so a repeat plate from a
          // different email gets its own order rather than colliding.
          // Only a human-confirmed sender goes straight to the work queue; everyone else
          // waits for explicit confirmation (SECURITY.md — senders are spoofable).
          const tracked = ensureOrder({
            plate,
            cargo:     order.cargo,
            weight:    order.bulk ? '' : order.weight,
            bulk:      order.bulk,
            sender:    email.from,
            received:  formatReceived(email.date),
            messageId: email.id,
            subject:   email.subject,
            state:     isConfirmed(email.from) ? 'ready' : 'needs_human',
          });
          // ensureOrder no-ops on an existing key (e.g. this email got reprocessed after the
          // PDF-parsing fix) — make sure a freshly-extracted cargo/weight still lands on it.
          if (tracked && (!tracked.cargo || !tracked.weight)) {
            orderStore.updateOrderFields(tracked.id, {
              cargo:  !tracked.cargo && order.cargo ? order.cargo : undefined,
              weight: !tracked.weight && !order.bulk && order.weight ? order.weight : undefined,
            });
          }
        } catch (err) {
          result.status     = 'error';
          result.skipReason = err.message;
        }
      }

      result.driver = drivers.join(', ');
      if (result.status !== 'error') {
        if (savedPlates.length)        result.status = 'saved';
        else if (skippedPlates.length) { result.status = 'skipped'; result.skipReason = 'Plates already in Excel'; }
      }
    }

    const saved    = results.filter(r => r.status === 'saved').length;
    const skipped  = results.filter(r => r.status === 'skipped').length;
    const noplates = results.filter(r => r.status === 'no_plates').length;
    const ignored  = results.filter(r => r.status === 'ignored').length;

    const cargoFilled = 0; // deterministic cargo back-fill paused while AI extraction is on

    let prkMarked = 0;
    try {
      prkMarked = await markConfirmedPlatesDone();
    } catch (err) {
      console.error('PRK confirmation scan failed:', err.message);
    }

    console.log(`Gmail processed: ${results.length} new emails — ${saved} saved, ${skipped} duplicate, ${noplates} no plates, ${ignored} ignored (Not Check); ${cargoFilled} cargo row(s) back-filled; ${prkMarked} plate(s) marked done from PRK confirmations`);

    return { emails: results, summary: { total: results.length, saved, skipped, noplates, cargoFilled, prkMarked } };
}

// A poll (manual click or auto-timer) already in flight — the other must wait rather than
// run concurrently and race on the same Excel/order-state files.
let pollInProgress = false;

// GET /gmail/emails — fetch new emails, auto-extract and save to Excel
router.get('/emails', async (req, res) => {
  if (pollInProgress) {
    return res.status(409).json({ error: 'BUSY', message: 'A Gmail check is already in progress — try again in a moment.' });
  }
  pollInProgress = true;
  try {
    const max   = parseInt(req.query.max) || 30;
    const query = req.query.q || 'in:inbox';
    const result = await pollAndProcessEmails({ max, query });
    res.json(result);
  } catch (err) {
    if (err.message === 'AUTH_REQUIRED') {
      return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Gmail token expired — please reconnect.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    pollInProgress = false;
  }
});

module.exports = router;
