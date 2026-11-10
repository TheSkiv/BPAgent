const fs   = require('fs');
const path = require('path');
const { sameCargo, matchingRows } = require('./stockCache');

// Every KIPIS lot (shipment number, e.g. 260924-001330-L) a run or a scan has seen in our storage,
// with its owner. KIPIS does not show ownership and a lot can hold BB and bulk across both
// terminals (operator, 2026-11-10), so the owner is the one fact the operator confirms — once per
// lot, on the Lots page, from a suggestion (see suggestOwners). Replaces the bagged/bulk lot marks.
const REGISTRY_PATH  = path.resolve(__dirname, '../../config/lots.json');
const OLD_MARKS_PATH = path.resolve(__dirname, '../../config/lot_marks.json');
const MATCH_TOLERANCE = 0.10;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return { lots: Array.isArray(d.lots) ? d.lots : [] };
  } catch {
    // First run: carry over the loading orders from the old marks file.
    let old = [];
    try { old = JSON.parse(fs.readFileSync(OLD_MARKS_PATH, 'utf8')).lots || []; } catch { /* none */ }
    return { lots: old.filter(m => m.packaging !== 'offspec').map(m => ({
      lot: m.lot, vessel: m.vessel || '', name: m.cargo || '', weightKg: m.weightKg || 0, trucksLoading: 0,
      seenAt: m.markedAt || '', owner: '', confirmedAt: '', priority: m.priority || null,
    })) };
  }
}

function save(d) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(d, null, 1));
}

function listLots() {
  return load().lots;
}

// candidates: storage rows from a KIPIS search — { lot, vessel, name, weightKg, trucksLoading }.
// A lot can have several storage rows (both terminals): its weight is their sum.
function recordSeen(candidates) {
  const byLot = new Map();
  for (const c of candidates) {
    const e = byLot.get(c.lot) || { lot: c.lot, vessel: c.vessel, name: c.name, weightKg: 0, trucksLoading: c.trucksLoading || 0 };
    e.weightKg += c.weightKg || 0;
    byLot.set(c.lot, e);
  }
  if (!byLot.size) return;
  const d = load();
  const now = new Date().toISOString();
  for (const seen of byLot.values()) {
    const i = d.lots.findIndex(l => l.lot === seen.lot);
    if (i === -1) d.lots.push({ ...seen, seenAt: now, owner: '', confirmedAt: '', priority: null });
    else d.lots[i] = { ...d.lots[i], ...seen, vessel: seen.vessel || d.lots[i].vessel, seenAt: now };
  }
  save(d);
}

// The operator's confirmation for some of a vessel's lots: [{ lot, owner, priority }].
function confirmLots(entries) {
  const d = load();
  const now = new Date().toISOString();
  for (const { lot, owner, priority } of entries) {
    const l = d.lots.find(x => x.lot === lot);
    if (!l) continue;
    const prio = priority === '' || priority == null ? null : Number(priority);
    if (prio !== null && (!Number.isInteger(prio) || prio < 1)) throw new Error(`Lot ${lot}: loading order must be a whole number from 1`);
    l.owner = String(owner || '').trim();
    l.confirmedAt = l.owner ? now : '';
    l.priority = prio;
  }
  save(d);
}

function removeLot(lot) {
  const d = load();
  const before = d.lots.length;
  d.lots = d.lots.filter(l => l.lot !== lot);
  save(d);
  return d.lots.length !== before;
}

// A self-loader's confirmed lots of a cargo — they give its vessels (it is in no stock report).
function ownLotsOf(company, cargo) {
  return load().lots.filter(l => l.owner === company && l.confirmedAt && sameCargo(cargo, l.name));
}

