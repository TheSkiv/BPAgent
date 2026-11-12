// The desk follows KIPIS's PRK list for the trucks PortSystem has an email for (owner, 2026-11-11;
// trucks "from KIPIS" without an email dropped 2026-11-12) — see server.js "The desk matches KIPIS".
// listed: recentPrks() rows { number, status, transport, plate, plateNorm, created }.
// recordExistingPrk: server.js's helper (records a PRK a person made on an order). Returns what changed.
const orderStore = require('./orderStore');

const PRK_OPEN = /^(ruošiamas|pateiktas|patvirtintas)/i;
const PRK_LOADED = /^(atliktas|u[žz]baigtas)/i;
const PRK_ANNULLED = /^anuliuotas/i;
const PRK_SUBMITTED = /^(pateiktas|patvirtintas)/i;

// The order's PRK is PortSystem's own draft, still Ruošiamas (Rule 7 condition 2: saved by us).
const ourOpenDraft = o => {
  const n = o.docs?.PRK?.number;
  return !!n && /^ruošiamas/i.test(o.docs.PRK.status || '')
    && (o.history || []).some(h => /PRK draft saved/.test(h.detail || '') && (h.detail || '').includes(n));
};

function applyKipisList(listed, { recordExistingPrk }) {
  const days = [orderStore.daysAgo(0), orderStore.daysAgo(1)];
  const orders = () => days.flatMap(d => orderStore.listOrders(d));
  const changed = [];
  const superseded = [];   // our draft numbers a colleague's PRK replaced this run
  for (const doc of listed) {
    if (!/autotransport/i.test(doc.transport || '') || !doc.plateNorm) continue;
    const status = String(doc.status || '').split('\n')[0].trim();
    const all = orders();
    if (all.some(o => o.ourDraft?.number === doc.number)) continue;   // our replaced draft: the sweep deletes it
    const own = all.find(o => o.docs?.PRK?.number === doc.number);
    if (own) {
      if (own.docs.PRK.status !== status) {
        orderStore.attachDocument(own.id, { type: 'PRK', number: doc.number, status }, { actor: 'kipis', date: orderStore.dateOf(own.id) });
        changed.push(`${own.plate}: ${doc.number} ${status}`);
      }
      if (PRK_LOADED.test(status) && !orderStore.CLOSED_STATES.includes(own.state) && own.state !== 'to_print') {
        orderStore.setState(own.id, 'done', { actor: 'kipis', detail: `PRK ${doc.number} is ${status} in KIPIS — loaded`, date: orderStore.dateOf(own.id) });
        changed.push(`${own.plate}: loaded`);
      }
      if (PRK_ANNULLED.test(status) && own.email?.from === 'KIPIS' && own.state !== 'cancelled') {
        orderStore.setState(own.id, 'cancelled', { actor: 'kipis', detail: `PRK ${doc.number} annulled in KIPIS`, date: orderStore.dateOf(own.id) });
        changed.push(`${own.plate}: annulled`);
      }
      continue;
    }
    // A PRK made by a person for open trucks of ours (repeated bulk emails can leave the same
    // truck open more than once — NND844, LID098, MOU324 on 2026-11-10: all of them close)
    // S41, a truck already done (closed by hand, or by the terminal's copy) that still has our
    // Ruošiamas draft, while a colleague's PRK for it is submitted or loaded: our draft goes too.
    // The truck stays where it is.
    if (PRK_SUBMITTED.test(status) || PRK_LOADED.test(status)) {
      const closed = all.find(o => o.state === 'done' && ourOpenDraft(o) && o.plateNorm && doc.plateNorm.includes(o.plateNorm)
        && doc.created >= (orderStore.dateOf(o.id) || ''));
      if (closed) {
        const draft = closed.docs.PRK.number;
        orderStore.supersedeDraft(closed.id, { number: doc.number, status }, { date: orderStore.dateOf(closed.id) });
        changed.push(`${closed.plate}: done on a colleague's ${doc.number} (${status}); our draft ${draft} to delete`);
        superseded.push(draft);
      }
    }
    const open = all.filter(o => !orderStore.CLOSED_STATES.includes(o.state) && o.plateNorm && doc.plateNorm.includes(o.plateNorm)
      && doc.created >= (orderStore.dateOf(o.id) || ''));
    if (open.length) {
      // S41 (owner, 2026-11-12): a colleague filed and submitted their own PRK for a truck we had
      // a Ruošiamas draft for. The truck takes their PRK and moves on (Email, or Print for bulk);
      // our draft is deleted by the sweep that follows (RULES.md Rule 7). Loaded already → done below.
      if (PRK_SUBMITTED.test(status) || PRK_LOADED.test(status)) {
        const ours = open.find(ourOpenDraft);
        if (ours) {
          const draft = ours.docs.PRK.number;
          orderStore.supersedeDraft(ours.id, { number: doc.number, status }, { date: orderStore.dateOf(ours.id) });
          if (PRK_SUBMITTED.test(status)) {
            orderStore.setState(ours.id, 'submitted', { actor: 'kipis', detail: `${doc.number} (${status}) — a colleague's PRK; our draft ${draft} goes`, date: orderStore.dateOf(ours.id) });
          }
          changed.push(`${ours.plate}: on a colleague's ${doc.number} (${status}); our draft ${draft} to delete`);
          superseded.push(draft);
          if (PRK_SUBMITTED.test(status)) continue;
        }
      }
      if (PRK_LOADED.test(status)) {
        for (const o of open) {
          orderStore.setState(o.id, 'done', { actor: 'kipis', detail: `loaded on ${doc.number} (${status}) — a PRK made by a person${o.docs?.PRK?.number ? `; our draft ${o.docs.PRK.number} is not needed` : ''}`, date: orderStore.dateOf(o.id), noPrint: true });
          changed.push(`${o.plate}: loaded on ${doc.number}`);
        }
      } else if (PRK_OPEN.test(status)) {
        const first = open.find(o => !o.docs?.PRK?.number && o.state !== 'filing');
        if (first) {
          recordExistingPrk(first, first.plate, `${doc.number} (${status})`);
          changed.push(`${first.plate}: ${doc.number} made by a person`);
        }
      }
      continue;
    }
    // A PRK for a truck PortSystem has no email for is NOT turned into a truck (owner, 2026-11-12:
    // "we don't pull PRKs from KIPIS if we don't have a matching email" — reverses the "from
    // KIPIS" trucks of 2026-11-11, S32).
  }
  return Object.assign(changed, { superseded });
}

module.exports = { applyKipisList, ourOpenDraft, PRK_OPEN, PRK_LOADED, PRK_ANNULLED, PRK_SUBMITTED };
