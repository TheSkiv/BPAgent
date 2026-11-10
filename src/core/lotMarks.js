const fs   = require('fs');
const path = require('path');

// Which KIPIS lot (shipment number, e.g. 260924-001330-L) is bagged or bulk, and the order the
// lots are loaded in. Set by the operator: the loading order is agreed with the terminal, often by
// phone, and stock reports and KIPIS both say BULK even for bagged cargo — no system holds this
// (ROADMAP A22). One lot is normally cleaned out before the next one starts.
const MARKS_PATH = path.resolve(__dirname, '../../config/lot_marks.json');
const PACKAGING  = ['bagged', 'bulk'];

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(MARKS_PATH, 'utf8'));
    return { lots: Array.isArray(d.lots) ? d.lots : [], pending: Array.isArray(d.pending) ? d.pending : [] };
  } catch {
    return { lots: [], pending: [] };
  }
}

function save(d) {
  fs.writeFileSync(MARKS_PATH, JSON.stringify(d, null, 1));
}

// A pending entry is resolved once every one of its lots is marked.
function dropResolvedPending(d) {
  const marked = new Set(d.lots.map(l => l.lot));
  d.pending = d.pending.filter(p => p.candidates.some(c => !marked.has(c.lot)));
}

function listMarks() {
  return load();
}

function setMark({ lot, vessel, cargo, packaging, priority }) {
  lot = String(lot || '').trim();
  if (!lot) throw new Error('Missing lot number');
  if (!PACKAGING.includes(packaging)) throw new Error(`Packaging must be one of: ${PACKAGING.join(', ')}`);
  const prio = Number(priority);
  if (!Number.isInteger(prio) || prio < 1) throw new Error('Loading order must be a whole number from 1');

  const d = load();
  const mark = { lot, vessel: String(vessel || '').trim(), cargo: String(cargo || '').trim(), packaging, priority: prio, markedAt: new Date().toISOString() };
  const i = d.lots.findIndex(l => l.lot === lot);
  if (i === -1) d.lots.push(mark); else d.lots[i] = mark;
  dropResolvedPending(d);
  save(d);
  return mark;
}

function removeMark(lot) {
  const d = load();
  const before = d.lots.length;
  d.lots = d.lots.filter(l => l.lot !== lot);
  save(d);
  return before !== d.lots.length;
}

// Lots a stopped run needs marked; kept until marked so the dashboard can list them.
function addPending({ vessel, cargo, packaging, plate, candidates }) {
  const d = load();
  d.pending = d.pending.filter(p => !(p.vessel === vessel && p.cargo === cargo));
  d.pending.push({ vessel, cargo, packaging, plate, candidates, seenAt: new Date().toISOString() });
  dropResolvedPending(d);
  save(d);
}

// A run for this cargo picked a lot: its pending marking request is no longer blocking anything.
function clearPending(cargo) {
  const d = load();
  const before = d.pending.length;
  d.pending = d.pending.filter(p => p.cargo !== cargo);
  if (d.pending.length !== before) save(d);
}

// candidates: one entry per storage row in our terminals — { lot, name, place, weightKg, trucksLoading }.
// Returns { pick, note } or { stop, needsMarking }.
function chooseLot(candidates, packaging, grossKg) {
  if (!candidates.length) {
    return { stop: 'no lot of this cargo is in our storage places (Ro-Ro or Konteinerių terminalas)', needsMarking: false };
  }

  const marks  = load().lots;
  const markOf = c => marks.find(m => m.lot === c.lot);
  const lotNumbers = [...new Set(candidates.map(c => c.lot))];
  const unmarked   = lotNumbers.filter(lot => !marks.some(m => m.lot === lot));
  const heaviestFirst = (a, b) => b.weightKg - a.weightKg;

  if (lotNumbers.length === 1 && unmarked.length === 1) {
    const pick = [...candidates].sort(heaviestFirst)[0];
    if (pick.weightKg < grossKg) return { stop: `the only lot, ${pick.lot}, has ${pick.weightKg} kg left; the truck needs ${grossKg} kg`, needsMarking: false };
    return { pick, note: `only lot of this cargo (${pick.lot}) — not marked, used as the only option` };
  }

  // A lot the operator marked loading order 1 for this packaging has nothing ahead of it, so the
  // unmarked lots cannot change the pick — use it while it still holds a truck (operator,
  // 2026-11-10: "OSLO CARRIER 2 is bagged and loads first", the other two TSP lots unmarked).
  const firstMarked = candidates
    .filter(c => markOf(c)?.packaging === packaging && markOf(c).priority === 1 && c.weightKg >= grossKg)
    .sort(heaviestFirst)[0];
  if (unmarked.length && firstMarked) {
    return { pick: firstMarked, note: `${packaging} lot ${firstMarked.lot}, loading order 1 (other lots not marked: ${unmarked.join(', ')})` };
  }

  if (unmarked.length) {
    return { stop: `${unmarked.length} of ${lotNumbers.length} lots are not marked yet (${unmarked.join(', ')}) — mark bagged/bulk and loading order in Lots`, needsMarking: true };
  }

  const ofKind = candidates
    .filter(c => markOf(c).packaging === packaging)
    .sort((a, b) => markOf(a).priority - markOf(b).priority || heaviestFirst(a, b));
  if (!ofKind.length) return { stop: `no lot is marked ${packaging}`, needsMarking: true };

  const pick = ofKind.find(c => c.weightKg >= grossKg);
  if (!pick) return { stop: `the ${packaging} lots have less than the ${grossKg} kg this truck needs left`, needsMarking: true };

  const first = ofKind[0];
  const note = pick.lot === first.lot
    ? `${packaging} lot ${pick.lot}, loading order ${markOf(pick).priority}`
    : `${packaging} lot ${pick.lot} — lot ${first.lot} (loading order ${markOf(first).priority}) has only ${first.weightKg} kg left, under one truck`;
  return { pick, note };
}

module.exports = { listMarks, setMark, removeMark, addPending, clearPending, chooseLot, PACKAGING };
