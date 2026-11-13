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
const { isAuthorized, checkConnection, fetchRecentEmails, unmarkSeen, fetchEmailsMatching, fetchAttachmentText } = require('../core/imapMail');
const { extractAll, extractPlatePairs, extractPlates, stripHtml, waybillWeightKg } = require('../core/emailExtract');
const { extractOrders } = require('../core/aiExtract');
const { deliveryFromText } = require('../core/cmr');
const { applyPlateChange } = require('../core/plateChange');

// S59: the open truck (today / yesterday) a later email corrects: same company (sender's domain),
// shares a plate with it, names more plates or a different trailer — never fewer (a reply that
// only mentions the tractor changes nothing). More than one candidate → not sure, none.
function plateCorrectionFor(plates, from) {
  const dom = s => ((String(s || '').match(/<([^>]+)>/) || [, s || ''])[1].split('@')[1] || '').trim().toLowerCase();
  const norm = p => String(p).replace(/[^\p{L}\d]/gu, '').toLowerCase();
  const mine = plates.map(norm).filter(Boolean);
  const d = dom(from);
  if (!d || !mine.length) return null;
  const hits = [...orderStore.listOrders(), ...orderStore.listOrders(orderStore.daysAgo(1))].filter(o => {
    if (orderStore.CLOSED_STATES.includes(o.state) || dom(o.email?.from) !== d) return false;
    const theirs = String(o.plate || '').split(/\/+/).map(norm).filter(Boolean);
    if (!theirs.some(p => mine.includes(p))) return false;
    if (mine.join('') === theirs.join('') || mine.length < theirs.length) return false;
    return !mine.every(p => theirs.includes(p));
  });
  return hits.length === 1 ? hits[0] : null;
}

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
const releaseBook = require('../core/releaseBook');
const { ensureOrder } = orderStore;
const { saveEmailData, getEmailData } = require('../core/emailCache');

// A swapped truck (owner, 2026-11-11): Linas Agro sent važtaraštis LAV00110184 for NGZ189//ZG485,
// then an *updated* LAV00110184 for LTK202//TK202 — same load, the truck changed — and both became
// trucks. The document number is the start of the file name ("LAV00110184PackSlip_60182.pdf").
// The same number from the same sender naming another, newer truck cancels the older one —
// unless the older truck's PRK is already submitted (a live customs document: a person decides).
const waybillNumbers = atts => [...new Set((atts || [])
  .map(a => (String(a.filename || '').match(/^([A-Z]{2,4}\d{6,})PackSlip/i) || [])[1])
  .filter(Boolean).map(s => s.toUpperCase()))];
const senderOf = from => (String(from || '').match(/<([^>]+)>/) || [, from || ''])[1].trim().toLowerCase();
// A cancelled važtaraštis (owner, 2026-11-12: JCV034//OG708). Linas Agro's system sends
// "Atšauktas (-i) krovinio gabenimo važtaraštis (-čiai)" with the document number (LAV…, in the
// attachment name and the text) and the plates ("…valstybinis numeris: JCV034",
// "Priekabos/puspriekabės valstybinis numeris: OG708"). A fixed rule, no AI: the open truck from
// the same sender with that važtaraštis — or, without a cached one, those plates — is cancelled.
// A truck whose PRK is already submitted only gets a note: annulling it (Anuliuoti) is a person's.
const isCancelledWaybill = email => /^\s*Atšauktas\s*\(-i\)\s*krovinio gabenimo važtaraštis/i.test(email.subject || '');
function cancelForWaybill(email) {
  const text = `${email.body || ''}`;
  const numbers = [...new Set([...waybillNumbers(email.attachments), ...(text.match(/\bLAV\d{6,}\b/gi) || []).map(s => s.toUpperCase())])];
  const tractor = (text.match(/Transporto\s+priemon\S*\s+valstybinis\s+numeris:\s*([A-Z0-9]{4,10})/i) || [])[1] || '';
  const trailer = (text.match(/puspriekab\S*\s+valstybinis\s+numeris:\s*([A-Z0-9]{4,10})/i) || [])[1] || '';
  const plateKey = orderStore.normalizePlate(`${tractor}${trailer}`);
  const done = [];
  for (const day of [orderStore.daysAgo(0), orderStore.daysAgo(1)]) {
    for (const o of orderStore.listOrders(day)) {
      if (orderStore.CLOSED_STATES.includes(o.state) || senderOf(o.email?.from) !== senderOf(email.from)) continue;
      const cachedNumbers = waybillNumbers((getEmailData(o.plate, day) || {}).attachments);
      const byNumber = cachedNumbers.some(n => numbers.includes(n));
      const byPlate = !cachedNumbers.length && plateKey && o.plateNorm === plateKey;
      if (!byNumber && !byPlate) continue;
      const why = `važtaraštis ${numbers.join(', ') || '(no number)'} cancelled by the sender ("${email.subject}")`;
      const prk = o.docs?.PRK;
      if (prk?.number && !/ruošiamas/i.test(prk.status || '')) {
        orderStore.setState(o.id, o.state, { actor: 'intake', detail: `${why} — its PRK ${prk.number} is already submitted: a person decides (Anuliuoti)` });
        console.warn(`Cancelled važtaraštis: ${o.plate} has submitted PRK ${prk.number} — left for the operator`);
        done.push(`${o.plate}: PRK already submitted — check it`);
        continue;
      }
      orderStore.setState(o.id, 'cancelled', { actor: 'intake', detail: `${why}${prk?.number ? ` — its draft ${prk.number} goes with the draft cleanup` : ''}` });
      console.log(`Cancelled važtaraštis: ${o.plate} cancelled (${numbers.join(', ')})`);
      done.push(`${o.plate}: cancelled`);
    }
  }
  if (!done.length) console.log(`Cancelled važtaraštis ${numbers.join(', ')} (${tractor}/${trailer}): no open truck of ours — nothing to cancel`);
  return done;
}

