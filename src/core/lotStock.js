const { fetchStockRows, matchingRows } = require('./stockCache');

// Stock-report facts for the dashboard's Lots panel (operator, 2026-11-10): lots are chosen per
// vessel, and what helps is where a lot is stored (KKT / RoRo), its weight, and whether it is BB,
// bulk or off-spec. KIPIS shows none of the packaging; the stock reports do, per vessel and
// terminal. A KIPIS lot gets the packaging of the stock row in the same terminal whose weight is
// closest — only as the panel's preselected value; the operator still saves the mark.

const MATCH_TOLERANCE = 0.10;   // KIPIS lot vs stock netto: trucks already loaded make them drift

const packagingOf = s => /off-?spec/i.test(s) ? 'offspec' : /bulk/i.test(s) ? 'bulk' : /\bBB\b|kg/i.test(s) ? 'bagged' : '';
const terminalOf  = s => /kkt|konteineri/i.test(s) ? 'KKT' : /ro-?ro/i.test(s) ? 'RoRo' : '';

function suggestPackaging(terminal, weightKg, stock) {
  let best = null, bestDiff = Infinity;
  for (const s of stock) {
    if (s.terminal !== terminal || !s.packaging || !s.weightKg) continue;
    const diff = Math.abs(s.weightKg - weightKg) / Math.max(s.weightKg, weightKg);
    if (diff < bestDiff) { best = s; bestDiff = diff; }
  }
  return best && bestDiff <= MATCH_TOLERANCE ? best.packaging : '';
}

// pending: a lotMarks pending entry ({ cargo, plate, packaging, candidates }). Returns it with
// `vessels`: [{ vessel, discharged, stock: [{ packaging, terminal, weightKg }], lots: [...] }].
// Stock unavailable → same shape without stock facts or suggestions.
async function describePending(pending) {
  let stockRows = [];
  try { stockRows = await fetchStockRows(); } catch { /* stock app down — show KIPIS facts only */ }

  // One entry per lot: a lot can have several storage rows.
  const byLot = new Map();
  for (const c of pending.candidates || []) {
    const e = byLot.get(c.lot) || { lot: c.lot, vessel: c.vessel || '', name: c.name, place: c.place, terminal: terminalOf(c.place), weightKg: 0, trucksLoading: c.trucksLoading || 0 };
    e.weightKg += c.weightKg || 0;
    byLot.set(c.lot, e);
  }

  const vessels = new Map();
  for (const lot of byLot.values()) {
    if (!vessels.has(lot.vessel)) {
      const rows  = matchingRows(pending.cargo, stockRows.filter(r => r.vessel.toLowerCase() === lot.vessel.toLowerCase()));
      const stock = rows.map(r => ({ packaging: packagingOf(r.packaging), terminal: terminalOf(r.terminal), weightKg: r.netto }));
      const d = rows.length ? rows[0].discharged : null;   // local midnight — not toISOString (UTC shifts the day)
      const discharged = d && d.getTime() ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
      vessels.set(lot.vessel, { vessel: lot.vessel, discharged, stock, lots: [] });
    }
    const v = vessels.get(lot.vessel);
    v.lots.push({ ...lot, suggested: suggestPackaging(lot.terminal, lot.weightKg, v.stock) });
  }
  for (const v of vessels.values()) v.lots.sort((a, b) => b.weightKg - a.weightKg);

  return { ...pending, vessels: [...vessels.values()] };
}

module.exports = { describePending, packagingOf, terminalOf, suggestPackaging };
