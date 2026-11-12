// The desk follows KIPIS's PRK list (owner, 2026-11-11) — see server.js "The desk matches KIPIS".
// listed: recentPrks() rows { number, status, transport, plate, plateNorm, created }.
// recordExistingPrk: server.js's helper (records a PRK a person made on an order). Returns what changed.
const orderStore = require('./orderStore');

const PRK_OPEN = /^(ruošiamas|pateiktas|patvirtintas)/i;
const PRK_LOADED = /^(atliktas|u[žz]baigtas)/i;
const PRK_ANNULLED = /^anuliuotas/i;

function applyKipisList(listed, { recordExistingPrk }) {
  const days = [orderStore.daysAgo(0), orderStore.daysAgo(1)];
  const orders = () => days.flatMap(d => orderStore.listOrders(d));
  const changed = [];
  for (const doc of listed) {
    if (!/autotransport/i.test(doc.transport || '') || !doc.plateNorm) continue;
    const status = String(doc.status || '').split('\n')[0].trim();
    const all = orders();
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
    const open = all.filter(o => !orderStore.CLOSED_STATES.includes(o.state) && o.plateNorm && doc.plateNorm.includes(o.plateNorm)
      && doc.created >= (orderStore.dateOf(o.id) || ''));
    if (open.length) {
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
    // An open PRK for a truck PortSystem does not have at all (not even closed/cancelled today)
    if (!PRK_OPEN.test(status)) continue;
    if (all.some(o => o.plateNorm && doc.plateNorm.includes(o.plateNorm) && doc.created >= (orderStore.dateOf(o.id) || ''))) continue;
    const created = orderStore.ensureOrder({
      plate: doc.plate || doc.plateNorm.toUpperCase(), sender: 'KIPIS', messageId: `kipis:${doc.number}`,
      subject: `PRK ${doc.number} — made in KIPIS by a person`, state: /^ruošiamas/i.test(status) ? 'drafted' : 'submitted',
    });
    if (created && !created.docs?.PRK?.number) {
      orderStore.attachDocument(created.id, { type: 'PRK', number: doc.number, status }, { actor: 'kipis' });
      changed.push(`${created.plate}: from KIPIS (${doc.number} ${status})`);
    }
  }
  return changed;
}

module.exports = { applyKipisList, PRK_OPEN, PRK_LOADED, PRK_ANNULLED };