// An order withdrawn in a reply (owner, 2026-11-12): Baltic Agro sent HDM755//NJ615 ("TSP 46 po
// 600 kg") and six minutes later replied "Atsiprašau, laiškas ne jums" — the AI read the reply's
// quoted original and counted it a duplicate. Until the AI reads intent (ROADMAP S33 step 3), a
// fixed rule: a reply ("RE:" / "ATS:") from the same, confirmed sender in the same thread (same
// subject once the prefixes go), whose OWN text — not the quoted email — withdraws the order,
// cancels that thread's open trucks; a submitted PRK only gets a note.
// Disclaimer words ("gavote žinutę per klaidą", "received in error") are deliberately not here:
// a 30-day scan matched them in 32 of 239 replies (2026-11-12).
const WITHDRAWN = /(lai[šs]kas\s+(buvo\s+)?ne\s+jums|ne\s+jums\s+skirt|klaidingai\s+i[šs]si|at[šs]auki|at[šs]aukt|nebereik|nebeatvyks|nebeva[žz]iuos|not\s+for\s+you|sent\s+by\s+mistake|please\s+(ignore|disregard)|\bcancel(led)?\b)/i;
const isReply = subject => /^\s*(re|ats|aw|sv)\s*:/i.test(subject || '');
const threadOf = s => String(s || '').replace(/^(\s*(re|fw|fwd|aw|sv|ats|pers)\s*:|\s*[:\-–—]+)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
// The reply's own words: up to the sign-off, a disclaimer or the quoted email, whichever comes first.
function ownText(body) {
  const lines = String(body || '').split(/\r?\n/);
  const end = /^\s*[*_]*\s*(From|Nuo|Sent|Išsiųsta|Siuntėjas|Kam|To)\s*[*_]*\s*:|^\s*-{2,}\s*(Original|Forwarded)|^\s*>|^\s*On .+ wrote:|^\s*(Pagarbiai|Su pagarba|Best regards|Kind regards|Regards|Ačiū|Dėkojame|Dėkui)\b|konfidencial|confidential|CAUTION|ATSARGIAI|Perspėjimas|Informuojame, kad/i;
  const cut = lines.findIndex(l => end.test(l));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').slice(0, 800);
}
const isWithdrawal = email => isReply(email.subject) && WITHDRAWN.test(ownText(email.body));
function cancelWithdrawn(email) {
  const thread = threadOf(email.subject);
  const done = [];
  for (const day of [orderStore.daysAgo(0), orderStore.daysAgo(1)]) {
    for (const o of orderStore.listOrders(day)) {
      if (orderStore.CLOSED_STATES.includes(o.state) || senderOf(o.email?.from) !== senderOf(email.from)) continue;
      if (threadOf(o.email?.subject) !== thread) continue;
      const why = `withdrawn by the sender in a reply ("${ownText(email.body).replace(/\s+/g, ' ').trim().slice(0, 80)}")`;
      const prk = o.docs?.PRK;
      if (prk?.number && !/ruošiamas/i.test(prk.status || '')) {
        orderStore.setState(o.id, o.state, { actor: 'intake', detail: `${why} — its PRK ${prk.number} is already submitted: a person decides (Anuliuoti)` });
        done.push(`${o.plate}: PRK already submitted — check it`);
        continue;
      }
      orderStore.setState(o.id, 'cancelled', { actor: 'intake', detail: `${why}${prk?.number ? ` — its draft ${prk.number} goes with the draft cleanup` : ''}` });
      console.log(`Withdrawn order: ${o.plate} cancelled ("${email.subject}")`);
      done.push(`${o.plate}: cancelled`);
    }
  }
  if (!done.length) console.log(`Withdrawal reply "${email.subject}" from ${senderOf(email.from)}: no open truck in that thread`);
  return done;
}

function replaceSwappedTrucks(tracked, email) {
  const numbers = waybillNumbers(email.attachments);
  if (!tracked || !numbers.length) return;
  for (const day of [orderStore.daysAgo(0), orderStore.daysAgo(1)]) {
    for (const o of orderStore.listOrders(day)) {
      if (o.id === tracked.id || o.plateNorm === tracked.plateNorm || orderStore.CLOSED_STATES.includes(o.state)) continue;
      if ((o.createdAt || '') >= (tracked.createdAt || '')) continue;   // only an older truck is replaced
      if (senderOf(o.email?.from) !== senderOf(email.from)) continue;
      const shared = waybillNumbers((getEmailData(o.plate, day) || {}).attachments).find(n => numbers.includes(n));
      if (!shared) continue;
      const prk = o.docs?.PRK;
      if (prk?.number && !/ruošiamas/i.test(prk.status || '')) {
        orderStore.setState(o.id, o.state, { actor: 'intake', detail: `važtaraštis ${shared} was updated for ${tracked.plate} — this truck may be replaced; its PRK ${prk.number} is already submitted, so check it and cancel by hand` });
        console.warn(`Truck swap: ${o.plate} → ${tracked.plate} on ${shared}, but ${prk.number} is submitted — left for the operator`);
        continue;
      }
      orderStore.setState(o.id, 'cancelled', { actor: 'intake', detail: `replaced by ${tracked.plate} on the updated važtaraštis ${shared}${prk?.number ? ` — its draft ${prk.number} goes with the draft cleanup` : ''}` });
      console.log(`Truck swap: ${o.plate} cancelled — ${tracked.plate} replaces it on važtaraštis ${shared}`);
    }
  }
}
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
        // Forward only (owner, 2026-11-12): the terminal's copy of the loading order is read again
        // on every check, and it pulled NCS165//UY124 back from to_print six times in 8 minutes
        // (the KIPIS check moved it on again each time, each flip starting another KIPIS round). A
        // truck past the loading order — weight entered, PRK made, printing — is left alone.
        if (!['received', 'ready'].includes(tracked.state) || tracked.loadedKg || tracked.docs?.PRK?.number) continue;
        orderStore.setState(tracked.id, 'gate_pass_ordered', { actor: 'terminal', detail: 'PRK request sent to KKT dispatch (bulk — gate pass, not final)' });
        marked.add(full);
        console.log(`PRK confirmed by ${PRK_TERMINAL_SENDER}: ${full} gate pass ordered (bulk)`);
        continue;
      }

      // A saved draft is already in the done list (it blocks a second RUN PRK) but its order is
      // still open, `drafted` or `submitted` — the dispatch email is what closes it (A11, A18).
      if (!isDone(full) || tracked?.state === 'drafted' || tracked?.state === 'submitted') {
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
      // A seller's release announcement ("Release 293226" from @helmag.com) goes into our release
      // book (releaseBook.js) — it is not a truck order.
      const release = releaseBook.fromEmail(email);
      if (release) {
        results.push({ id: email.id, subject: email.subject, from: email.from, date: email.date, body: '', plates: [], driver: '', cargo: '',
          status: 'ignored', skipReason: `Release ${release.nr} recorded (${release.buyer}, ${release.product}, ${release.quantityKg / 1000} t)` });
        continue;
      }
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
      // A cancelled važtaraštis is handled by a fixed rule, not read as an order. Only a confirmed
      // sender's cancellation counts (senders are spoofable).
      if (isCancelledWaybill(email) && isConfirmed(email.from)) {
        const done = cancelForWaybill(email);
        results.push({ id: email.id, subject: email.subject, from: email.from, date: email.date, body: '', plates: [], driver: '', cargo: '',
          status: 'ignored', skipReason: `Cancelled važtaraštis — ${done.join('; ') || 'no open truck to cancel'}` });
        continue;
      }
      // A reply withdrawing the order ("laiškas ne jums", "please ignore", …). It leaves the normal
      // reading only when it actually withdrew a truck of ours — anything else is read as before.
      if (isWithdrawal(email) && isConfirmed(email.from)) {
        const done = cancelWithdrawn(email);
        if (done.length) {
          results.push({ id: email.id, subject: email.subject, from: email.from, date: email.date, body: '', plates: [], driver: '', cargo: '',
            status: 'ignored', skipReason: `Order withdrawn in a reply — ${done.join('; ')}` });
          continue;
        }
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
    let plateChanges  = 0;   // S59: trucks whose plates a reply corrected
    // The emails were marked as seen when fetched. If the extraction cannot run at all (OpenAI
    // unreachable), hand them back — otherwise an unattended check would lose them for good.
    let extractions;
    try {
      extractions = AI_EXTRACT
        ? await extractOrders(keptEmails)
        : extractOrdersDeterministic(keptEmails);
    } catch (err) {
      unmarkSeen(emails.map(e => e.id));
      console.error(`Mail check: extraction failed, ${emails.length} email(s) left for the next check — ${err.message}`);
      throw err;
    }

    // S59: a truck read with only its tractor, while its own email writes the trailer right after
    // it — Baltic Agro's "NHS949 PO559 Oleksandr Salan …" (2026-11-12) became "NHS949". The word
    // after the plate is added when it has the shape of a plate (letters and digits, at most 5
    // digits — not a name, an ID or a phone number).
    const PLATE_WORD = /^(?=.*\p{L})(?=.*\d)[\p{L}\d-]{4,10}$/u;
    keptEmails.forEach((email, k) => {
      const ext = extractions[k];
      if (!ext?.relevant) return;
      const text = `${email.subject || ''}\n${stripHtml(email.body || '')}\n${email.attachmentText || ''}`;
      for (const o of ext.orders) {
        if (o.plates.length !== 1) continue;
        const p = o.plates[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = text.match(new RegExp(`(?<![\\p{L}\\d])${p}[ \\t]*[/\\\\]{0,2}[ \\t]*([\\p{L}\\d-]{4,10})(?![\\p{L}\\d])`, 'iu'));
        const next = m && m[1].toUpperCase();
        if (!next || !PLATE_WORD.test(next) || (next.match(/\d/g) || []).length > 5 || next === o.plates[0]) continue;
        console.log(`Plates: ${o.plates[0]} in "${email.subject}" is followed by ${next} — trailer added`);
        o.plates.push(next);
      }
    });

    // S56: a truck must be in its own email. In a batch the model sometimes files a truck under
    // the next email (2026-11-12, checked: Linas Agro's JCV034/OG708 came back under Baltic Agro's
    // email, with Linas Agro's unloading place, and Baltic Agro's NHS949 was lost; each read alone
    // was right). A plate not found in the email's subject / text / attachments is dropped there;
    // the email left without trucks is then read alone by the second look below.
    const squashPlate = s => String(s || '').replace(/[^\p{L}\d]/gu, '').toUpperCase();
    keptEmails.forEach((email, k) => {
      const ext = extractions[k];
      if (!ext?.relevant || !ext.orders.length) return;
      const hay = squashPlate(`${email.subject || ''}\n${stripHtml(email.body || '')}\n${email.attachmentText || ''}`);
      const kept = ext.orders.filter(o => o.plates.some(p => hay.includes(squashPlate(p))));
      if (kept.length === ext.orders.length) return;
      for (const o of ext.orders.filter(x => !kept.includes(x))) console.warn(`Extraction: ${o.plates.join('/')} is not in "${email.subject}" — dropped there (read into the wrong email)`);
      ext.orders = kept;
    });

    // A second look, one email at a time. In a batch of 10 the model judged UHB's "Release 291568
    // DAP" emails "not a truck order" three times (2026-11-10) — their loading table listed
    // JSB303/IA973 and NEZ584/ZB927, which it finds every time when the email is read alone. So an
    // email the batch dropped, but whose text has plate-like numbers, is read again on its own.
    // Still nothing → a warning in the server log. (The dashboard's "Check by hand" list was
    // removed 2026-11-12, S40: in 3 days it listed only confirmations and replies, no missed order.)
    if (AI_EXTRACT) {
      for (let k = 0; k < keptEmails.length; k++) {
        const ext = extractions[k];
        if (ext && ext.relevant && ext.orders.length) continue;
        const email = keptEmails[k];
        const text  = `${email.subject || ''}\n${stripHtml(email.body || '')}\n${email.attachmentText || ''}`;
        const plates = extractPlates(text);
        if (!plates.length) continue;
        try {
          const [alone] = await extractOrders([email]);
          if (alone && alone.relevant && alone.orders.length) {
            console.log(`Extraction: "${email.subject}" — skipped in the batch, read alone: ${alone.orders.map(o => o.plates.join('/')).join(', ')}`);
            extractions[k] = alone;
          } else {
            console.warn(`Extraction: "${email.subject}" from ${email.from} has plate-like numbers (${plates.slice(0, 4).join(', ')}) but is not read as a truck order — check it`);
            results[kept[k].ri].possiblyMissed = plates.slice(0, 4);
          }
        } catch (err) {
          console.warn(`Extraction: re-reading "${email.subject}" failed — ${err.message}`);
        }
      }
    }

    // A truck read without its cargo (owner, 2026-11-12: UHB Agro's "Release 291568 DAP" tables —
    // NUF146, NCP997, LHI945 came in blank, "cargo not identified", although the subject and every
    // row say DAP; run again the model finds it, so it is an occasional miss). In order:
    //   1. the cargo the other trucks of the same email have, when they all agree;
    //   2. the release number the email names (owner, 2026-11-12: "a release is always given to a
    //      specific cargo from a specific vessel") — its product, and bulk when the release is bulk;
    //   3. the email read again on its own;
    //   4. the one known cargo the email's subject / text names (config/cargo.xlsx).
    let releaseRows = null;   // fetched once, only when a truck still has no cargo
    const releaseFor = async email => {
      if (!releaseRows) {
        try { releaseRows = await require('../core/owners').fetchReleases(); }
        catch (err) { console.warn(`Cargo: release list unavailable — ${err.message}`); releaseRows = []; }
      }
      const text = `${email.subject || ''}\n${stripHtml(email.body || '')}\n${email.attachmentText || ''}`;
      const numbers = new Set(text.match(/\b\d{6,10}\b/g) || []);
      const hits = releaseRows.filter(r => (r.numbers || []).some(n => numbers.has(String(n.value))));
      const products = [...new Set(hits.map(r => r.product))];
      return products.length === 1 ? hits[0] : null;   // two different products → not sure, skip
    };
    for (let k = 0; k < keptEmails.length; k++) {
      const ext = extractions[k];
      const blank = ext?.relevant ? ext.orders.filter(o => !String(o.cargo || '').trim()) : [];
      if (!blank.length) continue;
      const email = keptEmails[k];
      const fill = (o, cargo, how) => {
        o.cargo = cargo;
        console.log(`Cargo: ${o.plates.join('/')} in "${email.subject}" was read without cargo — "${cargo}" (${how})`);
      };
      const known = [...new Set(ext.orders.map(o => String(o.cargo || '').trim()).filter(Boolean))];
      if (known.length === 1) { for (const o of blank) fill(o, known[0], 'the other trucks of this email'); continue; }
      const rel = await releaseFor(email);
      if (rel) {
        const no = (rel.numbers || [])[0];
        for (const o of blank) {
          fill(o, rel.product, `release ${no ? no.value : ''}: ${rel.buyer}, ${rel.vessel || 'vessel not set'}${rel.bulk ? ', bulk' : ''}`);
          if (rel.bulk) { o.bulk = true; o.bulkFromRelease = true; }
        }
        continue;
      }
      if (AI_EXTRACT) {
        try {
          const [alone] = await extractOrders([email]);
          const pk = o => (o.plates || []).map(p => normalizePlate(p)).sort().join('|');
          for (const o of blank) {
            const same = (alone?.orders || []).find(a => pk(a) === pk(o) && String(a.cargo || '').trim());
            if (same) { fill(o, String(same.cargo).trim(), 'the email read again alone'); if (same.bulk && !o.bulk) o.bulk = true; }
          }
        } catch (err) {
          console.warn(`Cargo: re-reading "${email.subject}" failed — ${err.message}`);
        }
      }
      const still = blank.filter(o => !String(o.cargo || '').trim());
      if (!still.length) continue;
      const { findCargoInText } = require('../core/cargoList');
      const hit = findCargoInText(email.subject || '') || findCargoInText(`${stripHtml(email.body || '')}\n${email.attachmentText || ''}`);
      if (hit) for (const o of still) fill(o, hit.cargo, 'named in the email');
      else for (const o of still) console.warn(`Cargo: ${o.plates.join('/')} in "${email.subject}" — no cargo found; fix it in the truck window`);
    }

    // Bulk only on evidence in this truck's own email. The model works on 10 emails per call and
    // marked MML743//SN216 bulk (2026-11-10) although its email and waybill say "Amonio sulfatas
    // (600) gran." — bagged; run alone it said bagged every time, so the flag bled over from a
    // neighbouring bulk email. Kept bulk: the email says BULK / palaidas / birios, or the cargo
    // is MOP potash (always bulk here). A bag size in the cargo name ("(600)") is never bulk.
    const BULK_WORDS = /\bbulk\b|palaid|\bbiri(os|ų|ai)?\b/i;
    const MOP_CARGO  = /\b[gs]?mop\b|kalio\s+chlorid/i;
    const BAG_SIZE   = /\(\s*\d{3,4}\s*(kg)?\s*\)|\bpo\s+\d{3,4}\s*kg\b|\bbig\s*bags?\b|\bBB\b/i;
    keptEmails.forEach((email, k) => {
      const ext = extractions[k];
      if (!ext?.relevant) return;
      const text = `${email.subject || ''}\n${stripHtml(email.body || '')}\n${email.attachmentText || ''}`;
      for (const o of ext.orders) {
        if (!o.bulk) continue;
        // A bulk release named in the email is evidence too (S54).
        const keep = !BAG_SIZE.test(o.cargo || '') && (MOP_CARGO.test(o.cargo || '') || BULK_WORDS.test(text) || o.bulkFromRelease);
        if (!keep) {
          console.log(`Bulk: ${o.plates.join('/')} "${o.cargo}" — the model said bulk, but its email does not (no BULK/palaidas/MOP${BAG_SIZE.test(o.cargo || '') ? ', and the cargo names a bag size' : ''}) → bagged`);
          o.bulk = false;
        }
      }
    });

    // One truck listed twice in one email is one load (owner, 2026-11-12): MOB272//PS118 came with
    // Važtaraštis-46 (8 t) and -47 (16 t); the model gave one order per waybill and only the first
    // (8 t) was kept. Bagged orders of the same email with the same plates and cargo become one,
    // their weights added (the bag count follows from the weight). Different cargo stays apart.
    const plateKey = o => (o.plates || []).map(p => String(p).replace(/[^a-z0-9]/gi, '').toLowerCase()).sort().join('|');
    const cargoKey = o => String(o.cargo || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    keptEmails.forEach((email, k) => {
      const ext = extractions[k];
      if (!ext?.relevant || (ext.orders || []).length < 2) return;
      const merged = [];
      for (const o of ext.orders) {
        const same = !o.bulk && merged.find(m => !m.bulk && plateKey(m) === plateKey(o) && cargoKey(m) === cargoKey(o));
        if (!same) { merged.push(o); continue; }
        const before = Number(same.weight) || 0;
        same.weight = before + (Number(o.weight) || 0);
        if (!same.driver && o.driver) same.driver = o.driver;
        console.log(`Merge: ${o.plates.join('/')} is in "${email.subject}" twice — one load, weight ${before} + ${Number(o.weight) || 0} = ${same.weight}`);
      }
      ext.orders = merged;
    });

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

        // S59 (owner, 2026-11-13): "recognise email chains and apply corrections" — a later email
        // from the same company names a truck we already have, with more plates or another
        // trailer (we asked for the trailer, they sent it). That truck takes the new plates; its
        // PRK draft is corrected in KIPIS by the server. Never a truck already done / cancelled.
        const fix = plateCorrectionFor(order.plates, email.from);
        if (fix) {
          const r = applyPlateChange(fix.id, plate, { actor: 'email', why: `"${email.subject}"` });
          if (r.error) {
            // Not a new truck either: the reply is about this one. Say why on it and move on.
            console.warn(`Plates: ${plate} in "${email.subject}" corrects ${fix.plate}, but — ${r.error}`);
            orderStore.plateAmendResult(fix.id, { ok: false, detail: `"${email.subject}" gives the plates ${plate} — not applied: ${r.error}` });
            skippedPlates.push(plate);
            continue;
          }
          if (!r.unchanged) { plateChanges++; savedPlates.push(plate); continue; }
        }

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
          // S55: where it unloads — from the model, else a labelled place in the email / attachments.
          const unloading = order.unloading || deliveryFromText(`${stripHtml(email.body || '')}\n${email.attachmentText || ''}`);
          if (tracked && unloading) orderStore.setUnloading(tracked.id, unloading);
          // Only a confirmed sender's email may replace another truck (senders are spoofable).
          if (tracked && isConfirmed(email.from)) replaceSwappedTrucks(tracked, email);
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
    // "ignored" covered two different things — say which: a sender on the Not-Check list, or an
    // email the model did not read as a truck order (the UHB release emails hid in this count).
    const ignored  = results.filter(r => r.status === 'ignored' && r.skipReason === 'Sender in Not Check list').length;
    const notOrder = results.filter(r => r.status === 'ignored' && r.skipReason !== 'Sender in Not Check list').length;
    const missed   = results.filter(r => r.possiblyMissed).length;

    const cargoFilled = 0; // deterministic cargo back-fill paused while AI extraction is on

    let prkMarked = 0;
    try {
      prkMarked = await markConfirmedPlatesDone();
    } catch (err) {
      console.error('PRK confirmation scan failed:', err.message);
    }

    console.log(`Gmail processed: ${results.length} new emails — ${saved} saved, ${skipped} duplicate, ${noplates} no plates, ${notOrder} not truck orders${missed ? ` (${missed} with plate-like numbers — check)` : ''}, ${ignored} from Not-Check senders; ${cargoFilled} cargo row(s) back-filled; ${prkMarked} plate(s) marked done from PRK confirmations`);

    return { emails: results, summary: { total: results.length, saved, skipped, noplates, notOrder, missed, cargoFilled, prkMarked, plateChanges } };
}

// A poll (manual click or auto-timer) already in flight — the other must wait rather than
// run concurrently and race on the same Excel/order-state files.
let pollInProgress = false;

// The last check (button or timer), for the dashboard: { at, by, summary } or { at, by, error }.
let lastCheck = null;

// One mail check, whoever asked (the Check mail button or the server's timer). Returns the
// result, or null when a check is already running. Throws what the check throws.
async function checkMail({ max = 100, query = 'in:inbox', by = 'button' } = {}) {
  if (pollInProgress) return null;
  pollInProgress = true;
  try {
    const result = await pollAndProcessEmails({ max, query });
    lastCheck = { at: new Date().toISOString(), by, summary: result.summary };
    return result;
  } catch (err) {
    lastCheck = { at: new Date().toISOString(), by, error: err.message === 'AUTH_REQUIRED' ? 'mail login failed' : err.message };
    throw err;
  } finally {
    pollInProgress = false;
  }
}

// GET /gmail/emails — fetch new emails, auto-extract and save to Excel
router.get('/emails', async (req, res) => {
  try {
    const max   = parseInt(req.query.max) || 30;
    const query = req.query.q || 'in:inbox';
    const result = await checkMail({ max, query, by: 'button' });
    if (!result) return res.status(409).json({ error: 'BUSY', message: 'A mail check is already in progress — try again in a moment.' });
    res.json(result);
  } catch (err) {
    if (err.message === 'AUTH_REQUIRED') {
      return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Gmail token expired — please reconnect.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /gmail/last — the last check
router.get('/last', (req, res) => res.json(lastCheck || {}));

module.exports = router;
module.exports.checkMail = checkMail;
module.exports.cancelForWaybill = cancelForWaybill;
module.exports.isCancelledWaybill = isCancelledWaybill;
module.exports.isWithdrawal = isWithdrawal;
module.exports.cancelWithdrawn = cancelWithdrawn;
