require('dotenv').config();
const express       = require('express');
const path          = require('path');
const { openKipis, getPage, probeSession, sessionStatus } = require('./core/browser');
const kipisLoad     = require('../KIPIS_skills/PRK/kipisLoad');
const kipisTest     = require('./actions/kipisTest');
const gmailRoute    = require('./routes/gmailRoute');
const { markDone, isDone } = require('./core/doneTracker');
const { todayString } = require('./core/dateManager');
const { findCargoInText } = require('./core/cargoList');
const { refreshCargo, updateOrderFields } = require('./core/ordersExcel');
const { getEmailData }           = require('./core/emailCache');
const { fetchAttachmentBytes }   = require('./core/imapMail');
const orderStore = require('./core/orderStore');
const { confirmSender, blockSender, parseAddress } = require('./core/senders');
const senderCompanies = require('./core/senderCompanies');
const owners      = require('./core/owners');
const lotRegistry = require('./core/lotRegistry');
const { fetchStockRows } = require('./core/stockCache');
const { searchLots, isOurStorage } = require('../KIPIS_skills/PRK/navigateToCargo');
const { withAutomation, operatorActiveWithin } = require('../KIPIS_skills/safePage');
const prkWatch = require('../KIPIS_skills/PRK/prkWatch');
const prkPdf   = require('../KIPIS_skills/PRK/prkPdf');
const dispatchEmail = require('./core/dispatchEmail');
const smtpSend = require('./core/smtpSend');
const { DISPATCH_RECIPIENTS, DISPATCH_CC } = require('./core/terminals');
const { captureFormState } = require('../KIPIS_skills/PRK/checkPrk');
const prkDelete = require('../KIPIS_skills/PRK/prkDelete');

// Checked before an order is taken, so a closed KIPIS window never fails a good order.
function kipisOpen() {
  try { return !getPage().isClosed(); } catch { return false; }
}
const KIPIS_CLOSED = 'KIPIS is not open — press Open KIPIS (and enter the MFA code) first. No order was touched.';
const KIPIS_LOGIN  = 'KIPIS is logged out — press Open KIPIS and enter the MFA code. No order was touched.';

// Before every KIPIS job (ROADMAP A9): the window is open AND logged in. Returns the reason it is
// not, or null. A logged-out session stops the job once, before any order is taken.
async function kipisNotReady() {
  if (!kipisOpen()) return KIPIS_CLOSED;
  const { state } = await probeSession();
  if (state === 'login') return KIPIS_LOGIN;
  if (state === 'error') return 'KIPIS did not answer — check the network, then try again. No order was touched.';
  return null;
}

// Keep-alive: the same background request every 10 minutes while nothing else drives KIPIS —
// keeps the session from timing out between trucks, and keeps the dashboard's status current.
setInterval(() => {
  if (isRunning || !kipisOpen()) return;
  probeSession().catch(() => {});
}, 10 * 60 * 1000);

// A PRK someone already filed for this truck (seen on the lot in KIPIS): the order is handled.
function recordExistingPrk(order, plate, existingPrk) {
  markDone(plate);
  if (!order) return;
  const number = (existingPrk.match(/\d{6}-\d{6}-PRK/) || [null])[0];
  const status = (existingPrk.match(/\(([^)]+)\)/) || [null, 'exists'])[1];
  orderStore.attachDocument(order.id, { type: 'PRK', number, status });
  // A Ruošiamas PRK is still a draft — it waits for Pateikti like one this run saved (A11).
  const state = /ruošiamas/i.test(status) ? 'drafted' : 'done';
  orderStore.setState(order.id, state, { actor: 'kipis', detail: `PRK already in KIPIS: ${existingPrk} — not filed again` });
}

