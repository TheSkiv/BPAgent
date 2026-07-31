const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { todayString, todayFilePath } = require('./dateManager');
const { getEmailData } = require('./emailCache');

const DATA_DIR = process.env.DATA_DIR || 'C:\\PortSystem\\data';

// Lifecycle. `needs_human`, `failed` and `cancelled` are terminal-ish side states.
// `gate_pass_ordered`: terminal@bpa.lt sent the PRK-request email to KKT dispatch for a BULK
// order — that's the gate pass, not completion. The truck is still open until actually done.
const STATES = [
  'received', 'ready', 'filing', 'drafted', 'verified', 'gate_pass_ordered', 'done',
  'needs_human', 'failed', 'cancelled',
];
const CLOSED_STATES = ['done', 'cancelled'];

function statePath(date) {
  return path.join(DATA_DIR, `orders_state_${date || todayString()}.json`);
}

function normalizePlate(str) {
  return String(str || '').replace(/[\s/\\]+/g, '').toLowerCase();
}

function load(date) {
  const p = statePath(date);
  if (!fs.existsSync(p)) return { seq: 0, orders: [] };
  try {
    const db = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { seq: db.seq || 0, orders: Array.isArray(db.orders) ? db.orders : [] };
  } catch {
    return { seq: 0, orders: [] };
  }
}

function save(db, date) {
  fs.writeFileSync(statePath(date), JSON.stringify(db, null, 1));
}

function logHistory(order, actor, action, detail) {
  order.history.push({ at: new Date().toISOString(), actor, action, detail: detail || '' });
  order.updatedAt = new Date().toISOString();
}

// Identity is (plate + source email), NOT plate alone — the same truck can legitimately be
// ordered twice in one day. Reprocessing the same email stays idempotent; a second order from
// a different email creates a second record.
function identityKey(plate, messageId, cargo) {
  return `${normalizePlate(plate)}|${messageId || 'nomsg'}|${messageId ? '' : String(cargo || '').toLowerCase()}`;
}