// Suggested owner per lot of one vessel. Each seller's stock-report total for a product — all
// packaging, both terminals — is matched to the lot with the closest weight (±10 %): ULSAN AS,
// Helm 5 842 t KKT + 54 t RoRo = 5 896 t ↔ lot 260925-000458-L 5 920 t. The vessel's other lots
// belong to cargo we have no list for: with exactly one self-loader that is theirs.
function suggestOwners(vesselLots, stockRows, sellers, selfLoaders) {
  const out = new Map();
  if (!vesselLots.length) return out;
  const vessel = vesselLots[0].vessel.toLowerCase();
  const rowsHere = stockRows.filter(r => r.vessel.toLowerCase() === vessel);

  for (const s of sellers) {
    const sellerRows = rowsHere.filter(r => r.report === s.stockReport);
    const products = [...new Set(sellerRows.map(r => r.produktas))];
    for (const product of products) {
      const group = sellerRows.filter(r => r.produktas === product);
      const total = group.reduce((sum, r) => sum + r.netto, 0);
      const lots  = vesselLots.filter(l => !out.has(l.lot) && (sameCargo(product, l.name) || matchingRows(l.name, group).length));
      let best = null, bestDiff = Infinity;
      for (const l of lots) {
        const diff = Math.abs(l.weightKg - total) / Math.max(l.weightKg, total, 1);
        if (diff < bestDiff) { best = l; bestDiff = diff; }
      }
      if (best && bestDiff <= MATCH_TOLERANCE) out.set(best.lot, s.name);
    }
  }
  // Only when a seller's lot on this vessel was found: then its share is accounted for and the
  // rest is someone else's. Without one, a lot may just be a seller's whose report has drifted
  // (HEINZ Urea: one 5 529 t lot, Helm's report 2 871 t — it is Helm's) — no suggestion then.
  if (selfLoaders.length === 1 && out.size) {
    for (const l of vesselLots) if (!out.has(l.lot)) out.set(l.lot, selfLoaders[0]);
  }
  return out;
}

// Which lot an order loads from. candidates: storage rows { i, lot, vessel, name, weightKg,
// trucksLoading }; owner: from owners.resolveOrder. Every candidate lot's owner must be confirmed —
// an unconfirmed lot could be this owner's lot already being loaded. Among the owner's lots:
// the operator's loading order, else the lot trucks are already loading from (one lot is cleaned
// out before the next), else the oldest lot number — the first that still holds the truck.
function chooseLot(candidates, owner, grossKg) {
  if (!candidates.length) {
    return { stop: 'no lot of this cargo is in our storage places (Ro-Ro or Konteinerių terminalas)', needsOwners: false };
  }
  const reg = new Map(load().lots.map(l => [l.lot, l]));
  const lotNumbers = [...new Set(candidates.map(c => c.lot))];
  const unconfirmed = lotNumbers.filter(lot => !(reg.get(lot) || {}).confirmedAt);
  if (unconfirmed.length) {
    return { stop: `owner not confirmed for ${unconfirmed.length} lot(s) (${unconfirmed.join(', ')}) — confirm them on the Lots page`, needsOwners: true };
  }

  const mine = lotNumbers.filter(lot => reg.get(lot).owner === owner);
  if (!mine.length) return { stop: `none of these lots is ${owner}'s (${lotNumbers.map(l => `${l}: ${reg.get(l).owner}`).join(', ')})`, needsOwners: true };

  const rowsOf = lot => candidates.filter(c => c.lot === lot).sort((a, b) => b.weightKg - a.weightKg);
  const ranked = mine.sort((a, b) => {
    const pa = reg.get(a).priority ?? Infinity, pb = reg.get(b).priority ?? Infinity;
    return pa - pb || rowsOf(b)[0].trucksLoading - rowsOf(a)[0].trucksLoading || a.localeCompare(b);
  });
  for (const lot of ranked) {
    const pick = rowsOf(lot)[0];
    if (pick.weightKg < grossKg) continue;
    const l = reg.get(lot);
    const why = l.priority != null ? `loading order ${l.priority}`
      : pick.trucksLoading ? `already loading (${pick.trucksLoading})`
      : 'oldest lot';
    const skipped = ranked.slice(0, ranked.indexOf(lot));
    return { pick, note: `${owner}'s lot ${lot} — ${why}${skipped.length ? `; skipped ${skipped.join(', ')} (under one truck left)` : ''}` };
  }
  return { stop: `${owner}'s lots have less than the ${grossKg} kg this truck needs left (${ranked.join(', ')})`, needsOwners: false };
}

module.exports = { listLots, recordSeen, confirmLots, removeLot, ownLotsOf, suggestOwners, chooseLot };