// A draft this run saved. It is not done: the operator still checks it and presses Pateikti
// (human-only), then terminal@bpa.lt's dispatch email closes the order (ROADMAP A11).
// markDone still blocks a second RUN PRK on the plate.
function recordSavedDraft(order, plate, result) {
  markDone(plate);
  if (!order) return;
  orderStore.attachDocument(order.id, { type: 'PRK', number: result.prkNumber, status: result.prkStatus || 'Ruošiamas' });
  orderStore.setLoadsFrom(order.id, result.loadsFrom);
  orderStore.setState(order.id, 'drafted', { actor: 'kipis', detail: `PRK draft saved (Saugoti): ${result.prkNumber} — waiting for Pateikti` });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// A12: once a RECHECK (GET /gmail/emails) has finished, file whatever it made ready.
app.use('/gmail/emails', (req, res, next) => {
  res.on('finish', () => { setTimeout(() => autoRound('after RECHECK').catch(err => console.error('Auto round:', err.message)), 1000); });
  next();
});
app.use('/gmail', gmailRoute);

let isRunning = false;

// KIPIS session for the dashboard: 'main' | 'login' | 'closed' | 'error', and since when.
// Re-probes when the last answer is over 2 minutes old and no job is running.
app.get('/kipis/status', async (req, res) => {
  const s = sessionStatus();
  if (!isRunning && (!s.at || Date.now() - Date.parse(s.at) > 2 * 60 * 1000)) {
    return res.json(await probeSession().catch(() => sessionStatus()));
  }
  res.json(s);
});

app.post('/open-kipis', async (req, res) => {
  console.log('Received request: open-kipis');
  try {
    await openKipis();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('open-kipis failed:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

app.post('/run-prk', async (req, res) => {
  const { value } = req.body;

  if (!value) {
    return res.json({ status: 'error', message: 'Missing plate value' });
  }

  if (isRunning) {
    return res.json({ status: 'error', message: 'Already running. Wait for current job to finish.' });
  }

  if (isDone(value)) {
    return res.json({ status: 'error', message: 'Plate already filed (marked done). Unmark it first to re-run.' });
  }

  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });

  console.log(`Received request: run-prk | ${value}`);
  isRunning = true;

  orderStore.syncFromExcel();
  const tracked = orderStore.activeOrderForPlate(value);
  if (tracked) orderStore.setState(tracked.id, 'filing', { actor: 'kipis', detail: 'run-prk started' });

  try {
    const result = await kipisLoad.run({ plate: value });
    if (result.submitted) {
      recordSavedDraft(tracked, value, result);
      console.log(`run-prk completed: PRK ${result.prkNumber} saved — waiting for Pateikti`);
    } else if (result.existingPrk) {
      recordExistingPrk(tracked, value, result.existingPrk);
    } else if (result.blocked) {
      if (tracked) orderStore.setState(tracked.id, 'failed', { actor: 'kipis', detail: `not saved — ${result.blocked}; form left open in KIPIS for review` });
      console.log(`run-prk stopped before Saugoti: ${result.blocked}`);
    } else {
      if (tracked) orderStore.setState(tracked.id, 'drafted', { actor: 'kipis', detail: 'form filled, not saved (dry run)' });
      console.log('run-prk completed: form filled (dry run) — review and submit in KIPIS, not marked done');
    }
    res.json({ status: 'ok', submitted: result.submitted, prkNumber: result.prkNumber || null, blocked: result.blocked || null, existingPrk: result.existingPrk || null, needsLotOwners: !!result.needsLotOwners, check: result.check || null, fieldCheck: result.fieldCheck || null });
  } catch (err) {
    console.error('run-prk failed:', err.message);
    if (tracked) orderStore.setState(tracked.id, 'failed', { actor: 'kipis', detail: err.message });
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Reads the KIPIS PRK list (read-only) and reports which drafts Rule 7 would allow deleting.
// Auto-escalates past KIPIS's own row cap so the read is never silently truncated.
app.post('/prk/export', async (req, res) => {
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  isRunning = true;
  try {
    const { readFullPrkList } = require('../KIPIS_skills/PRK/exportPrkList');
    const { findDeletable }   = require('../KIPIS_skills/PRK/prkLedger');
    const limit = req.body?.limit || 500;
    const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses : null;   // e.g. ["Ruošiamas"]

    const dateFrom = String(req.body?.dateFrom || ''), dateTo = String(req.body?.dateTo || '');   // submission date, YYYY-MM-DD
    const { docs, drafts, headers, headRowCount, rawRowCount, limitUsed } = await withAutomation(getPage(), () => readFullPrkList({ limit, statuses, dateFrom, dateTo }));

    orderStore.syncFromExcel();
    const checked = findDeletable(drafts, {
      ourEmployee: process.env.KIPIS_EMPLOYEE || '',
      today: todayString(),
      orders: orderStore.listOrders(),
    });

    res.json({
      status: 'ok', headers, headRowCount, rawRowCount, limitUsed,
      total: docs.length,
      docs: docs.map(d => ({ number: d.number, status: d.status, plate: d.plate, employee: d.employee, created: d.created })),
      drafts: drafts.map(d => ({ number: d.number, status: d.status, plate: d.plate, employee: d.employee, created: d.created })),
      deletable: checked.filter(d => d.deletable),
      blocked:   checked.filter(d => !d.deletable),
    });
  } catch (err) {
    console.error('prk/export failed:', err.message);
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

app.get('/pipeline', (req, res) => {
  try {
    orderStore.syncFromExcel();
    const { queue, done } = orderStore.queueAndDone();
    const shape = o => ({
      id:     o.id,
      plate:  o.plate,
      cargo:  o.cargo,
      weight: o.weight,
      grossWeight: o.grossWeight,
      bulk:   o.bulk,
      state:  o.state,
      docs:   o.docs,
      dispatchSent: o.dispatchSent || null,
      vessel: o.loadsFrom?.vessel || '',
      // The last thing that happened to the order — the dashboard shows it as the reason a truck
      // stopped (e.g. "not saved — lot choice — owner not confirmed …").
      note: (o.history || []).slice(-1)[0]?.detail || '',
      sender: o.email?.from || '',
      company: senderCompanies.deriveCompany(o.email?.from || ''),
      subject: o.email?.subject || '',
      messageId: o.email?.messageId || '',
      received: o.email?.received || '',
      updatedAt: o.updatedAt,
    });
    res.json({ queue: queue.map(shape), done: done.map(shape) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assigns a company label to a sender's email address for future display (used when the
// domain/display-name heuristic can't establish one, e.g. a personal Gmail account).
app.post('/sender-company', (req, res) => {
  const { sender, company } = req.body;
  if (!sender || !company) return res.status(400).json({ error: 'Missing sender or company' });
  senderCompanies.setCompany(sender, company);
  res.json({ status: 'ok' });
});

// Emails that look like loading orders but whose sender is not human-confirmed yet.
app.get('/confirmations', (req, res) => {
  try {
    orderStore.syncFromExcel();
    res.json({ pending: orderStore.pendingConfirmations() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// action: 'always' (trust sender from now on) | 'once' (this email only) | 'cancel_once'
// (ignore this email only, sender stays unconfirmed) | 'never' (block sender)
app.post('/confirmations/decide', async (req, res) => {
  const { action, messageId, sender } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  try {
    let affected = 0;
    if (action === 'always') {
      if (!sender) return res.status(400).json({ error: 'Missing sender' });
      await confirmSender(sender);
      affected = orderStore.applyToSender(parseAddress(sender), id => orderStore.approveOrder(id, 'sender confirmed'));
    } else if (action === 'once') {
      if (!messageId) return res.status(400).json({ error: 'Missing messageId' });
      affected = orderStore.applyToMessage(messageId, id => orderStore.approveOrder(id, 'confirmed once'));
    } else if (action === 'cancel_once') {
      if (!messageId) return res.status(400).json({ error: 'Missing messageId' });
      affected = orderStore.applyToMessage(messageId, id => orderStore.rejectOrder(id, 'cancelled once'));
    } else if (action === 'never') {
      if (!sender) return res.status(400).json({ error: 'Missing sender' });
      await blockSender(sender);
      affected = orderStore.applyToSender(parseAddress(sender), id => orderStore.rejectOrder(id, 'sender blocked'));
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    console.log(`Confirmation "${action}" → ${affected} order(s) updated`);
    res.json({ status: 'ok', action, affected });
  } catch (err) {
    console.error('confirmation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Takes the next ready NON-bulk order and files its PRK. One at a time, oldest first.
app.post('/queue/process-next', async (req, res) => {
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });

  orderStore.syncFromExcel();
  const next = orderStore.nextReadyNonBulk();
  if (!next) return res.json({ status: 'empty', message: 'No ready non-bulk orders in the queue.' });

  isRunning = true;
  try {
    const r = await fileOrder(next, 'queue worker');
    if (r.outcome === 'failed') return res.json({ status: 'error', order: next.id, plate: next.plate, message: r.message });
    res.json({ status: 'ok', order: next.id, plate: next.plate, submitted: r.outcome === 'saved', prkNumber: r.prkNumber || null, blocked: r.outcome === 'blocked' ? r.message : null, existingPrk: r.existingPrk || null, needsLotOwners: !!r.needsLotOwners });
  } finally {
    isRunning = false;
  }
});

// Files one order end to end and records the outcome on it. The caller holds isRunning.
// outcome: 'saved' (draft saved, waiting for Pateikti) | 'existing' (already filed in KIPIS) |
// 'blocked' (stopped before Saugoti, e.g. lot owners to confirm) | 'failed' (error) | 'dry'.
async function fileOrder(order, actor) {
  orderStore.setState(order.id, 'filing', { actor: 'kipis', detail: actor });
  console.log(`Queue: processing ${order.id} | ${order.plate}`);
  const base = { id: order.id, plate: order.plate, cargo: order.cargo };
  try {
    const result = await kipisLoad.run({ plate: order.plate });
    if (result.submitted) {
      recordSavedDraft(order, order.plate, result);
      return { ...base, outcome: 'saved', prkNumber: result.prkNumber };
    }
    if (result.existingPrk) {
      recordExistingPrk(order, order.plate, result.existingPrk);
      return { ...base, outcome: 'existing', existingPrk: result.existingPrk };
    }
    if (result.blocked) {
      orderStore.setState(order.id, 'failed', { actor: 'kipis', detail: `not saved — ${result.blocked}; form left open in KIPIS for review` });
      return { ...base, outcome: 'blocked', message: result.blocked, needsLotOwners: !!result.needsLotOwners };
    }
    orderStore.setState(order.id, 'drafted', { actor: 'kipis', detail: 'filled, not saved (dry run)' });
    return { ...base, outcome: 'dry' };
  } catch (err) {
    orderStore.setState(order.id, 'failed', { actor: 'kipis', detail: err.message });
    console.error(`Queue: ${order.id} failed —`, err.message);
    return { ...base, outcome: 'failed', message: err.message };
  }
}

// ── A8: file every ready order in one go ─────────────────────────────────────
// Oldest first, non-bulk (bulk needs a weight first). Continues past an order that fails or is
// blocked; stops the whole batch only when KIPIS itself is gone (logged out / closed), so one
// expired session never fails a row of good orders. Each order is tried once per batch.
async function fileAllReady(actor) {
  const summary = { saved: [], existing: [], blocked: [], failed: [], dry: [], stoppedBecause: null };
  orderStore.syncFromExcel();
  const tried = new Set();
  for (;;) {
    const next = orderStore.listOrders()
      .filter(o => o.state === 'ready' && !o.bulk && !tried.has(o.id))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
    if (!next) break;
    const notReady = await kipisNotReady();
    if (notReady) { summary.stoppedBecause = notReady; break; }
    tried.add(next.id);
    const r = await fileOrder(next, actor);
    summary[r.outcome].push(r);
  }
  const counts = Object.entries(summary).filter(([k, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${v.length} ${k}`).join(', ');
  console.log(`Batch (${actor}): ${counts || 'nothing to file'}${summary.stoppedBecause ? ` — stopped: ${summary.stoppedBecause}` : ''}`);
  return summary;
}

// ── A12: filing without a click ──────────────────────────────────────────────
// Mail intake stays manual (RECHECK, D1); filing runs by itself: right after each RECHECK, and
// every 15 minutes during the shift (08:00–18:00) for anything that became ready in between
// (e.g. a sender the operator confirmed). Skips quietly when there is nothing ready, when another
// KIPIS job is running (the next tick catches up) or when KIPIS is not logged in.
const AUTO_FILE_HOURS = [8, 18];
const OPERATOR_QUIET_MS = 3 * 60 * 1000;   // automatic jobs wait while the operator works in KIPIS
let lastAutoFile = null;
let lastWatch    = null;

// An automatic job may drive the KIPIS window only when nothing else does, KIPIS is logged in,
// and the operator has not clicked or typed in that window for a few minutes (it would pull the
// page away from a draft being checked). Returns the reason to skip, or null.
async function autoBlocked() {
  if (isRunning) return 'another KIPIS job is running';
  const notReady = await kipisNotReady();
  if (notReady) return notReady;
  if (await operatorActiveWithin(getPage(), OPERATOR_QUIET_MS)) return 'you are working in the KIPIS window — next round';
  return null;
}

async function autoFile(reason) {
  if (isRunning) return;
  orderStore.syncFromExcel();   // RECHECK writes new orders to today's Excel first
  const ready = orderStore.listOrders().some(o => o.state === 'ready' && !o.bulk);
  if (!ready) return;
  const blocked = await autoBlocked();
  if (blocked) {
    lastAutoFile = { at: new Date().toISOString(), reason, skipped: blocked };
    return;
  }
  isRunning = true;
  try {
    const s = await fileAllReady(`auto-filing (${reason})`);
    lastAutoFile = { at: new Date().toISOString(), reason, ...s };
  } catch (err) {
    lastAutoFile = { at: new Date().toISOString(), reason, error: err.message };
    console.error('Auto-filing failed:', err.message);
  } finally {
    isRunning = false;
  }
}

// A18: which of our drafts has the operator submitted? (`automatic` = respect autoBlocked)
async function runWatch(reason, automatic) {
  const waiting = orderStore.prkNumbersFiled({ maxAgeDays: 1 });
  if (![...waiting.values()].some(o => o.state === 'drafted' || o.state === 'submitted')) return lastWatch;
  const blocked = automatic ? await autoBlocked() : (isRunning ? 'another KIPIS job is running' : await kipisNotReady());
  if (blocked) return (lastWatch = { at: new Date().toISOString(), reason, skipped: blocked });
  isRunning = true;
  try {
    const page = getPage();
    lastWatch = { at: new Date().toISOString(), reason, ...(await withAutomation(page, () => prkWatch.checkSubmitted())) };
  } catch (err) {
    lastWatch = { at: new Date().toISOString(), reason, error: err.message };
    console.error('PRK watch failed:', err.message);
  } finally {
    isRunning = false;
  }
  return lastWatch;
}

// ── A19: the dispatch email, sent by the operator from the dashboard ─────────
// The office reads terminal@bpa.lt over POP3, which never shows server-side Drafts (operator,
// 2026-11-10), so the email is shown on the dashboard instead: a submitted order's *Email* button
// opens the preview (recipients from the routing table, subject, text, the PRK PDF); the operator
// may edit the subject/text and switch RoRo/KKT, then presses Send — the only way the code sends
// mail (SECURITY.md §5). The Cc copy to terminal@bpa.lt closes the order on the next RECHECK.
// The PDF is fetched from KIPIS into memory for the preview and dropped once sent (D10).
const dispatchPdfs = new Map();   // order id → { number, filename, buffer }
const DISPATCH_LOG = path.join(__dirname, '../data/dispatch_sent.jsonl');

function dispatchOrder(id, date) {
  const order = orderStore.getOrder(String(id || ''), date || undefined);
  if (!order) return { error: 'Order not found' };
  if (!order.docs?.PRK?.number) return { error: 'The order has no PRK number' };
  return { order };
}

app.get('/dispatch/preview', async (req, res) => {
  const { id, date } = req.query;
  const { order, error } = dispatchOrder(id, date);
  if (error) return res.status(404).json({ error });
  const number = order.docs.PRK.number;
  try {
    if (!dispatchPdfs.has(order.id) || dispatchPdfs.get(order.id).number !== number) {
      if (isRunning) return res.json({ status: 'error', message: 'Another KIPIS job is running — try again in a moment.' });
      const notReady = await kipisNotReady();
      if (notReady) return res.json({ status: 'error', message: notReady });
      isRunning = true;
      try {
        const page = getPage();
        const pdf = await withAutomation(page, () => prkPdf.fetchPrkPdf(page, number));
        dispatchPdfs.set(order.id, { number, filename: pdf.filename, buffer: pdf.buffer });
      } finally {
        isRunning = false;
      }
    }
    const { getBagKg } = require('../KIPIS_skills/PRK/navigateToCargo');
    const fileDate = date || todayString();
    const mail = dispatchEmail.composeDispatch(order, fileDate, getBagKg(order.cargo));
    let sentByHand = false;
    try { sentByHand = await dispatchEmail.alreadySent(order.plate); } catch { /* inbox unreachable: no warning */ }
    const pdf = dispatchPdfs.get(order.id);
    res.json({
      status: 'ok', id: order.id, date: fileDate, plate: order.plate, prk: number,
      terminal: mail.terminal, recipients: DISPATCH_RECIPIENTS, cc: DISPATCH_CC,
      subject: mail.subject, text: mail.text.replace(/\r\n/g, '\n'), missing: mail.missing,
      pdf: { filename: pdf.filename, bytes: pdf.buffer.length },
      sentByHand, sent: order.dispatchSent || null,
    });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// The previewed PDF, shown in the browser (not saved on the PC).
app.get('/dispatch/pdf', (req, res) => {
  const pdf = dispatchPdfs.get(String(req.query.id || ''));
  if (!pdf) return res.status(404).send('Open the email preview first.');
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
  res.send(pdf.buffer);
});

// The operator's Send. Recipients come only from the routing table (terminal: roro | kkt).
app.post('/dispatch/send', async (req, res) => {
  const { id, date, terminal, subject, text } = req.body || {};
  const { order, error } = dispatchOrder(id, date);
  if (error) return res.status(404).json({ error });
  if (order.dispatchSent) return res.json({ status: 'error', message: `Already sent by PortSystem at ${order.dispatchSent.at.slice(11, 16)} UTC.` });
  if (!DISPATCH_RECIPIENTS[terminal]) return res.status(400).json({ error: 'terminal must be roro or kkt' });
  if (!String(subject || '').trim() || !String(text || '').trim()) return res.status(400).json({ error: 'Subject and text are required' });
  const pdf = dispatchPdfs.get(order.id);
  if (!pdf || pdf.number !== order.docs.PRK.number) return res.json({ status: 'error', message: 'Open the email preview again — the PRK PDF is not loaded.' });

  const from = process.env.IMAP_USER;
  const to = DISPATCH_RECIPIENTS[terminal];
  const raw = dispatchEmail.buildMime({
    from, to, cc: DISPATCH_CC, subject: String(subject).trim(),
    text: String(text).replace(/\r?\n/g, '\r\n'), attachment: pdf,
  });
  try {
    const reply = await smtpSend.sendRaw(raw, { from, recipients: [...to, ...DISPATCH_CC] });
    const record = { at: new Date().toISOString(), terminal, to, prk: pdf.number, subject: String(subject).trim() };
    orderStore.setDispatchSent(order.id, record, { date: date || undefined });
    require('fs').appendFileSync(DISPATCH_LOG, JSON.stringify({ ...record, plate: order.plate, orderId: order.id, server: reply }) + '\n');
    dispatchPdfs.delete(order.id);
    console.log(`Dispatch email sent: ${order.plate} ${pdf.number} → ${to.join(', ')} (${reply})`);
    res.json({ status: 'ok', sentTo: to });
  } catch (err) {
    console.error(`Dispatch email for ${order.plate} failed:`, err.message);
    res.json({ status: 'error', message: `Not sent — ${err.message}` });
  }
});

// One automatic round: file what is ready, then see what the operator has submitted.
async function autoRound(reason) {
  await autoFile(reason);
  await runWatch(reason, true);
}

setInterval(() => {
  const h = new Date().getHours();
  if (h < AUTO_FILE_HOURS[0] || h >= AUTO_FILE_HOURS[1]) return;
  autoRound('shift timer').catch(err => console.error('Auto round:', err.message));
}, 15 * 60 * 1000);

app.get('/prk/watch', (req, res) => res.json(lastWatch || {}));
// Dashboard "Check submitted": the operator asks, so it runs even if they just used KIPIS.
app.post('/prk/watch', async (req, res) => res.json((await runWatch('dashboard button', false)) || {}));

app.get('/queue/auto', (req, res) => res.json(lastAutoFile || {}));

app.post('/queue/file-all', async (req, res) => {
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    res.json({ status: 'ok', ...(await fileAllReady('batch: File all ready')) });
  } catch (err) {
    console.error('Batch failed:', err.message);
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Sekimas → Kroviniai (unless already there), then the Pavadinimas filter. Read-only.
async function kipisSearch(q) {
  const page = getPage();
  return withAutomation(page, async () => {   // Pateikti guard armed while the machine drives
    if (!await page.locator('[id$=":fPavadinimas"]').isVisible()) {
      await page.getByText('Sekimas', { exact: true }).first().click();
      await page.waitForLoadState('networkidle');
      await page.locator('text="Kroviniai"').click();
      await page.waitForLoadState('networkidle');
    }
    return searchLots(page, q);
  });
}

// Read-only: every visible field on the KIPIS page as it is now (label, name, type, value) and
// the tab links — for seeing what a run stopped on without the operator describing the screen.
app.get('/kipis/fields', async (req, res) => {
  if (!kipisOpen()) return res.json({ status: 'error', message: KIPIS_CLOSED });
  try {
    const page = getPage();
    const { fields, buttons } = await captureFormState(page);
    const tabs = await page.locator('a[onclick]').evaluateAll(as => as
      .filter(a => a.offsetParent).map(a => ({ text: a.textContent.replace(/\s+/g, ' ').trim(), onclick: a.getAttribute('onclick') || '' })));
    // Validation and info messages (JSF renders them in red spans / message lists).
    const messages = await page.locator('[class*="rror"], [class*="essage"], [class*="arning"], font[color="red"], span[style*="red"]')
      .evaluateAll(els => [...new Set(els.filter(e => e.offsetParent).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean))]);
    res.json({ status: 'ok', url: page.url(), title: await page.title(), fields, buttons, tabs, messages });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// ── Daily cleanup of unused PRK drafts (RULES.md Rule 7) ─────────────────────
// Operator, 2026-11-10: a PRK is always for today or tomorrow, so PortSystem's Ruošiamas drafts
// for orders 2+ days old are deleted automatically — no button to forget. Once a day, the first
// time after 06:00 that KIPIS is open and nothing else is running; a failed or skipped attempt is
// retried the next hour. Every deletion goes to data/prk_deletions.jsonl; the last run is kept in
// data/prk_cleanup.json for the dashboard.
const CLEANUP_STATE_PATH = path.join(__dirname, '../data/prk_cleanup.json');
const CLEANUP_FROM_HOUR  = 6;

function cleanupState() {
  try { return JSON.parse(require('fs').readFileSync(CLEANUP_STATE_PATH, 'utf8')); } catch { return {}; }
}

async function runCleanup(by) {
  if (isRunning) return { status: 'busy', message: 'Another KIPIS job is running.' };
  const notReady = await kipisNotReady();
  if (notReady) return { status: 'error', message: notReady };
  isRunning = true;
  console.log(`PRK cleanup: starting (${by})`);
  const state = { at: new Date().toISOString(), by };
  try {
    const page = getPage();
    Object.assign(state, { status: 'ok' }, await withAutomation(page, () => prkDelete.sweepDrafts(page, by)));
    if (state.failed.length) state.status = 'stopped';
  } catch (err) {
    console.error('PRK cleanup failed:', err.message);
    Object.assign(state, { status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
  // A day counts as done only after a complete run; otherwise the next hour tries again.
  if (state.status === 'ok') state.doneFor = todayString();
  else if (cleanupState().doneFor === todayString()) state.doneFor = todayString();
  require('fs').writeFileSync(CLEANUP_STATE_PATH, JSON.stringify(state, null, 1));
  return state;
}

async function dailyCleanupTick() {
  if (new Date().getHours() < CLEANUP_FROM_HOUR) return;
  if (cleanupState().doneFor === todayString()) return;
  if (await autoBlocked()) return;   // busy, logged out, or the operator is working in KIPIS: next hour
  await runCleanup('daily cleanup');
}
setInterval(() => { dailyCleanupTick().catch(err => console.error('PRK cleanup tick:', err.message)); }, 60 * 60 * 1000);
setTimeout(() => { dailyCleanupTick().catch(err => console.error('PRK cleanup tick:', err.message)); }, 5 * 60 * 1000);

app.get('/prk/cleanup', (req, res) => {
  res.json({ ...cleanupState(), minAgeDays: prkDelete.CLEANUP_MIN_AGE_DAYS });
});

// Dashboard "run now": the same cleanup, same 2-day rule — for a day KIPIS was closed all morning.
app.post('/prk/cleanup', async (req, res) => {
  res.json(await runCleanup('dashboard: run now'));
});

// One of PortSystem's own Ruošiamas drafts, by number — same gates as the sweep (Rule 7).
app.post('/prk/delete', async (req, res) => {
  const n = String(req.body?.number || '').trim();
  if (!/^\d{6}-\d{6}-PRK$/.test(n)) return res.status(400).json({ error: 'number must be a PRK number' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  console.log(`Received request: prk/delete | ${n}`);
  try {
    const page = getPage();
    const r = await withAutomation(page, () => prkDelete.deleteOurDraft(page, n, null, 'operator request'));
    res.json({ status: 'ok', ...r });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Read-only check of A19's PDF step: fetches a submitted PRK's PDF in memory and reports it —
// nothing is saved (D10).
app.get('/prk/pdf-check', async (req, res) => {
  const n = String(req.query.n || '').trim();
  if (!/^\d{6}-\d{6}-PRK$/.test(n)) return res.status(400).json({ error: 'n must be a PRK number' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const page = getPage();
    const pdf = await withAutomation(page, () => prkPdf.fetchPrkPdf(page, n));
    res.json({ status: 'ok', filename: pdf.filename, bytes: pdf.buffer.length, prkStatus: pdf.status });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Read-only: opens a KIPIS document by number (universal search) and returns its header.
app.get('/prk/open', async (req, res) => {
  const n = String(req.query.n || '').trim();
  if (!/^\d{6}-\d{6}-PRK$/.test(n)) return res.status(400).json({ error: 'n must be a PRK number' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const page = getPage();
    // ?via=list opens it from the Ruošiamas list (the way deletion does), else universal search.
    // ?via=submitted: from the list filtered by submission date yesterday–today (a submitted PRK).
    const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const open = req.query.via === 'list' ? prkDelete.openFromDraftList
      : req.query.via === 'submitted' ? (p, num) => prkDelete.openFromList(p, num, { dateFrom: day(1), dateTo: day(0) }, 'the submitted PRKs of yesterday–today')
      : prkDelete.openDocument;
    const header = await withAutomation(page, () => open(page, n));
    const buttons = await page.locator('input[type="button"]:visible, input[type="submit"]:visible')
      .evaluateAll(bs => bs.map(b => ({ value: b.value, name: b.name })));
    res.json({ status: 'ok', title: await page.title(), header, buttons });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Read-only: the HTML around the first element matching ?sel= (up= ancestor levels, default 2),
// for mapping a KIPIS screen without the operator describing it.
app.get('/kipis/html', async (req, res) => {
  if (!kipisOpen()) return res.json({ status: 'error', message: KIPIS_CLOSED });
  try {
    const up = Math.min(Number(req.query.up) || 2, 8);
    const html = await getPage().locator(String(req.query.sel || 'body')).first()
      .evaluate((el, n) => { let e = el; for (let i = 0; i < n && e.parentElement; i++) e = e.parentElement; return e.outerHTML; }, up);
    res.json({ status: 'ok', html: html.slice(0, 20000) });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// Read-only look at KIPIS lots: Sekimas → Kroviniai, the Pavadinimas filter, the table rows.
// Only menu navigation and the filter button — never a form action. For checking why a run did
// not find a lot (e.g. a cargo named differently in KIPIS). ?q=keyword, &v=vessel substring.
app.get('/kipis/lots', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const v = String(req.query.v || '').trim().toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing q' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const { rows, lotCount, truncated } = await kipisSearch(q);
    const shown = rows
      .filter(r => !v || r.transport.toLowerCase().includes(v))
      .map(({ lot, name, transport, weightKg, lastDoc, dest }) => ({ lot, name, transport, weightKg, lastDoc, dest, ourStorage: isOurStorage(dest) }));
    res.json({ status: 'ok', q, lotCount, truncated, rows: shown });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// ── Lots & owners page (public/lots.html) ────────────────────────────────────
// Which owner each KIPIS lot belongs to, and which buyer / own cargo each ordering company loads
// (owners.js, lotRegistry.js). Everything here can be changed by hand at any time.
app.get('/lots/data', async (req, res) => {
  const cfg = owners.loadConfig();
  const warnings = [];
  let stock = [], releases = [];
  try { stock = await fetchStockRows(); } catch (err) { warnings.push(`Stock reports unreachable — no owner suggestions (${err.message})`); }
  try { releases = await owners.fetchReleases(); } catch (err) { warnings.push(`Release lists unreachable (${err.message})`); }

  const selfLoaders = Object.entries(cfg.companies).filter(([, c]) => c.selfLoader).map(([name]) => name);
  // Vessels in a stock or release list are the ones orders load from; lots on other vessels (old
  // leftovers a search turned up) are shown apart and do not count as needing the operator.
  const listed = new Set([...stock, ...releases].map(r => r.vessel.toLowerCase()));
  const byVessel = new Map();
  for (const l of lotRegistry.listLots()) {
    if (!byVessel.has(l.vessel)) byVessel.set(l.vessel, []);
    byVessel.get(l.vessel).push(l);
  }
  const vessels = [...byVessel.entries()].map(([vessel, lots]) => {
    const suggested = lotRegistry.suggestOwners(lots, stock, cfg.sellers, selfLoaders);
    const rows = lots
      .map(l => ({ ...l, suggested: suggested.get(l.lot) || '' }))
      .sort((a, b) => a.lot.localeCompare(b.lot));
    return {
      vessel,
      listed: listed.has(String(vessel).toLowerCase()),
      lots: rows,
      unconfirmed: rows.filter(l => !l.confirmedAt).length,
      seenAt: rows.reduce((m, l) => (l.seenAt > m ? l.seenAt : m), ''),
    };
  }).sort((a, b) => b.listed - a.listed || (b.unconfirmed > 0) - (a.unconfirmed > 0) || b.seenAt.localeCompare(a.seenAt));

  // Every company with a real order today, plus every company with a setting. Orders still
  // waiting for the sender's confirmation, and cancelled ones (blocked / rejected senders), do not
  // count: a container email from MSC (a logistics company, blocked) put MSC on this list as a
  // "company to set" (operator, 2026-11-10) — a mistakenly grabbed email must never land here.
  const REAL_ORDER_STATES = new Set(['ready', 'filing', 'drafted', 'submitted', 'verified', 'gate_pass_ordered', 'done', 'failed']);
  const companyNames = new Set(Object.keys(cfg.companies));
  for (const o of orderStore.listOrders()) {
    if (!REAL_ORDER_STATES.has(o.state)) continue;
    const c = senderCompanies.deriveCompany(o.email?.from || '');
    if (c) companyNames.add(c);
  }
  const companies = [...companyNames].sort().map(company => {
    const { buyer, auto } = owners.buyerFor(company, releases);
    return { company, buyer, auto, seller: owners.sellerFor(company), selfLoader: owners.isSelfLoader(company), receiverCountry: owners.receiverCountryFor(company) };
  });

  res.json({
    vessels,
    owners: [...cfg.sellers.map(s => s.name), ...selfLoaders],
    sellers: cfg.sellers.map(s => s.name),
    companies,
    buyers: [...new Set(releases.map(r => r.buyer))].sort(),
    releases,
    warnings,
    attention: {
      lots:      vessels.filter(v => v.listed).reduce((n, v) => n + v.unconfirmed, 0),
      companies: companies.filter(c => !c.buyer && !c.seller && !c.selfLoader).length,
    },
  });
});

// { lots: [{ lot, owner, priority }] } — confirms (or changes) owners and loading-order overrides.
app.post('/lots/confirm', (req, res) => {
  try {
    lotRegistry.confirmLots(Array.isArray(req.body?.lots) ? req.body.lots : []);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/lots/company', (req, res) => {
  try {
    const { company, buyer, seller, selfLoader, receiverCountry } = req.body || {};
    res.json({ status: 'ok', setting: owners.setCompany(company, { buyer, seller, selfLoader, receiverCountry }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/lots/remove', (req, res) => {
  const { lot } = req.body || {};
  if (!lot) return res.status(400).json({ error: 'Missing lot' });
  res.json({ status: lotRegistry.removeLot(lot) ? 'ok' : 'not_found' });
});

// Reads KIPIS for a cargo word and adds every lot in our storage to the registry — e.g. when a
// vessel is delivered, before its first order. Read-only in KIPIS.
app.post('/lots/scan', async (req, res) => {
  const q = String(req.body?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing cargo word' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const { rows, truncated } = await kipisSearch(q);
    if (truncated) return res.json({ status: 'error', message: `"${q}" matches over 500 lots in KIPIS — use a more specific word` });
    // "Laivas ULSAN 1078092, Maršalo s." → ULSAN (the IMO number ends the name)
    const vesselOf = t => ((String(t).match(/^Laivas\s+(.+?)\s+\d{7}\b/i) || [])[1] || '').trim();
    const loading  = lot => rows.filter(r => r.lot === lot && /autotransportas|vagonai/i.test(r.dest)).length;
    const seen = rows
      .filter(r => isOurStorage(r.dest) && vesselOf(r.transport))
      .map(r => ({ lot: r.lot, vessel: vesselOf(r.transport), name: r.name, weightKg: r.weightKg, trucksLoading: loading(r.lot) }));
    lotRegistry.recordSeen(seen);
    res.json({ status: 'ok', lots: new Set(seen.map(s => s.lot)).size, vessels: [...new Set(seen.map(s => s.vessel))] });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

// Manual override: operator marks an order done directly, bypassing PRK filing.
app.post('/order/mark-done', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const order = orderStore.getOrder(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  markDone(order.plate);
  orderStore.setState(id, 'done', { actor: 'operator', detail: 'marked done manually' });
  res.json({ status: 'ok' });
});

app.post('/refresh-cargo', (req, res) => {
  try {
    const updated = refreshCargo();
    console.log(`Cargo refresh: ${updated} row(s) updated`);
    res.json({ status: 'ok', updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/order-email', (req, res) => {
  const { plate } = req.query;
  if (!plate) return res.status(400).json({ error: 'Missing plate' });
  const data = getEmailData(plate);
  if (!data) return res.status(404).json({ error: 'No email data for this plate' });
  res.json(data);
});

const ATTACHMENT_CONTENT_TYPES = {
  pdf:  'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
};

app.get('/download-attachment', async (req, res) => {
  const { messageId, attachmentId, filename } = req.query;
  if (!messageId || !attachmentId) return res.status(400).json({ error: 'Missing params' });
  try {
    const buffer = await fetchAttachmentBytes(messageId, attachmentId);
    const safe = (filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext  = safe.split('.').pop().toLowerCase();
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.setHeader('Content-Type', ATTACHMENT_CONTENT_TYPES[ext] || 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/set-cargo', (req, res) => {
  const { plate, id, cargo, weight, bulk, grossWeight } = req.body;
  if (!plate) return res.status(400).json({ error: 'Missing plate' });
  if (cargo === undefined && weight === undefined && typeof bulk !== 'boolean' && grossWeight === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  try {
    let resolvedCargo, resolvedVessel = '';
    const fields = {};
    if (cargo !== undefined) {
      const match    = findCargoInText(cargo);
      resolvedCargo  = match ? match.cargo : cargo;
      resolvedVessel = match ? match.vessel : '';
      fields.cargo   = resolvedCargo;
    }
    if (weight !== undefined) fields.weight = weight;
    if (typeof bulk === 'boolean') fields.bulk = bulk;
    if (grossWeight !== undefined) fields.grossWeight = grossWeight;

    const updated = updateOrderFields(plate, fields);
    if (updated) {
      console.log(`Manual order edit: ${plate} →${resolvedCargo ? ' ' + resolvedCargo : ''}${weight !== undefined ? ' ' + weight + 'kg' : ''}${grossWeight !== undefined ? ' gross ' + grossWeight + 'kg' : ''}${bulk ? ' [BULK]' : ''}`);
      if (id) orderStore.updateOrderFields(id, fields);
    }
    res.json({ status: updated ? 'ok' : 'not_found', cargo: resolvedCargo, vessel: resolvedVessel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/run', async (req, res) => {
  const { action, value } = req.body;
  if (!action || !value) return res.json({ status: 'error', message: 'Missing action or value' });

  console.log(`Received request: ${action} | ${value}`);

  try {
    switch (action) {
      case 'kipisLoad': await kipisLoad.run({ plate: value }); break;
      case 'kipisTest': await kipisTest.run({ value }); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error(`Action "${action}" failed:`, err.message);
    res.json({ status: 'error', message: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Port Operations Panel running at http://localhost:${PORT}`);
  const os = require('os');
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) {
      console.log(`  also reachable on the LAN at: http://${iface.address}:${PORT}`);
    }
  }
});