function ensureOrder({ plate, cargo, weight, bulk, grossWeight, sender, received, messageId, subject, state }) {
  if (!plate) return null;
  const db  = load();
  const key = identityKey(plate, messageId, cargo);

  const existing = db.orders.find(o => o.key === key);
  if (existing) return existing;

  db.seq += 1;
  const order = {
    id:        `${todayString()}-${String(db.seq).padStart(3, '0')}`,
    key,
    plate,
    plateNorm: normalizePlate(plate),
    cargo:       cargo  || '',
    weight:      weight || '',
    grossWeight: grossWeight || '',
    bulk:      !!bulk,
    state:     state && STATES.includes(state) ? state : 'received',
    email:     { messageId: messageId || '', from: sender || '', subject: subject || '', received: received || '' },
    docs:      {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history:   [],
  };
  logHistory(order, 'intake', 'created', `plate ${plate}`);
  db.orders.push(order);
  save(db);
  return order;
}

// Manual operator edit (cargo/weight/BULK) — always overwrites, unlike the AI back-fill path.
function updateOrderFields(id, { cargo, weight, bulk, grossWeight } = {}) {
  const db    = load();
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  const changes = [];
  if (cargo !== undefined)       { order.cargo       = cargo;       changes.push(`cargo → ${cargo}`); }
  if (weight !== undefined)      { order.weight       = weight;      changes.push(`weight → ${weight}`); }
  if (bulk !== undefined)        { order.bulk         = !!bulk;      changes.push(`bulk → ${!!bulk}`); }
  if (grossWeight !== undefined) { order.grossWeight  = grossWeight; changes.push(`grossWeight → ${grossWeight}`); }
  if (!changes.length) return order;
  logHistory(order, 'operator', 'fields', changes.join(', '));
  save(db);
  return order;
}

function listOrders(date) {
  return load(date).orders;
}

function getOrder(id, date) {
  return load(date).orders.find(o => o.id === id) || null;
}

// All orders for a plate — may be more than one on the same day.
function findByPlate(plate, date) {
  const n = normalizePlate(plate);
  return load(date).orders.filter(o => o.plateNorm === n);
}

// The order a plate-keyed action should act on: the newest one still open.
function activeOrderForPlate(plate, date) {
  const open = findByPlate(plate, date).filter(o => !CLOSED_STATES.includes(o.state));
  return open.length ? open[open.length - 1] : null;
}

function setState(id, state, { actor = 'system', detail = '' } = {}) {
  if (!STATES.includes(state)) throw new Error(`Unknown order state: ${state}`);
  const db    = load();
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  const from = order.state;
  order.state = state;
  logHistory(order, actor, 'state', `${from} → ${state}${detail ? ' — ' + detail : ''}`);
  save(db);
  return order;
}

// Links a KIPIS document to the order. `number` may be null until document capture exists.
function attachDocument(id, { type, number = null, status = 'drafted' }, { actor = 'kipis' } = {}) {
  const db    = load();
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.docs[type] = { number, status, at: new Date().toISOString() };
  logHistory(order, actor, 'document', `${type} ${number || '(number not captured)'} — ${status}`);
  save(db);
  return order;
}

// Creates a record for every row in today's orders Excel that does not have one yet, linking
// the cached source email where available. Lets the store reflect the existing pipeline.
function syncFromExcel() {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return 0;
  const wb   = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  let created = 0;
  for (const r of rows) {
    const plate = r['Plate'];
    if (!plate) continue;
    const before = load().orders.length;
    const email  = getEmailData(plate) || {};
    ensureOrder({
      plate,
      cargo:       r['Cargo'] || '',
      weight:      r['Weight'] || '',
      grossWeight: r['Gross Weight'] || '',
      bulk:      r['Bulk'] === '1' || r['Bulk'] === 1,
      sender:    r['Sender'] || email.from || '',
      received:  r['Received'] || '',
      messageId: email.messageId || '',
      subject:   email.subject || '',
    });
    if (load().orders.length > before) created++;
  }
  return created;
}

// Queue = still to do; done = closed. Both newest-first.
function queueAndDone(date) {
  const orders = listOrders(date);
  const byNewest = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
  return {
    queue: orders.filter(o => !CLOSED_STATES.includes(o.state)).sort(byNewest),
    done:  orders.filter(o =>  CLOSED_STATES.includes(o.state)).sort(byNewest),
  };
}

// Emails awaiting human confirmation, grouped one entry per source email.
function pendingConfirmations(date) {
  const groups = new Map();
  for (const o of listOrders(date)) {
    if (o.state !== 'needs_human') continue;
    const key = o.email?.messageId || `no-msg:${o.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        messageId: o.email?.messageId || '',
        sender:    o.email?.from || '',
        subject:   o.email?.subject || '',
        received:  o.email?.received || '',
        orderIds:  [],
        plates:    [],
        cargo:     o.cargo || '',
        bulk:      !!o.bulk,
      });
    }
    const g = groups.get(key);
    g.orderIds.push(o.id);
    g.plates.push(o.plate);
    if (!g.cargo && o.cargo) g.cargo = o.cargo;
  }
  return [...groups.values()];
}

function approveOrder(id, detail) {
  return setState(id, 'ready', { actor: 'operator', detail: detail || 'confirmed' });
}

function rejectOrder(id, detail) {
  return setState(id, 'cancelled', { actor: 'operator', detail: detail || 'rejected' });
}

// Applies an action to every pending order belonging to one source email.
function applyToMessage(messageId, fn, date) {
  const ids = listOrders(date)
    .filter(o => o.state === 'needs_human' && (o.email?.messageId || '') === messageId)
    .map(o => o.id);
  ids.forEach(fn);
  return ids.length;
}

// Same, for every pending order from a sender address.
function applyToSender(sender, fn, date) {
  const s = String(sender || '').toLowerCase();
  const ids = listOrders(date)
    .filter(o => o.state === 'needs_human' && String(o.email?.from || '').toLowerCase().includes(s))
    .map(o => o.id);
  ids.forEach(fn);
  return ids.length;
}

// Next order the PRK worker should take: oldest ready, non-bulk. Bulk needs a weight first.
function nextReadyNonBulk(date) {
  return listOrders(date)
    .filter(o => o.state === 'ready' && !o.bulk)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0] || null;
}

module.exports = {
  STATES, CLOSED_STATES,
  ensureOrder, listOrders, getOrder, findByPlate, activeOrderForPlate,
  setState, attachDocument, syncFromExcel, queueAndDone, normalizePlate,
  pendingConfirmations, approveOrder, rejectOrder, applyToMessage, applyToSender,
  nextReadyNonBulk, updateOrderFields,
};
