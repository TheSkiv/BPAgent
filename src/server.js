require('dotenv').config();
const express       = require('express');
const path          = require('path');
const { openKipis, getPage, probeSession, sessionStatus } = require('./core/browser');
const kipisLoad     = require('../KIPIS_skills/PRK/kipisLoad');
const gmailRoute    = require('./routes/gmailRoute');
const { markDone, isDone } = require('./core/doneTracker');
const { todayString } = require('./core/dateManager');
const { findCargoInText } = require('./core/cargoList');
const { refreshCargo, updateOrderFields } = require('./core/ordersExcel');
const { getEmailData, findByMessageId } = require('./core/emailCache');
const { fetchAttachmentBytes, fetchMessage } = require('./core/imapMail');
const orderStore = require('./core/orderStore');
const { confirmSender, blockSender, parseAddress } = require('./core/senders');
const senderCompanies = require('./core/senderCompanies');
const owners      = require('./core/owners');
const lotRegistry = require('./core/lotRegistry');
const { fetchStockRows } = require('./core/stockCache');
const { searchLots, isOurStorage } = require('../KIPIS_skills/PRK/navigateToCargo');
const { withAutomation, operatorActiveWithin, operatorPateiktiAt } = require('../KIPIS_skills/safePage');
const prkWatch = require('../KIPIS_skills/PRK/prkWatch');
const prkPdf   = require('../KIPIS_skills/PRK/prkPdf');
const dispatchEmail = require('./core/dispatchEmail');
const smtpSend = require('./core/smtpSend');
const { DISPATCH_RECIPIENTS, BULK_DISPATCH_RECIPIENTS, DISPATCH_CC } = require('./core/terminals');
const { captureFormState } = require('../KIPIS_skills/PRK/checkPrk');
const prkDelete = require('../KIPIS_skills/PRK/prkDelete');
const { amendDraft } = require('../KIPIS_skills/PRK/navigateToCargo');

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
  orderStore.setState(order.id, 'drafted', { actor: 'kipis', detail: `PRK draft saved (Saugoti): ${result.prkNumber} — waiting for Pateikti${result.packagingWarning ? ` — ${result.packagingWarning}` : ''}` });
}

