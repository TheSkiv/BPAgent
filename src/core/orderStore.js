const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { todayString, todayFilePath } = require('./dateManager');
const { getEmailData } = require('./emailCache');

const DATA_DIR = process.env.DATA_DIR || 'C:\\PortSystem\\data';

// Lifecycle. `needs_human`, `failed` and `cancelled` are terminal-ish side states.
// `gate_pass_ordered`: terminal@bpa.lt sent the PRK-request email to KKT dispatch for a BULK
// order — that's the gate pass, not completion. The truck is still open until actually done.
// `submitted`: the operator pressed Pateikti on PortSystem's draft (seen in KIPIS's PRK list,
// ROADMAP A18) — the dispatch email still has to go out; the terminal's copy of it closes it.
const STATES = [
  'received', 'ready', 'filing', 'drafted', 'submitted', 'verified', 'gate_pass_ordered', 'to_print', 'done',
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

// An order id starts with its day ("2026-11-10-003"), which names the file it lives in — so an
// order from yesterday can be opened, sent and closed without the caller knowing its date.
function dateOf(id) {
  const m = String(id || '').match(/^(\d{4}-\d{2}-\d{2})-/);
  return m ? m[1] : undefined;
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

const senderAddress = from => (String(from || '').match(/<([^>]+)>/) || [, from || ''])[1].trim().toLowerCase();
// "RE: Fw: : Release 291568  DAP" and "Release 291568 DAP" are one thread.
const threadSubject = s => String(s || '').replace(/^(\s*(re|fw|fwd|aw|sv|ats|pers)\s*:|\s*[:\-–—]+)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

function ensureOrder({ plate, cargo, weight, bulk, grossWeight, sender, received, messageId, subject, state }) {
  if (!plate) return null;
  const db = load();

  // A truck still open (anywhere from received through gate_pass_ordered) blocks a same-day
  // repeat entirely, regardless of source email — Transwina reply-threads often re-quote an old
  // booking, which re-triggers extraction of the same plate pair from a new message. Only once
  // the earlier booking is closed (done/cancelled) does a repeat count as a legitimate second
  // trip and get its own record.
  const activeExisting = db.orders.find(o => o.plateNorm === normalizePlate(plate) && !CLOSED_STATES.includes(o.state));
  if (activeExisting) return activeExisting;

  // A closed truck named again by the same sender under the same subject is an updated order
  // table, not a second trip (owner's rule, 2026-11-11: UHB re-sends "Release 291568 DAP …" with
  // the trucks already ordered still in it). A different subject still counts as a new trip.
  const sameThread = subject && db.orders.find(o => o.plateNorm === normalizePlate(plate)
    && senderAddress(o.email?.from) === senderAddress(sender)
    && threadSubject(o.email?.subject) === threadSubject(subject));
  if (sameThread) return sameThread;

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
  const date  = dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  const changes = [];
  if (cargo !== undefined)       { order.cargo       = cargo;       changes.push(`cargo → ${cargo}`); }
  if (weight !== undefined)      { order.weight       = weight;      changes.push(`weight → ${weight}`); }
  if (bulk !== undefined)        { order.bulk         = !!bulk;      changes.push(`bulk → ${!!bulk}`); }
  if (grossWeight !== undefined) { order.grossWeight  = grossWeight; changes.push(`grossWeight → ${grossWeight}`); }
  if (!changes.length) return order;
  logHistory(order, 'operator', 'fields', changes.join(', '));
  save(db, date);
  return order;
}

function listOrders(date) {
  return load(date).orders;
}

function getOrder(id, date) {
  return load(date || dateOf(id)).orders.find(o => o.id === id) || null;
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

const PRINT_STEP_FROM = '2026-11-11T14:00:00Z';
function needsPrinting(o) {
  if (o.printedAt || (o.createdAt || '') < PRINT_STEP_FROM) return false;
  // Closed while our own PRK is still a draft: a colleague finished the truck on their own PRK and
  // sent the email by hand (EZV710, MOB412 on 2026-11-12) — nothing of ours to print.
  if (o.docs?.PRK?.number && /ruošiamas/i.test(o.docs.PRK.status || '') && !o.dispatchSent) return false;
  return !!o.dispatchSent || (o.history || []).some(h => /PRK draft saved/.test(h.detail || ''));
}

// Documents printed (the print pack opened from the Print step) → the truck is done.
// part (S42, owner 2026-11-12: the PRK as its own PDF): 'transport' (CMR / važtaraštis) or 'prk'.
// The truck counts as printed once every part it needs is opened — bagged: both; bulk: the PRK.
// No part: the whole pack (the truck window's "Print pack").
const PRINT_PARTS = o => (o.bulk ? ['prk'] : ['transport', 'prk']);
function setPrinted(id, { date, what = '', part = null } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  logHistory(order, 'operator', 'printed', what || 'documents printed');
  if (part) order.printedParts = [...new Set([...(order.printedParts || []), part])];
  if (part && !PRINT_PARTS(order).every(p => order.printedParts.includes(p))) { save(db, date); return order; }
  order.printedAt = new Date().toISOString();
  // Printed after the email (or once a bulk truck's PRK exists): nothing is left — done, without
  // waiting for the terminal's copy of the email.
  const finished = order.state === 'to_print'
    || (order.state === 'submitted' && order.dispatchSent)
    || (order.bulk && order.docs?.PRK?.number && ['gate_pass_ordered', 'submitted', 'drafted'].includes(order.state));
  if (finished) {
    logHistory(order, 'operator', 'state', `${order.state} → done — documents printed`);
    order.state = 'done';
  }
  save(db, date);
  return order;
}

// `date` (YYYY-MM-DD) addresses an earlier day's order file; default today.
// noPrint: the truck was finished by someone else (loaded on a colleague's PRK) — no Print step.
function setState(id, state, { actor = 'system', detail = '', date, noPrint = false } = {}) {
  if (!STATES.includes(state)) throw new Error(`Unknown order state: ${state}`);
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  const from = order.state;
  // The Print step (owner, 2026-11-11: Email → Print → Done). Anything that closes a truck by
  // itself — the terminal's copy of the email, KIPIS reporting the PRK loaded — stops at
  // "to_print" until its documents are printed. Only trucks PortSystem drove (it saved the PRK or
  // sent the email) and created since the step exists; the operator's own "Mark done" still closes.
  if (state === 'done' && actor !== 'operator' && !noPrint && needsPrinting(order)) {
    state = 'to_print';
    detail = `${detail ? detail + '; ' : ''}documents to print`;
    if (from === 'to_print') { save(db, date); return order; }
  }
  order.state = state;
  logHistory(order, actor, 'state', `${from} → ${state}${detail ? ' — ' + detail : ''}`);
  save(db, date);
  return order;
}

// Why the last filing attempt stopped, so the order can go back in line without a click:
//   'transient'  — a KIPIS hiccup before Saugoti; a later round tries again (at most twice)
//   'data'       — something in the order is missing or wrong; fixing the order re-queues it
//   'after-save' — it failed after Saugoti was pressed: a draft may exist, a person looks (Rule 6)
const AUTO_RETRY_LIMIT = 2;
function markFailure(id, kind, { date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.lastFailure = { kind, at: new Date().toISOString(), autoRetries: order.lastFailure?.autoRetries || 0 };
  save(db, date);
  return order;
}

// Puts a failed order back to `ready` — only one that has no PRK and did not fail after Saugoti.
// auto: counts against AUTO_RETRY_LIMIT; an operator's fix resets the count. Returns the order
// if it was re-queued, else null.
function requeue(id, { actor = 'system', detail = '', auto = false, date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order || order.state !== 'failed' || order.docs?.PRK?.number) return null;
  const f = order.lastFailure;
  if (!f || f.kind === 'after-save') return null;
  if (auto && (f.kind !== 'transient' || f.autoRetries >= AUTO_RETRY_LIMIT)) return null;
  f.autoRetries = auto ? f.autoRetries + 1 : 0;
  order.state = 'ready';
  logHistory(order, actor, 'state', `failed → ready${detail ? ' — ' + detail : ''}`);
  save(db, date);
  return order;
}

// Links a KIPIS document to the order. `number` may be null until document capture exists.
function attachDocument(id, { type, number = null, status = 'drafted' }, { actor = 'kipis', date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.docs[type] = { number, status, at: new Date().toISOString() };
  logHistory(order, actor, 'document', `${type} ${number || '(number not captured)'} — ${status}`);
  save(db, date);
  return order;
}

// A colleague submitted their own PRK for a truck PortSystem had drafted (S41, owner 2026-11-12):
// the order takes their PRK (the dispatch email and print use it) and keeps ours in `ourDraft`,
// for the KIPIS sync to delete. setOurDraftStatus records what became of it.
function supersedeDraft(id, { number, status }, { actor = 'kipis', date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order || !order.docs?.PRK?.number || order.docs.PRK.number === number) return null;
  const ours = order.docs.PRK;
  order.ourDraft = { number: ours.number, status: ours.status, at: new Date().toISOString() };
  order.docs.PRK = { number, status, at: new Date().toISOString() };
  logHistory(order, actor, 'document', `PRK ${number} — ${status}: a colleague's PRK for this truck; our draft ${ours.number} is not needed and is deleted`);
  save(db, date);
  return order;
}
function setOurDraftStatus(id, status, { actor = 'kipis', date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order || !order.ourDraft) return null;
  order.ourDraft.status = status;
  logHistory(order, actor, 'document', `our draft ${order.ourDraft.number} — ${status}`);
  save(db, date);
  return order;
}

// What a filed order loads from — { owner, source, vessel, lot, grossKg, releaseKey } — so later
// orders can see what is already promised from a release (ROADMAP A7).
function setLoadsFrom(id, loadsFrom, { date } = {}) {
  if (!loadsFrom) return null;
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.loadsFrom = loadsFrom;
  save(db, date);
  return order;
}

// The dispatch email the operator sent from the dashboard (A19) — { at, terminal, to, prk,
// subject } — so it is never sent twice.
function setDispatchSent(id, info, { date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.dispatchSent = info;
  logHistory(order, 'operator', 'dispatch email', `sent to ${info.to.join(', ')} (${String(info.terminal).toUpperCase()}), PRK ${info.prk}`);
  save(db, date);
  return order;
}

// Gross kg of PortSystem drafts filed against a release and not yet done — today's and
// yesterday's orders (a PRK is for today or tomorrow). Once an order is done its truck is loaded
// and the release list's "left" takes it off itself.
function pendingReleaseKg(releaseKey) {
  if (!releaseKey) return 0;
  let kg = 0;
  for (const date of [daysAgo(0), daysAgo(1)]) {
    for (const o of load(date).orders) {
      if (o.state === 'drafted' && o.loadsFrom?.releaseKey === releaseKey) kg += Number(o.loadsFrom.grossKg) || 0;
    }
  }
  return kg;
}

// A local calendar date `days` before today, YYYY-MM-DD (like todayString — not toISOString,
// which is UTC and shifts the day).
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every PRK PortSystem itself saved, from order files between `maxAgeDays` and `minAgeDays` days
// old (0 = today): number → { date, orderId, plate, state }. Only numbers whose order history says
// PortSystem saved the draft ("PRK draft saved …<number>") — a PRK merely found on the lot (filed
// by a person, e.g. NGU792's 261110-003439-PRK) is recorded on the order too, but is never ours.
// The daily cleanup asks for minAgeDays 2: a PRK is for today or tomorrow, so one whose order is
// two days old and still a draft was not used (operator, 2026-11-10).
function prkNumbersFiled({ minAgeDays = 0, maxAgeDays = 30 } = {}) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => /^orders_state_\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { return out; }
  const newest = daysAgo(minAgeDays), oldest = daysAgo(maxAgeDays);
  for (const f of files) {
    const date = f.slice('orders_state_'.length, -'.json'.length);
    if (date > newest || date < oldest) continue;
    for (const o of load(date).orders) {
      const savedByUs = n => n && (o.history || []).some(h => /PRK draft saved/.test(h.detail || '') && (h.detail || '').includes(n));
      // emailed: the truck's dispatch email is known to have gone out — sent from the dashboard,
      // or the terminal's copy closed the order (often after a colleague filed their own PRK).
      const emailed = !!o.dispatchSent || (o.history || []).some(h => h.actor === 'terminal' && /PRK confirmed by terminal@bpa\.lt/.test(h.detail || ''));
      const n = o.docs?.PRK?.number;
      if (savedByUs(n)) out.set(n, { date, orderId: o.id, plate: o.plate, state: o.state, emailed, kipisStatus: o.docs.PRK.status || '' });
      // Our draft for a truck a colleague submitted on their own PRK (S41): the order now carries
      // their PRK; ours is kept here only to be deleted (superseded — never moves the order).
      const s = o.ourDraft?.number;
      if (savedByUs(s)) out.set(s, { date, orderId: o.id, plate: o.plate, state: o.state, emailed, kipisStatus: o.ourDraft.status || '', superseded: true });
    }
  }
  return out;
}

// Creates a record for every row in today's orders Excel that does not have one yet, linking
// the cached source email where available. Lets the store reflect the existing pipeline.
// The Excel holds one row per plate per day, so a plate with any record today (open or closed)
// is already reflected. The cached email is the latest one naming the plate — an updated
// order table — so keying on it re-created a truck the operator had just closed
// (NCB196//LR111, 2026-11-11).
function syncFromExcel() {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return 0;
  const wb   = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  let created = 0;
  for (const r of rows) {
    const plate = r['Plate'];
    if (!plate) continue;
    if (load().orders.some(o => o.plateNorm === normalizePlate(plate))) continue;
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
// Can the queue file this order now? A bulk truck only once the operator has entered the weight it
// was loaded with (S9) — a weight typed earlier must not file a PRK before the truck is loaded.
const isFileable = o => o.state === 'ready' && (!o.bulk || !!o.loadedKg);

// S9: the terminal reported a bulk truck's loaded weight and the operator entered it. It becomes
// the order's net and gross weight (bulk has no bags), and the truck goes back in line for its PRK.
function setLoadedWeight(id, kg, { date } = {}) {
  date = date || dateOf(id);
  const db    = load(date);
  const order = db.orders.find(o => o.id === id);
  if (!order) return null;
  order.weight = String(kg);
  order.grossWeight = String(kg);
  order.loadedKg = kg;
  logHistory(order, 'operator', 'fields', `loaded weight ${kg} kg entered`);
  if (!order.docs?.PRK?.number && ['gate_pass_ordered', 'ready', 'received', 'failed'].includes(order.state)) {
    logHistory(order, 'operator', 'state', `${order.state} → ready — loaded weight known, PRK next`);
    order.state = 'ready';
  }
  save(db, date);
  return order;
}

function nextReadyNonBulk(date) {
  return listOrders(date)
    .filter(isFileable)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0] || null;
}

module.exports = {
  STATES, CLOSED_STATES,
  ensureOrder, listOrders, getOrder, findByPlate, activeOrderForPlate,
  setState, attachDocument, syncFromExcel, queueAndDone, normalizePlate,
  pendingConfirmations, approveOrder, rejectOrder, applyToMessage, applyToSender,
  nextReadyNonBulk, updateOrderFields, prkNumbersFiled, supersedeDraft, setOurDraftStatus, setLoadsFrom, pendingReleaseKg, setDispatchSent,
  markFailure, requeue, AUTO_RETRY_LIMIT, dateOf, daysAgo, setPrinted, isFileable, setLoadedWeight,
};
