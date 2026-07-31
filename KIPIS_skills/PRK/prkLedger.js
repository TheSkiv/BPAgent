const { normalizePlate, listOrders } = require('../../src/core/orderStore');

const DRAFT_STATUS = 'Ruošiamas';

// "260720-005405-PRK" → "2026-07-20". The document number encodes its creation date.
function docDate(number) {
  const m = String(number).match(/^(\d{2})(\d{2})(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : '';
}

// "Autotransportas\nNIA261//FD450" → { transport: 'Autotransportas', plate: 'NIA261//FD450' }
function splitLoadTo(cell) {
  const lines = String(cell || '').split('\n').map(s => s.trim()).filter(Boolean);
  return { transport: lines[0] || '', plate: lines.slice(1).join(' ') };
}

// Applies RULES.md Rule 7. A document is deletable ONLY if every condition holds.
// `ourEmployee` is the KIPIS account PortSystem logs in as; `today` is YYYY-MM-DD.
function findDeletable(docs, { ourEmployee, today, orders }) {
  const orderList = orders || listOrders();

  // Plates PortSystem itself filed today — our ledger is the authority for "we created it",
  // because KIPIS attributes machine and human documents to the same login account.
  const oursToday = new Set(
    orderList
      .filter(o => o.docs && o.docs.PRK)
      .map(o => o.plateNorm)
  );

  return docs.map(d => {
    const reasons = [];
    if (d.status !== DRAFT_STATUS)                 reasons.push(`status is "${d.status}", not ${DRAFT_STATUS}`);
    if (ourEmployee && d.employee !== ourEmployee) reasons.push(`belongs to ${d.employee}`);
    if (today && d.created !== today)              reasons.push(`created ${d.created}, not today`);
    if (!oursToday.has(d.plateNorm))               reasons.push('no matching PortSystem order today');
    return { ...d, deletable: reasons.length === 0, blockedBy: reasons };
  });
}

module.exports = { findDeletable, docDate, splitLoadTo, DRAFT_STATUS };
