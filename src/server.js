require('dotenv').config();
const express       = require('express');
const path          = require('path');
const { openKipis, getPage } = require('./core/browser');
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
const lotMarks = require('./core/lotMarks');
const lotStock = require('./core/lotStock');
const { searchLots, isOurStorage } = require('../KIPIS_skills/PRK/navigateToCargo');

// Checked before an order is taken, so a closed KIPIS window never fails a good order.
function kipisOpen() {
  try { return !getPage().isClosed(); } catch { return false; }
}
const KIPIS_CLOSED = 'KIPIS is not open — press Open KIPIS (and enter the MFA code) first. No order was touched.';

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
  orderStore.setState(order.id, 'drafted', { actor: 'kipis', detail: `PRK draft saved (Saugoti): ${result.prkNumber} — waiting for Pateikti` });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/gmail', gmailRoute);

let isRunning = false;

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

  if (!kipisOpen()) return res.json({ status: 'error', message: KIPIS_CLOSED });

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
    res.json({ status: 'ok', submitted: result.submitted, prkNumber: result.prkNumber || null, blocked: result.blocked || null, existingPrk: result.existingPrk || null, needsLotMarking: !!result.needsLotMarking, check: result.check || null, fieldCheck: result.fieldCheck || null });
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

    const { docs, drafts, headers, headRowCount, rawRowCount, limitUsed } = await readFullPrkList({ limit });

    orderStore.syncFromExcel();
    const checked = findDeletable(drafts, {
      ourEmployee: process.env.KIPIS_EMPLOYEE || '',
      today: todayString(),
      orders: orderStore.listOrders(),
    });

    res.json({
      status: 'ok', headers, headRowCount, rawRowCount, limitUsed,
      total: docs.length,
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
  if (!kipisOpen()) return res.json({ status: 'error', message: KIPIS_CLOSED });

  orderStore.syncFromExcel();
  const next = orderStore.nextReadyNonBulk();
  if (!next) return res.json({ status: 'empty', message: 'No ready non-bulk orders in the queue.' });

  isRunning = true;
  orderStore.setState(next.id, 'filing', { actor: 'kipis', detail: 'queue worker' });
  console.log(`Queue: processing ${next.id} | ${next.plate}`);

  try {
    const result = await kipisLoad.run({ plate: next.plate });
    if (result.submitted) {
      recordSavedDraft(next, next.plate, result);
    } else if (result.existingPrk) {
      recordExistingPrk(next, next.plate, result.existingPrk);
    } else if (result.blocked) {
      orderStore.setState(next.id, 'failed', { actor: 'kipis', detail: `not saved — ${result.blocked}; form left open in KIPIS for review` });
    } else {
      orderStore.setState(next.id, 'drafted', { actor: 'kipis', detail: 'filled, not saved (dry run)' });
    }
    res.json({ status: 'ok', order: next.id, plate: next.plate, submitted: result.submitted, prkNumber: result.prkNumber || null, blocked: result.blocked || null, existingPrk: result.existingPrk || null, needsLotMarking: !!result.needsLotMarking, check: result.check || null, fieldCheck: result.fieldCheck || null });
  } catch (err) {
    orderStore.setState(next.id, 'failed', { actor: 'kipis', detail: err.message });
    console.error(`Queue: ${next.id} failed —`, err.message);
    res.json({ status: 'error', order: next.id, plate: next.plate, message: err.message });
  } finally {
    isRunning = false;
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
  if (!kipisOpen()) return res.json({ status: 'error', message: KIPIS_CLOSED });
  isRunning = true;
  try {
    const page = getPage();
    if (!await page.locator('[id$=":fPavadinimas"]').isVisible()) {
      await page.getByText('Sekimas', { exact: true }).first().click();
      await page.waitForLoadState('networkidle');
      await page.locator('text="Kroviniai"').click();
      await page.waitForLoadState('networkidle');
    }
    const { rows, lotCount, truncated } = await searchLots(page, q);
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

// Lot marks: which KIPIS lot is bagged/bulk and the order lots are loaded in (ROADMAP A22),
// plus lots a stopped PRK run is waiting on.
// Pending entries come grouped by vessel, with the stock reports' BB / bulk / off-spec rows and
// a suggested packaging per lot (lotStock.js).
app.get('/lots', async (req, res) => {
  const { lots, pending } = lotMarks.listMarks();
  res.json({ lots, pending: await Promise.all(pending.map(lotStock.describePending)) });
});

app.post('/lots/mark', (req, res) => {
  try {
    res.json({ status: 'ok', mark: lotMarks.setMark(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/lots/remove', (req, res) => {
  const { lot } = req.body || {};
  if (!lot) return res.status(400).json({ error: 'Missing lot' });
  res.json({ status: lotMarks.removeMark(lot) ? 'ok' : 'not_found' });
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
