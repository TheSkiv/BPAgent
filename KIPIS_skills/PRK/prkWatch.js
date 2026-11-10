// ROADMAP A18: notice in KIPIS when the operator has pressed Pateikti on one of PortSystem's
// drafts. Reads the PRK list filtered by submission date (yesterday–today — a PRK is for today or
// tomorrow) and moves each of our drafted orders by its KIPIS status. Read-only in KIPIS.
//
//   Pateiktas / Patvirtintas → `submitted`: the dispatch email is still to be sent
//   Atliktas / Užbaigtas     → `done`: the truck is loaded
//   Anuliuotas               → `cancelled`
// A draft not in the list has not been submitted — left as it is.

const SUBMITTED = /^(pateiktas|patvirtintas)$/i;
const FINISHED  = /^(atliktas|u[žz]baigtas)$/i;
const ANNULLED  = /^anuliuotas$/i;

// The status cell can carry a second line ("Anuliuotas\nKLAIDA") — the first line is the status.
const firstLine = s => String(s || '').split('\n')[0].trim();

function localDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkSubmitted() {
  const { readFullPrkList } = require('./exportPrkList');
  const orderStore = require('../../src/core/orderStore');

  // Our drafts still waiting (and submitted ones, which can move on to done).
  const watched = [...orderStore.prkNumbersFiled({ maxAgeDays: 1 }).entries()]
    .filter(([, o]) => o.state === 'drafted' || o.state === 'submitted');
  const out = { submitted: [], done: [], cancelled: [], unchanged: 0, watched: watched.length };
  if (!watched.length) return out;

  const { docs } = await readFullPrkList({ limit: 500, dateFrom: localDate(1), dateTo: localDate(0) });
  const statusOf = new Map(docs.map(d => [d.number, firstLine(d.status)]));

  for (const [number, o] of watched) {
    const status = statusOf.get(number);
    let to = null;
    if (!status) to = null;
    else if (FINISHED.test(status))  to = 'done';
    else if (ANNULLED.test(status))  to = 'cancelled';
    else if (SUBMITTED.test(status)) to = 'submitted';
    if (!to || to === o.state) { out.unchanged++; continue; }

    orderStore.attachDocument(o.orderId, { type: 'PRK', number, status }, { actor: 'kipis', date: o.date });
    orderStore.setState(o.orderId, to, { actor: 'kipis', detail: `PRK ${number} is ${status} in KIPIS`, date: o.date });
    console.log(`PRK watch: ${o.plate} ${number} — ${status} → ${to}`);
    out[to].push({ plate: o.plate, number, status });
  }
  return out;
}

module.exports = { checkSubmitted };