// A13: one line per filing attempt, whatever its outcome, in data/prk_filings.jsonl — this is a
// customs workflow, and the order history alone is spread over daily files. Never throws.
const FILING_LOG = path.join(__dirname, '../data/prk_filings.jsonl');
function auditFiling({ order, plate, actor, outcome, result = {}, error = null, retried = false }) {
  const entry = {
    at: new Date().toISOString(), actor, outcome,
    orderId: order?.id || null, plate: plate || order?.plate || null, cargo: order?.cargo || null,
    prk: result.prkNumber || null, prkStatus: result.prkStatus || null,
    existingPrk: result.existingPrk || null,
    lot: result.loadsFrom?.lot || result.lot || null, owner: result.loadsFrom?.owner || null,
    fieldCheck: result.fieldCheck ? (result.fieldCheck.ok ? 'passed' : `failed: ${result.fieldCheck.issues.map(i => i.field).join(', ')}`) : null,
    aiCheck: result.check ? (result.check.ok === null ? `unavailable: ${result.check.summary}` : result.check.ok ? 'passed' : `failed: ${result.check.summary}`) : null,
    blocked: result.blocked || null, packagingWarning: result.packagingWarning || null,
    error: error ? String(error.message || error).split('\n')[0] : null, retried,
  };
  try { require('fs').appendFileSync(FILING_LOG, JSON.stringify(entry) + '\n'); }
  catch (err) { console.error('Filing log write failed:', err.message); }
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

// One login at a time: the button and the automatic opening share it (two at once would both
// type into the same login page).
let kipisOpening = null;
function openKipisOnce() {
  if (!kipisOpening) kipisOpening = openKipis().finally(() => { kipisOpening = null; });
  return kipisOpening;
}

app.post('/open-kipis', async (req, res) => {
  console.log('Received request: open-kipis');
  try {
    await openKipisOnce();
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
    const result = await kipisLoad.run({ plate: value, order: tracked });
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
    auditFiling({ order: tracked, plate: value, actor: 'RUN PRK', result,
      outcome: result.submitted ? 'saved' : result.existingPrk ? 'existing' : result.blocked ? 'blocked' : 'dry' });
    res.json({ status: 'ok', submitted: result.submitted, prkNumber: result.prkNumber || null, blocked: result.blocked || null, existingPrk: result.existingPrk || null, needsLotOwners: !!result.needsLotOwners, check: result.check || null, fieldCheck: result.fieldCheck || null });
  } catch (err) {
    console.error('run-prk failed:', err.message);
    auditFiling({ order: tracked, plate: value, actor: 'RUN PRK', outcome: 'failed', error: err });
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

// Done on the email side, but the PRK is submitted and the truck has not loaded yet.
const awaitingLoad = o => o.state === 'done' && !!o.docs?.PRK?.number && /^(pateiktas|patvirtintas)/i.test(o.docs.PRK.status || '');

app.get('/pipeline', (req, res) => {
  try {
    orderStore.syncFromExcel();
    const { queue, done } = orderStore.queueAndDone();
    // A PRK is for today or tomorrow: yesterday's trucks whose PRK still waits for Pateikti or
    // for its dispatch email stay on the desk until they are finished.
    const yesterday = orderStore.daysAgo(1);
    const carried = orderStore.listOrders(yesterday)
      .filter(o => (['drafted', 'submitted'].includes(o.state) && o.docs?.PRK?.number) || o.state === 'to_print' || awaitingLoad(o));
    // A truck whose PRK is submitted but not yet loaded stays on the desk (the desk matches KIPIS's
    // open PRKs), even when the email side already counts it done.
    for (let i = done.length - 1; i >= 0; i--) if (awaitingLoad(done[i])) queue.push(...done.splice(i, 1));
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
      printedAt: o.printedAt || null,
      loadedKg: o.loadedKg || null,
      awaitingLoad: awaitingLoad(o),
      fromKipis: o.email?.from === 'KIPIS',
      createdAt: o.createdAt || '',
      lastFailure: o.lastFailure || null,
      carried: orderStore.dateOf(o.id) === yesterday,
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
    res.json({ queue: [...queue, ...carried].map(shape), done: done.map(shape) });
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
// A10: a transient KIPIS hiccup (timeout, "Užklausa negalioja", a page re-render mid-step) gets
// one retry — but only if Saugoti was never pressed (a draft may exist; Rule 6) and KIPIS is
// still logged in. Each run starts from the KIPIS home page, which also clears the half-filled
// form and any open dialog the failed one left. Data problems (no lot, no weight, plate not in
// the orders) are not retried: they fail with the reason for the operator.
const TRANSIENT_ERROR = /timeout|timed out|net::ERR_|Užklausa negalioja|Execution context was destroyed|frame was detached|navigation .*interrupted/i;
function retryable(err) {
  return !err.saveClicked && TRANSIENT_ERROR.test(err.message || '');
}

async function fileOrder(order, actor) {
  const run = {};   // what the attempt saw, for the filing log (A13)
  const r = await fileOrderOnce(order, actor, run);
  auditFiling({ order, actor, outcome: r.outcome, result: run.result || {}, error: run.error || null, retried: !!run.retried });
  return r;
}

async function fileOrderOnce(order, actor, run) {
  orderStore.setState(order.id, 'filing', { actor: 'kipis', detail: actor });
  console.log(`Queue: processing ${order.id} | ${order.plate}`);
  const base = { id: order.id, plate: order.plate, cargo: order.cargo };
  try {
    let result;
    try {
      result = await kipisLoad.run({ plate: order.plate, order });
    } catch (err) {
      if (!retryable(err)) throw err;
      const notReady = await kipisNotReady();
      if (notReady) throw err;
      console.warn(`Queue: ${order.id} hit a transient error (${err.message.split('\n')[0]}) — retrying once from the KIPIS home page`);
      orderStore.setState(order.id, 'filing', { actor: 'kipis', detail: `retry after: ${err.message.split('\n')[0]}` });
      run.retried = true;
      result = await kipisLoad.run({ plate: order.plate, order });
    }
    run.result = result;
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
      orderStore.markFailure(order.id, 'data');
      return { ...base, outcome: 'blocked', message: result.blocked, needsLotOwners: !!result.needsLotOwners };
    }
    orderStore.setState(order.id, 'drafted', { actor: 'kipis', detail: 'filled, not saved (dry run)' });
    return { ...base, outcome: 'dry' };
  } catch (err) {
    run.error = err;
    orderStore.setState(order.id, 'failed', { actor: 'kipis', detail: err.message });
    orderStore.markFailure(order.id, err.saveClicked ? 'after-save' : TRANSIENT_ERROR.test(err.message || '') ? 'transient' : 'data');
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
  let listed = null;   // A5: the PRKs KIPIS already has for the last 2 days, read once per batch
  for (;;) {
    const next = orderStore.listOrders()
      .filter(o => orderStore.isFileable(o) && !tried.has(o.id))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
    if (!next) break;
    const notReady = await kipisNotReady();
    if (notReady) { summary.stoppedBecause = notReady; break; }
    tried.add(next.id);
    if (!listed) {
      try {
        const { recentPrks } = require('../KIPIS_skills/PRK/exportPrkList');
        listed = await withAutomation(getPage(), () => recentPrks(2));
      } catch (err) {
        // Without the list, the lot check (Rule 6) still runs on every order; say so and go on.
        console.warn(`Batch: could not read the KIPIS PRK list (${err.message}) — relying on the lot check`);
        listed = [];
      }
    }
    const hit = listedPrkFor(next, listed);
    if (hit) {
      console.log(`Batch: ${next.plate} already has ${hit.number} (${hit.status}) in KIPIS's PRK list — not filing another`);
      recordExistingPrk(next, next.plate, `${hit.number} (${hit.status})`);
      auditFiling({ order: next, actor, outcome: 'existing', result: { existingPrk: `${hit.number} (${hit.status}) — from the KIPIS PRK list` } });
      summary.existing.push({ id: next.id, plate: next.plate, cargo: next.cargo, outcome: 'existing', existingPrk: `${hit.number} (${hit.status})` });
      continue;
    }
    const r = await fileOrder(next, actor);
    summary[r.outcome].push(r);
  }
  const counts = Object.entries(summary).filter(([k, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${v.length} ${k}`).join(', ');
  console.log(`Batch (${actor}): ${counts || 'nothing to file'}${summary.stoppedBecause ? ` — stopped: ${summary.stoppedBecause}` : ''}`);
  return summary;
}

// A5: a PRK in KIPIS's list for this order's plate (the list's transport column may carry several
// trucks, so "contains"). A PRK already recorded on another order of the same plate is that
// trip's (a same-day second trip), not this one's.
// Rule 6 (operator, 2026-11-11): a PRK from an earlier day than the order that is already finished
// or annulled is the truck's earlier trip — it loaded and left, and this order is a new one
// (MOB272//PS118, ordered again at 10:04, was matched to yesterday's Užbaigtas PRK and closed
// without a PRK).
const PRK_OVER = /^(atliktas|u[žz]baigtas|anuliuotas)/i;
function listedPrkFor(order, listed) {
  const key = orderStore.normalizePlate(order.plate);
  if (!key) return null;
  const orderDay = orderStore.dateOf(order.id) || todayString();
  const otherTrips = new Set([...orderStore.listOrders(), ...orderStore.listOrders(orderStore.daysAgo(1))]
    .filter(o => o.id !== order.id && o.plateNorm === key && o.docs?.PRK?.number)
    .map(o => o.docs.PRK.number));
  return listed.find(d => d.plateNorm.includes(key) && !otherTrips.has(d.number)
    && !(d.created < orderDay && PRK_OVER.test(String(d.status || '').trim()))) || null;
}

// ── A12: filing without a click ──────────────────────────────────────────────
// Mail intake stays manual (RECHECK, D1); filing runs by itself: right after each RECHECK, and
// every minute during the shift (08:00–18:00, shiftTick) for anything that became ready in between
// (e.g. a sender the operator confirmed). Skips quietly when there is nothing ready, when another
// KIPIS job is running (the next tick catches up) or when KIPIS is not logged in.
const AUTO_FILE_HOURS = [8, 18];
const OPERATOR_QUIET_MS = 3 * 60 * 1000;   // automatic jobs wait while the operator works in KIPIS
let lastAutoFile = null;
let lastWatch    = null;

// An automatic job may drive the KIPIS window only when nothing else does, KIPIS is logged in,
// and the operator has not clicked or typed in that window for a few minutes (it would pull the
// page away from a draft being checked). Returns the reason to skip, or null.
async function autoBlocked(quietMs = OPERATOR_QUIET_MS) {
  if (isRunning) return 'another KIPIS job is running';
  const notReady = await kipisNotReady();
  if (notReady) return notReady;
  if (await operatorActiveWithin(getPage(), quietMs)) return 'you are working in the KIPIS window — next round';
  return null;
}

async function autoFile(reason) {
  if (isRunning) return;
  orderStore.syncFromExcel();   // RECHECK writes new orders to today's Excel first
  const ready = orderStore.listOrders().some(orderStore.isFileable);
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
async function runWatch(reason, automatic, quietMs) {
  const waiting = orderStore.prkNumbersFiled({ maxAgeDays: 1 });
  if (![...waiting.values()].some(o => o.state === 'drafted' || o.state === 'submitted')) return lastWatch;
  const blocked = automatic ? await autoBlocked(quietMs) : (isRunning ? 'another KIPIS job is running' : await kipisNotReady());
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

// ── The desk matches KIPIS (owner, 2026-11-11) ───────────────────────────────
// "If KIPIS has more PRKs, the dashboard should have the same number of trucks." Every 10 minutes
// in the shift (and on the dashboard's button) KIPIS's PRK list of the last 2 days is read
// (read-only) and the desk follows it:
//   - a PRK on one of our trucks: its status is kept current; loaded (Atliktas/Užbaigtas) → done;
//   - an open truck loaded on a PRK a person made (MTE728 on 261111-000640, 2026-11-11) → done;
//     a person's open PRK for an open truck of ours without one → recorded on it;
//   - a PRK for a truck PortSystem has no email for is left alone — no truck is made from it
//     (owner, 2026-11-12: "we don't pull PRKs from KIPIS if we don't have a matching email").
// Only road transport counts — internal moves into a storage place are not trucks.
const KIPIS_SYNC_EVERY_MS = 10 * 60 * 1000;
let lastKipisSync = null;
let lastKipisSyncRun = 0;   // the first shift tick after a start syncs, so stale PRK statuses never linger
const { applyKipisList } = require('./core/kipisSync');

async function syncWithKipis(reason, automatic) {
  const blocked = automatic ? await autoBlocked() : (isRunning ? 'another KIPIS job is running' : await kipisNotReady());
  if (blocked) return (lastKipisSync = { at: new Date().toISOString(), reason, skipped: blocked });
  isRunning = true;
  try {
    const { recentPrks } = require('../KIPIS_skills/PRK/exportPrkList');
    const listed = await withAutomation(getPage(), () => recentPrks(2));
    const changed = applyKipisList(listed, { recordExistingPrk });
    if (changed.length) console.log(`KIPIS sync (${reason}): ${changed.join('; ')}`);
    lastKipisSync = { at: new Date().toISOString(), reason, read: listed.length, changed };
  } catch (err) {
    lastKipisSync = { at: new Date().toISOString(), reason, error: err.message };
    console.error('KIPIS sync failed:', err.message);
  } finally {
    isRunning = false;
    lastKipisSyncRun = Date.now();
  }
  return lastKipisSync;
}
app.get('/kipis/sync', (req, res) => res.json(lastKipisSync || {}));
app.post('/kipis/sync', async (req, res) => res.json(await syncWithKipis('dashboard button', false)));

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
  if (!order.bulk && !order.docs?.PRK?.number) return { error: 'The order has no PRK number' };
  return { order };
}

// Bulk trucks are ordered by email before any PRK (the PRK follows the loaded weight): the
// vessel comes from the order's release or seller, as for filing.
async function bulkVessel(order) {
  const company = senderCompanies.deriveCompany(order.email?.from || '');
  const src = await owners.resolveOrder({ company, cargo: order.cargo, grossKg: Number(order.weight) || 24000 }, lotRegistry.ownLotsOf, orderStore.pendingReleaseKg);
  return { company, vessel: src.stop ? '' : (src.vessels || [])[0] || '', vessels: src.vessels || [], why: src.stop || '' };
}

// The order's submitted PRK as a PDF, for the print pack: from memory (fetched for the dispatch
// email) or from KIPIS (read-only, "Spausdinti"). { buffer } or { why } when it cannot be had now.
async function prkPdfFor(order) {
  const number = order.docs?.PRK?.number;
  if (!number) return { why: 'no PRK yet' };
  const cached = dispatchPdfs.get(order.id);
  if (cached && cached.number === number) return { buffer: cached.buffer };
  if (isRunning) return { why: 'KIPIS is busy with another job' };
  const notReady = await kipisNotReady();
  if (notReady) return { why: 'KIPIS is not open or logged out' };
  isRunning = true;
  try {
    const page = getPage();
    const pdf = await withAutomation(page, () => prkPdf.fetchPrkPdf(page, number));
    dispatchPdfs.set(order.id, { number, filename: pdf.filename, buffer: pdf.buffer });
    return { buffer: pdf.buffer };
  } catch (err) {
    return { why: `the PRK ${number} is not submitted yet (${err.message})` };
  } finally {
    isRunning = false;
  }
}

// The transport document for the print pack: the truck's CMR, or — without one — the
// važtaraščiai that came with the order email, the release added where it is missing.
// { buffers: [Buffer], label } ; label '' when there is none.
async function transportDocsFor(order, cmrPdf) {
  if (cmrPdf) return { buffers: [cmrPdf], label: 'CMR' };
  const email = (await orderEmail(order)) || {};
  const pdfs = (email.attachments || []).filter(a => /\.pdf$/i.test(a.filename || a.attachmentId || ''));
  if (!pdfs.length) return { buffers: [], label: '' };
  const { releases } = await releaseStamp.releasesFor(order).catch(() => ({ releases: [] }));
  const buffers = [];
  let unstamped = 0;
  for (const a of pdfs) {
    try {
      const r = await releaseStamp.prepareWaybill(await fetchAttachmentBytes(email.messageId, a.attachmentId), releases, null);
      if (!r.found && !r.stamped && releases.length) unstamped++;
      buffers.push(r.buffer);
    } catch { /* an unreadable attachment is left out; the note counts what is in */ }
  }
  return { buffers, label: `važtaraštis${buffers.length > 1 ? ` (${buffers.length})` : ''}${unstamped ? ' — release not added, pick it in the truck window' : ''}` };
}

// CMR or važtaraštis × (Ro-Ro 5 / KKT 1), then PRK × (1, bulk 2), as one PDF. X-Pack-Note says
// what is in it.
async function sendPack(res, order, cmrPdf, terminal) {
  const copies = cmr.copiesOf({ terminal, bulk: order.bulk });
  const docs = await transportDocsFor(order, cmrPdf);
  const prk = await prkPdfFor(order);
  if (!docs.buffers.length && !prk.buffer) return res.status(404).type('text/plain').send(`Nothing to print yet for ${order.plate}: no CMR or važtaraštis, and no PRK (${prk.why}).`);
  const pack = await cmr.printPack([...docs.buffers.map(b => ({ buffer: b, copies: copies.cmr })), { buffer: prk.buffer, copies: copies.prk }]);
  const note = [docs.buffers.length ? `${docs.label} × ${copies.cmr}` : 'no CMR or važtaraštis', prk.buffer ? `PRK × ${copies.prk}` : `no PRK (${prk.why})`].join(', ');
  res.setHeader('X-Pack-Note', encodeURIComponent(note));
  res.setHeader('Content-Disposition', `inline; filename="${order.plate.replace(/[^\w-]/g, '_')}.pdf"`);
  res.type('application/pdf').send(pack);
}

app.get('/dispatch/preview', async (req, res) => {
  const { id, date } = req.query;
  // quick=1 returns the text at once, without the KIPIS PDF fetch and the inbox check (seconds),
  // so the dialog never sits empty; the dashboard then asks again for the rest.
  const quick = req.query.quick === '1';
  const { order, error } = dispatchOrder(id, date);
  if (error) return res.status(404).json({ error });
  if (order.bulk) {
    try {
      const fileDate = date || orderStore.dateOf(order.id) || todayString();
      const v = await bulkVessel(order);
      const mail = dispatchEmail.composeBulkDispatch(order, fileDate, v);
      if (v.vessels.length > 1) mail.missing.push(`check the vessel (${v.vessels.join(', ')})`);
      if (v.why) mail.missing.push(`vessel not found — ${v.why}`);
      let sentByHand = false;
      if (!quick) try { sentByHand = await dispatchEmail.alreadySent(order.plate); } catch { /* inbox unreachable: no warning */ }
      return res.json({
        status: 'ok', bulk: true, id: order.id, date: fileDate, plate: order.plate, prk: null,
        terminal: mail.terminal, recipients: BULK_DISPATCH_RECIPIENTS, cc: DISPATCH_CC,
        subject: mail.subject, text: mail.text.replace(/\r\n/g, '\n'), missing: mail.missing,
        pdf: null, sentByHand, sent: order.dispatchSent || null, signature: dispatchEmail.signatureHtml('/bpa-logo.png'),
        cmr: cmr.forOrder(order.id)[0]?.number || null,
      });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  const number = order.docs.PRK.number;
  try {
    if (!quick && (!dispatchPdfs.has(order.id) || dispatchPdfs.get(order.id).number !== number)) {
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
    const fileDate = date || orderStore.dateOf(order.id) || todayString();
    const mail = dispatchEmail.composeDispatch(order, fileDate, getBagKg(order.cargo));
    let sentByHand = false;
    if (!quick) try { sentByHand = await dispatchEmail.alreadySent(order.plate); } catch { /* inbox unreachable: no warning */ }
    const cached = dispatchPdfs.get(order.id);
    const pdf = cached && cached.number === number ? cached : null;
    res.json({
      status: 'ok', quick, id: order.id, date: fileDate, plate: order.plate, prk: number,
      terminal: mail.terminal, recipients: DISPATCH_RECIPIENTS, cc: DISPATCH_CC,
      subject: mail.subject, text: mail.text.replace(/\r\n/g, '\n'), missing: mail.missing,
      pdf: pdf && { filename: pdf.filename, bytes: pdf.buffer.length },
      sentByHand, sent: order.dispatchSent || null, signature: dispatchEmail.signatureHtml('/bpa-logo.png'),
      cmr: cmr.forOrder(order.id)[0]?.number || null,
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
  const table = order.bulk ? BULK_DISPATCH_RECIPIENTS : DISPATCH_RECIPIENTS;
  if (!table[terminal]) return res.status(400).json({ error: 'terminal must be roro or kkt' });
  if (!String(subject || '').trim() || !String(text || '').trim()) return res.status(400).json({ error: 'Subject and text are required' });
  // Bagged: the PRK PDF loaded by the preview. Bulk: no attachment — the PRK comes after loading.
  const pdf = order.bulk ? null : dispatchPdfs.get(order.id);
  if (!order.bulk && (!pdf || pdf.number !== order.docs.PRK.number)) return res.json({ status: 'error', message: 'Open the email preview again — the PRK PDF is not loaded.' });

  // KKT gets the truck's CMR too (owner, 2026-11-11); Ro-Ro never — its 5 copies go on paper.
  const lastCmr = terminal === 'kkt' ? cmr.forOrder(order.id)[0] : null;
  const cmrFile = lastCmr ? { filename: `CMR ${lastCmr.number.replace(/[^\w-]/g, '_')}.pdf`, buffer: await cmr.reprint(lastCmr.number) } : null;

  const from = process.env.IMAP_USER;
  const to = table[terminal];
  const raw = dispatchEmail.buildMime({
    from, to, cc: DISPATCH_CC, subject: String(subject).trim(),
    ...dispatchEmail.withSignature(text), attachments: [pdf, cmrFile],
  });
  try {
    const reply = await smtpSend.sendRaw(raw, { from, recipients: [...to, ...DISPATCH_CC] });
    const record = { at: new Date().toISOString(), terminal, to, prk: pdf ? pdf.number : null, cmr: lastCmr ? lastCmr.number : null, bulk: !!order.bulk, subject: String(subject).trim() };
    orderStore.setDispatchSent(order.id, record, { date: date || undefined });
    // A bulk truck is now ordered: the terminal loads it and reports the weight for the PRK.
    if (order.bulk && !orderStore.CLOSED_STATES.includes(order.state)) {
      orderStore.setState(order.id, 'gate_pass_ordered', { actor: 'operator', detail: 'loading ordered by email from the dashboard — PRK after the weight', date: date || undefined });
    }
    require('fs').appendFileSync(DISPATCH_LOG, JSON.stringify({ ...record, plate: order.plate, orderId: order.id, server: reply }) + '\n');
    dispatchPdfs.delete(order.id);
    console.log(`Dispatch email sent: ${order.plate} ${pdf ? pdf.number : '(bulk loading order)'} → ${to.join(', ')} (${reply})`);
    res.json({ status: 'ok', sentTo: to });
  } catch (err) {
    console.error(`Dispatch email for ${order.plate} failed:`, err.message);
    res.json({ status: 'error', message: `Not sent — ${err.message}` });
  }
});

// A10: a truck that stopped on a KIPIS hiccup (never after Saugoti) goes back in line by itself,
// 10+ minutes later, at most twice — then it stays for the operator.
const RETRY_AFTER_MS = 10 * 60 * 1000;
function retryStopped() {
  for (const o of orderStore.listOrders()) {
    if (o.state !== 'failed' || o.bulk || o.lastFailure?.kind !== 'transient') continue;
    if (Date.now() - new Date(o.lastFailure.at).getTime() < RETRY_AFTER_MS) continue;
    const n = o.lastFailure.autoRetries + 1;
    if (orderStore.requeue(o.id, { actor: 'system', detail: `automatic retry ${n} of ${orderStore.AUTO_RETRY_LIMIT}`, auto: true })) {
      console.log(`Auto retry: ${o.plate} back in line (${n} of ${orderStore.AUTO_RETRY_LIMIT})`);
    }
  }
}

// One automatic round: file what is ready, then see what the operator has submitted.
async function autoRound(reason) {
  retryStopped();
  await autoFile(reason);
  await runWatch(reason, true);
}

const inShift = () => { const h = new Date().getHours(); return h >= AUTO_FILE_HOURS[0] && h < AUTO_FILE_HOURS[1]; };

// S8: once Pateikti is seen, the dispatch email is made ready — the PRK PDF is fetched from KIPIS
// into memory (never to disk, D10), so the operator's Send email opens at once and does not wait
// for the KIPIS window. Sending stays the operator's click (D11). A few per tick; a PDF that
// could not be fetched is tried again next tick, and the preview still fetches on demand.
async function prepareDispatches() {
  const waiting = [...orderStore.listOrders(), ...orderStore.listOrders(orderStore.daysAgo(1))]
    .filter(o => o.state === 'submitted' && !o.bulk && !o.dispatchSent && o.docs?.PRK?.number
      && dispatchPdfs.get(o.id)?.number !== o.docs.PRK.number)
    .slice(0, 3);
  if (!waiting.length || await autoBlocked(AFTER_PATEIKTI_QUIET_MS)) return;   // the operator has just pressed Pateikti: a short wait is enough
  isRunning = true;
  try {
    const page = getPage();
    for (const o of waiting) {
      const number = o.docs.PRK.number;
      const pdf = await withAutomation(page, () => prkPdf.fetchPrkPdf(page, number));
      dispatchPdfs.set(o.id, { number, filename: pdf.filename, buffer: pdf.buffer });
      console.log(`Dispatch email ready: ${o.plate} ${number} (PDF in memory, waiting for Send)`);
    }
  } catch (err) {
    console.error('Preparing a dispatch email failed:', err.message);
  } finally {
    isRunning = false;
  }
}

// The shift tick, once a minute 08:00–18:00. It used to be a round every 15 minutes: after a KIPIS
// login, or while the operator was using the KIPIS window, a ready truck waited up to 15 minutes
// (seen 2026-11-11). Now:
//   - KIPIS closed or logged out → open it and type the login, so only the MFA code is left for
//     a person (KIPIS_AUTO_OPEN=false in .env turns this off);
//   - something ready → file it (a no-op when nothing is ready or KIPIS is busy);
//   - drafts waiting for Pateikti → read the PRK list at most every WATCH_EVERY_MS.
const KIPIS_AUTO_OPEN = process.env.KIPIS_AUTO_OPEN !== 'false';
const WATCH_EVERY_MS  = 5 * 60 * 1000;
const AFTER_PATEIKTI_QUIET_MS = 30 * 1000;
let ticking = false, lastWatchRun = 0, pateiktiSeen = 0;
async function shiftTick() {
  if (!inShift() || ticking) return;
  ticking = true;
  try {
    if (KIPIS_AUTO_OPEN && !kipisOpening && !isRunning && (!kipisOpen() || sessionStatus().state === 'login')) {
      console.log('KIPIS is not logged in — opening the login; waiting for the MFA code');
      openKipisOnce().catch(err => console.error('Automatic KIPIS login:', err.message));
      return;
    }
    retryStopped();
    await autoFile('shift timer');
    // The operator pressed Pateikti in the KIPIS window since the last read: look now, once the
    // window has been still for AFTER_PATEIKTI_QUIET_MS, so Send email shows within a minute or
    // two instead of after the next 5-minute read.
    const pateiktiAt = kipisOpen() ? await operatorPateiktiAt(getPage()) : 0;
    const justSubmitted = pateiktiAt > pateiktiSeen;
    if (justSubmitted || Date.now() - lastWatchRun >= WATCH_EVERY_MS) {
      const w = await runWatch(justSubmitted ? 'after your Pateikti' : 'shift timer', true, justSubmitted ? AFTER_PATEIKTI_QUIET_MS : undefined);
      if (w && !w.skipped) { lastWatchRun = Date.now(); pateiktiSeen = pateiktiAt; }
    }
    if (Date.now() - lastKipisSyncRun >= KIPIS_SYNC_EVERY_MS) await syncWithKipis('shift timer', true);
    await prepareDispatches();
  } catch (err) {
    console.error('Shift tick:', err.message);
  } finally {
    ticking = false;
  }
}
setInterval(shiftTick, 60 * 1000);
setTimeout(shiftTick, 10 * 1000);   // and right after start

// Mail is checked by the server itself (operator, 2026-11-10 — reverses D1): every
// MAIL_CHECK_MINUTES (default 5; 0 turns it off), round the clock, because a check reads today's
// mail only and an order that arrived after the day's last check was never read. Only emails not
// seen before go to the AI extraction. New trucks are filed straight away during the shift;
// outside it they wait for the 08:00 round.
const MAIL_CHECK_MINUTES = process.env.MAIL_CHECK_MINUTES === undefined ? 5 : (parseFloat(process.env.MAIL_CHECK_MINUTES) || 0);
async function mailTick() {
  try {
    const r = await gmailRoute.checkMail({ by: 'timer' });
    if (!r) return;   // the operator's own check is running
    const s = r.summary;
    if (s.total) console.log(`Mail timer: ${s.total} new email(s), ${s.saved} truck(s) saved`);
    if (inShift() && (s.saved || s.prkMarked)) await autoRound('mail timer');
  } catch (err) {
    console.error('Mail timer:', err.message);
  }
}
if (MAIL_CHECK_MINUTES > 0) {
  setInterval(mailTick, MAIL_CHECK_MINUTES * 60 * 1000);
  setTimeout(mailTick, 20 * 1000);   // and once shortly after start
}
app.get('/mail/auto', (req, res) => res.json({ minutes: MAIL_CHECK_MINUTES }));

// Read-only (A5): the PRKs KIPIS has for the last 2 days, and which of today's orders each would
// stop from being filed again. Clears the list filters afterwards.
app.get('/prk/recent', async (req, res) => {
  if (isRunning) return res.json({ status: 'error', message: 'Already running. Wait for the current job.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const { recentPrks } = require('../KIPIS_skills/PRK/exportPrkList');
    const listed = await withAutomation(getPage(), () => recentPrks(2));
    const orders = orderStore.listOrders().filter(o => !['cancelled', 'rejected'].includes(o.state))
      .map(o => ({ id: o.id, plate: o.plate, state: o.state, own: o.docs?.PRK?.number || null, listed: listedPrkFor(o, listed)?.number || null }));
    res.json({ status: 'ok', count: listed.length, orders, listed });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
});

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

// opts.minAgeDays: 2 for the daily run (default); 0 for the operator's Run now (today's too).
async function runCleanup(by, opts = {}) {
  if (isRunning) return { status: 'busy', message: 'Another KIPIS job is running.' };
  const notReady = await kipisNotReady();
  if (notReady) return { status: 'error', message: notReady };
  isRunning = true;
  console.log(`PRK cleanup: starting (${by})`);
  const state = { at: new Date().toISOString(), by };
  try {
    const page = getPage();
    Object.assign(state, { status: 'ok' }, await withAutomation(page, () => prkDelete.sweepDrafts(page, by, opts)));
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
  // The operator's Run now also takes today's unused drafts (operator, 2026-11-10).
  res.json(await runCleanup('dashboard: run now', { minAgeDays: 0 }));
});

// "Delete finished": PortSystem's drafts for trucks already finished on another PRK and emailed
// (RULES.md Rule 7, operator 2026-11-11). GET lists them from the order files (no KIPIS read; the
// recorded status may be stale, the run checks KIPIS); POST deletes them.
app.get('/prk/finished', (req, res) => {
  const list = [...prkDelete.finishedDrafts()]
    .filter(([, o]) => o.kipisStatus === prkDelete.DRAFT_STATUS)
    .map(([number, o]) => ({ number, plate: o.plate, orderId: o.orderId }));
  res.json({ drafts: list });
});

app.post('/prk/cleanup-finished', async (req, res) => {
  if (isRunning) return res.json({ status: 'busy', message: 'Another KIPIS job is running.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const page = getPage();
    const r = await withAutomation(page, () => prkDelete.sweepFinished(page, 'dashboard: delete finished'));
    res.json({ status: r.failed.length ? 'stopped' : 'ok', ...r });
  } catch (err) {
    console.error('PRK cleanup (finished trucks) failed:', err.message);
    res.json({ status: 'error', message: err.message });
  } finally {
    isRunning = false;
  }
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

// Brings our Ruošiamas drafts filed before the run did it up to what Pateikti needs: Siuntėjas
// valstybė = Lietuva, and (bagged) the cargo line's "43, Krepšys". Drafts only (Rule 8): each
// opened from the Ruošiamas list. { prk } = one draft; {} = every drafted order of ours today.
app.post('/prk/amend', async (req, res) => {
  const one = String(req.body?.prk || '').trim();
  const filed = orderStore.prkNumbersFiled({ maxAgeDays: 1 });
  const targets = [...filed.entries()].filter(([n, o]) => one ? n === one : o.state === 'drafted');
  if (one && !targets.length) return res.json({ status: 'error', message: `${one} was not filed by PortSystem` });
  if (isRunning) return res.json({ status: 'error', message: 'Already running.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  const results = [];
  try {
    const page = getPage();
    for (const [n, o] of targets) {
      const order = orderStore.getOrder(o.orderId, o.date);
      try {
        const done = await withAutomation(page, async () => {
          const header = await prkDelete.openFromDraftList(page, n);
          if (!header || header.number !== n) throw new Error(`did not open from the Ruošiamas list`);
          const lot = order?.loadsFrom?.lot || (await page.locator('a', { hasText: /^\s*\d{6}-\d{6}-L\s*$/ }).first().textContent()).trim();
          return amendDraft(page, { lot, bagged: !order?.bulk });
        });
        console.log(`Draft ${n} (${o.plate}): ${done.length ? done.join(' + ') + ' set' : 'already complete'}`);
        results.push({ prk: n, plate: o.plate, set: done });
      } catch (err) {
        console.error(`Draft ${n} (${o.plate}) not amended: ${err.message}`);
        results.push({ prk: n, plate: o.plate, error: err.message });
      }
    }
    res.json({ status: 'ok', results });
  } finally {
    isRunning = false;
  }
});

// Read-only mapping aid: opens one of our drafts from the Ruošiamas list, clicks its Siuntos
// numeris link (e.g. 260924-001330-L) and reports what opens — fields, select options, buttons.
// Nothing is filled or saved.
app.post('/kipis/explore-lot', async (req, res) => {
  const n = String(req.body?.prk || '').trim();
  if (!/^\d{6}-\d{6}-PRK$/.test(n)) return res.status(400).json({ error: 'prk must be a PRK number' });
  if (isRunning) return res.json({ status: 'error', message: 'Already running.' });
  const notReady = await kipisNotReady();
  if (notReady) return res.json({ status: 'error', message: notReady });
  isRunning = true;
  try {
    const page = getPage();
    const out = await withAutomation(page, async () => {
      await prkDelete.openFromDraftList(page, n);
      const link = page.locator('a', { hasText: /^\s*\d{6}-\d{6}-L\s*$/ }).first();
      const lotText = (await link.textContent()).trim();
      const popupP = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await link.click();
      const popup = await popupP;
      const target = popup || page;
      await target.waitForLoadState('networkidle').catch(() => {});
      await target.waitForTimeout(1500);
      // ?tryBag: pick "43, Krepšys" and press this page's Saugoti, then report where it lands
      // (the PRK's own Saugoti is NOT pressed — nothing is kept unless it is).
      if (req.body?.tryBag) {
        const sel = target.locator('[id$=":kr_informacija:pakuotesRusis"]');
        const v = await sel.evaluate(s => { const o = [...s.options].find(x => /^43\s*,\s*krep/i.test(x.textContent.trim())); return o ? o.value : null; });
        await sel.selectOption(v);
        await target.waitForLoadState('networkidle');
        await target.locator('input[type="submit"][value="Saugoti"]:visible').click();
        await target.waitForLoadState('networkidle');
        await target.waitForTimeout(1500);
        const msgs = await target.locator('[class*="rror"], [class*="essage"], font[color="red"], span[style*="red"]')
          .evaluateAll(els => [...new Set(els.filter(e => e.offsetParent).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean))]);
        const header = await prkDelete.readDocHeader(target);
        const stillCargo = await sel.isVisible().catch(() => false);
        return { lot: lotText, afterSave: { title: await target.title(), header, messages: msgs, stillOnCargoLine: stillCargo, packagingNow: stillCargo ? await sel.evaluate(s => s.selectedOptions[0]?.textContent.trim()) : null,
          buttons: (await captureFormState(target)).buttons } };
      }
      const { fields, buttons } = await captureFormState(target);
      const selects = await target.locator('select').evaluateAll(ss => ss.filter(s => s.offsetParent).map(s => ({
        name: s.name, selected: (s.selectedOptions[0]?.textContent || '').trim(),
        options: [...s.options].slice(0, 80).map(o => `${o.value}=${o.textContent.trim()}`),
      })));
      const text = (await target.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 3000);
      return { lot: lotText, newWindow: !!popup, url: target.url(), title: await target.title(), fields, buttons, selects, text };
    });
    res.json({ status: 'ok', ...out });
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
  const REAL_ORDER_STATES = new Set(['ready', 'filing', 'drafted', 'submitted', 'verified', 'gate_pass_ordered', 'to_print', 'done', 'failed']);
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
    stockVessels: [...new Set(stock.map(r => r.vessel).filter(Boolean))].sort(),
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

// Our own release book (releaseBook.js): add / change a release by hand, set its vessel, remove it.
app.post('/releases/save', (req, res) => {
  try {
    const b = req.body || {};
    const r = require('./core/releaseBook').saveRelease({
      nr: b.nr, seller: b.seller, buyer: b.buyer, product: b.product,
      quantityKg: b.quantityT !== undefined && b.quantityT !== '' ? Number(String(b.quantityT).replace(',', '.')) * 1000 : undefined,
      bulk: b.bulk, vessel: b.vessel,
    });
    res.json({ status: 'ok', release: r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/releases/remove', (req, res) => {
  require('./core/releaseBook').removeRelease(String(req.body?.nr || ''));
  res.json({ status: 'ok' });
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
  // The done list blocks a second PRK for the plate today — not for a truck from yesterday.
  if (orderStore.dateOf(id) === todayString()) markDone(order.plate);
  orderStore.setState(id, 'done', { actor: 'operator', detail: 'marked done manually' });
  res.json({ status: 'ok' });
});

// A truck that is not a real order (an email read as one by mistake — NDR243, "didmaišiai 5
// paletės", 2026-11-11) leaves the desk as cancelled. It is not created again: the Excel sync skips
// a plate with any record today, and a repeat of the same email thread finds this closed record.
// KIPIS is not touched — a PortSystem draft, if any, goes with the draft cleanup.
app.post('/order/cancel', (req, res) => {
  const order = req.body?.id && orderStore.getOrder(String(req.body.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (orderStore.CLOSED_STATES.includes(order.state)) return res.json({ status: 'error', message: `${order.plate} is already ${order.state}` });
  if (order.state === 'filing') return res.json({ status: 'error', message: `${order.plate} is being filed in KIPIS right now — try again in a minute` });
  orderStore.setState(order.id, 'cancelled', { actor: 'operator', detail: 'cancelled by hand — not a real truck order' });
  console.log(`Order cancelled by hand: ${order.plate} (${order.id})`);
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

// An order's own email: the email store of its day (by message id — the store is keyed by plate and
// a later email for the same truck replaces that entry), else read from the mailbox by its id.
// 85 trucks of the previous two days showed "not stored" when only today's store was searched
// by plate (2026-11-12). Null for a truck from KIPIS (no email) or an email no longer in the inbox.
async function orderEmail(order) {
  const id = order.email?.messageId;
  if (!id || order.email?.from === 'KIPIS' || /^kipis:/.test(id)) return null;
  const stored = findByMessageId(id, orderStore.dateOf(order.id));
  if (stored) return stored;
  if (!/^\d+$/.test(String(id))) return null;
  try { return await fetchMessage(id); } catch { return null; }
}

app.get('/order-email', async (req, res) => {
  const { plate, id } = req.query;
  const order = id && orderStore.getOrder(String(id));
  if (order) {
    if (order.email?.from === 'KIPIS') return res.status(404).json({ error: 'This truck came from KIPIS — a PRK a person made there; it has no email.' });
    const data = await orderEmail(order);
    if (!data) return res.status(404).json({ error: 'The source email is not stored for this truck.' });
    return res.json(data);
  }
  if (!plate) return res.status(400).json({ error: 'Missing plate' });
  const data = getEmailData(plate);
  if (!data) return res.status(404).json({ error: 'No email data for this plate' });
  res.json(data);
});

// The release on the waybill (owner, 2026-11-11). GET /order/releases: the order's possible
// releases and, for each PDF attachment of its email, the release it already shows (if any).
// GET /order/waybill: that PDF ready to print — with the chosen release added, or unchanged when
// it already shows one. In memory only; nothing is saved on the PC.
const releaseStamp = require('./core/releaseStamp');
app.get('/order/releases', async (req, res) => {
  const { id, messageId } = req.query;
  const order = id && orderStore.getOrder(String(id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const { own, releases } = await releaseStamp.releasesFor(order);
    const checks = {};
    for (const a of String(req.query.attachments || '').split('|').filter(x => /\.pdf$/i.test(x))) {
      try {
        const found = await releaseStamp.checkWaybill(await fetchAttachmentBytes(messageId, a), releases);
        checks[a] = found ? found.id : null;
      } catch (err) { checks[a] = { error: err.message }; }
    }
    res.json({ status: 'ok', own, releases: releases.map(r => ({ id: r.id, text: r.text, vessel: r.vessel, remainingKg: r.remainingKg })), checks });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

app.get('/order/waybill', async (req, res) => {
  const { id, messageId, attachmentId, release } = req.query;
  const order = id && orderStore.getOrder(String(id));
  if (!order) return res.status(404).send('Order not found');
  if (!messageId || !/\.pdf$/i.test(String(attachmentId || ''))) return res.status(400).send('A PDF attachment is needed');
  try {
    const { releases } = await releaseStamp.releasesFor(order);
    const r = await releaseStamp.prepareWaybill(await fetchAttachmentBytes(messageId, attachmentId), releases, String(release || ''));
    if (r.stamped) console.log(`Waybill: ${order.plate} ${attachmentId} — ${r.stamped.text} added for printing`);
    const safe = String(attachmentId).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.type('application/pdf').send(r.buffer);
  } catch (err) {
    res.status(500).send(`Could not prepare the waybill: ${err.message}`);
  }
});

// CMRs printed by PortSystem instead of Avilda (ROADMAP S28). GET /cmr/draft: every box
// pre-filled for the operator to check. POST /cmr/print: the PDF, a register line, and the
// confirmed parties remembered (per release; per company for own cargo). The register and a
// reprint of any CMR by its number. PDFs are made in memory and shown for printing.
const cmr = require('./core/cmr');
app.get('/cmr/draft', async (req, res) => {
  const order = req.query.id && orderStore.getOrder(String(req.query.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    // Own cargo (Agrokoncernas' farmers): the place of delivery is in the email or on the
    // važtaraštis attached to it.
    const email = (await orderEmail(order)) || {};
    let extraText = email.body || '';
    if (order.loadsFrom?.source === 'own' && !cmr.deliveryFromText(extraText)) {
      const { PDFParse } = require('pdf-parse');
      for (const a of (email.attachments || []).filter(x => /\.pdf$/i.test(x.filename || x.attachmentId || ''))) {
        try { extraText += '\n' + (await new PDFParse({ data: await fetchAttachmentBytes(email.messageId, a.attachmentId) }).getText()).text; } catch { /* the operator types it */ }
      }
    }
    res.json({ status: 'ok', ...(await cmr.draftFor(order, { releaseId: req.query.release, date: orderStore.dateOf(order.id), extraText })) });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

app.post('/cmr/print', async (req, res) => {
  const { id, key, releaseId, terminal, remember } = req.body || {};
  const order = id && orderStore.getOrder(String(id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const c = req.body.cmr || {};
  const str = v => String(v ?? '').slice(0, 200);
  const lines = a => [...(Array.isArray(a) ? a : []), '', '', '', ''].slice(0, 4).map(str);
  const data = {
    number: str(c.number), sender: lines(c.sender), consignee: lines(c.consignee), carrier: lines(c.carrier),
    delivery: { place: str(c.delivery?.place), address: str(c.delivery?.address), extra: str(c.delivery?.extra) },
    loading: { place: str(c.loading?.place), address: str(c.loading?.address), date: str(c.loading?.date) },
    reservations: (Array.isArray(c.reservations) ? c.reservations : []).slice(0, 3).map(str),
    documents: str(c.documents),
    goods: (Array.isArray(c.goods) ? c.goods : []).slice(0, 10).map((g, i) => ({ text: str(g.text ?? g), indent: i > 0 })),
    statNo: str(c.statNo), grossKg: str(c.grossKg),
    instructions: (Array.isArray(c.instructions) ? c.instructions : []).slice(0, 3).map(str),
    establishedIn: str(c.establishedIn), date: str(c.date), driver: str(c.driver), plates: str(c.plates),
  };
  if (!data.number) return res.status(400).json({ error: 'The CMR needs a number' });
  if (cmr.register().some(r => r.number === data.number)) return res.status(400).json({ error: `CMR ${data.number} was already printed — use another number or print it again from the register` });
  try {
    const term = ['kkt', 'roro'].includes(terminal) ? terminal : null;
    const { pdf } = await cmr.issue({ order, key: str(key), releaseId: releaseId ? str(releaseId) : null, terminal: term, cmr: data, remember: remember !== false });
    console.log(`CMR ${data.number} printed for ${order.plate}`);
    await sendPack(res, order, pdf, term);
  } catch (err) {
    res.status(500).json({ error: `CMR not made: ${err.message}` });
  }
});

// The truck log (owner, 2026-11-11: "the whole log of trucks we are doing", kept for a year): every
// order in the day files between two dates, with its PRK, dispatch email, CMRs and history. Read
// straight from data/orders_state_<date>.json — nothing is copied; those files are never deleted.
app.get('/log', (req, res) => {
  const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;
  const to = day(req.query.to) || todayString();
  const from = day(req.query.from) || to;
  if (from > to) return res.status(400).json({ error: 'from is after to' });
  if ((new Date(to) - new Date(from)) / 86400000 > 366) return res.status(400).json({ error: 'At most one year at a time' });
  const cmrsBy = new Map();
  for (const r of cmr.register()) cmrsBy.set(r.orderId, [...(cmrsBy.get(r.orderId) || []), r.number]);
  const dataDir = path.join(__dirname, '../data');
  const days = require('fs').readdirSync(dataDir).map(f => (f.match(/^orders_state_(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(d => d && d >= from && d <= to).sort().reverse();
  const rows = [];
  for (const d of days) {
    for (const o of orderStore.listOrders(d)) {
      if (o.state === 'needs_human' && !o.docs?.PRK) continue;
      rows.push({
        date: d, id: o.id, plate: o.plate, company: senderCompanies.deriveCompany(o.email?.from || ''),
        cargo: o.cargo || '', weight: o.weight || '', grossWeight: o.grossWeight || '', bulk: !!o.bulk, state: o.state,
        vessel: o.loadsFrom?.vessel || '', lot: o.loadsFrom?.lot || '',
        prk: o.docs?.PRK?.number || '', prkStatus: o.docs?.PRK?.status || '',
        emailAt: o.dispatchSent?.at || '', emailTo: o.dispatchSent?.terminal || '',
        cmrs: cmrsBy.get(o.id) || [], subject: o.email?.subject || '', created: o.createdAt, updated: o.updatedAt,
        history: (o.history || []).map(h => ({ at: h.at, actor: h.actor, detail: h.detail || h.action })),
      });
    }
  }
  res.json({ from, to, rows });
});

// The truck's print pack again (its latest CMR, if any, and its PRK).
app.get('/order/print-pack', async (req, res) => {
  const order = req.query.id && orderStore.getOrder(String(req.query.id));
  if (!order) return res.status(404).send('Order not found');
  const last = cmr.forOrder(order.id)[0];
  const cmrPdf = last ? await cmr.reprint(last.number) : null;
  const terminal = last?.terminal || require('./core/terminals').terminalFor({ vessel: order.loadsFrom?.vessel || '', cargo: order.cargo });
  try { await sendPack(res, order, cmrPdf, terminal); } catch (err) { res.status(500).send(`Could not make the print pack: ${err.message}`); }
});

// The Print step: the operator opened the print pack from it → printed, and the truck is done.
app.post('/order/printed', (req, res) => {
  const order = req.body?.id && orderStore.getOrder(String(req.body.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  orderStore.setPrinted(order.id, { what: String(req.body.what || '').slice(0, 200) || 'print pack opened' });
  res.json({ status: 'ok' });
});

// The CMRs printed for one truck (its window lists them).
app.get('/order/cmrs', (req, res) => {
  res.json({ cmrs: cmr.forOrder(String(req.query.id || '')).map(({ cmr: c, ...r }) => r) });
});

app.get('/cmr/register', (req, res) => {
  res.json({ cmrs: cmr.register().reverse().slice(0, 300).map(({ cmr: c, ...r }) => r) });
});

app.get('/cmr/pdf', async (req, res) => {
  const pdf = await cmr.reprint(String(req.query.number || ''));
  if (!pdf) return res.status(404).send('No CMR with that number in the register');
  res.setHeader('Content-Disposition', `inline; filename="CMR ${String(req.query.number).replace(/[^\w-]/g, '_')}.pdf"`);
  res.type('application/pdf').send(pdf);
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
    // The cargo is kept exactly as the operator typed it. It used to be replaced by the cargo
    // list's name for it — "Amonio sulfatas (600) gran." became "Gran AS" (MML743//SN216,
    // 2026-11-10), losing the bag size and taking a bulk-sounding name. The list is now only
    // asked for the vessel hint shown after saving.
    if (cargo !== undefined) {
      const match    = findCargoInText(cargo);
      resolvedCargo  = cargo;
      resolvedVessel = match ? match.vessel : '';
      fields.cargo   = cargo;
    }
    if (weight !== undefined) fields.weight = weight;
    if (typeof bulk === 'boolean') fields.bulk = bulk;
    // '' clears it — then the PRK computes it (weight + 1 kg per bag).
    if (grossWeight !== undefined) fields.grossWeight = String(grossWeight).trim();

    const updated = updateOrderFields(plate, fields);
    if (updated) {
      console.log(`Manual order edit: ${plate} →${resolvedCargo ? ' ' + resolvedCargo : ''}${weight !== undefined ? ' ' + weight + 'kg' : ''}${grossWeight !== undefined ? ' gross ' + grossWeight + 'kg' : ''}${bulk ? ' [BULK]' : ''}`);
      if (id) orderStore.updateOrderFields(id, fields);
    }
    // A15: a truck that stopped for something in the order goes back in line once it is fixed —
    // no second click. Never one that failed after Saugoti or already has a PRK.
    const requeued = !!(updated && id && orderStore.requeue(id, { actor: 'operator', detail: 'order fixed — filing again' }));
    if (requeued) setTimeout(() => autoRound('order fixed').catch(err => console.error('Auto round:', err.message)), 1000);
    res.json({ status: updated ? 'ok' : 'not_found', cargo: resolvedCargo, vessel: resolvedVessel, requeued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S9: a bulk truck's loaded weight, as the terminal reported it. It becomes the net and gross
// weight (order + today's Excel row, which the PRK filler reads), the truck goes back in line and a
// filing round starts at once — the PRK draft follows without another click (Pateikti stays human).
app.post('/order/loaded-weight', (req, res) => {
  const order = req.body?.id && orderStore.getOrder(String(req.body.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.bulk) return res.status(400).json({ error: 'Only bulk trucks get their weight after loading' });
  if (order.docs?.PRK?.number) return res.status(400).json({ error: `This truck already has PRK ${order.docs.PRK.number}` });
  const kg = Math.round(Number(String(req.body.kg ?? '').replace(/[\s,]/g, '').replace(/t$/i, '')));
  if (!(kg >= 1000 && kg <= 60000)) return res.status(400).json({ error: 'The loaded weight must be in kg, between 1 000 and 60 000' });
  const inExcel = orderStore.dateOf(order.id) === todayString() && updateOrderFields(order.plate, { weight: String(kg), grossWeight: String(kg) });
  if (!inExcel) return res.json({ status: 'error', message: `The weight was not saved: ${order.plate} is not in today's orders file, so its PRK cannot be filed automatically — file it by hand in KIPIS.` });
  orderStore.setLoadedWeight(order.id, kg);
  console.log(`Loaded weight: ${order.plate} ${kg} kg — PRK next`);
  setTimeout(() => autoRound('loaded weight entered').catch(err => console.error('Auto round:', err.message)), 500);
  res.json({ status: 'ok', kg });
});

// The legacy POST /run (ran kipisLoad with no session or busy check) was removed 2026-11-11 —
// nothing called it. Filing goes through /run-prk and the queue.

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
