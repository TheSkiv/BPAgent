// S57/S59: new plates for a truck — typed in its window, or sent in a reply in its email thread.
// The order, its row in today's orders Excel (the PRK filler reads the plates there) and the email
// stored under the plate all move to the new plates. When the truck already has PortSystem's own
// Ruošiamas PRK draft, the order is marked `plateAmend` and the server corrects the draft in KIPIS
// (server.js processPlateAmends). Returns changePlate's result plus { inExcel }.
const orderStore = require('./orderStore');
const { todayString } = require('./dateManager');

function applyPlateChange(id, plate, { actor = 'operator', why = '' } = {}) {
  const r = orderStore.changePlate(String(id), plate, { actor });
  if (r.error || r.unchanged) return r;
  const { renamePlate } = require('./ordersExcel');
  const inExcel = orderStore.dateOf(r.order.id) === todayString() && renamePlate(r.old, r.order.plate);
  const { saveEmailData, getEmailData } = require('./emailCache');
  const mail = getEmailData(r.old);
  if (mail) saveEmailData(r.order.plate, mail);
  console.log(`Plates changed: ${r.old} → ${r.order.plate} (${r.order.id}, ${actor}${why ? ': ' + why : ''})${inExcel ? '' : ' — not in today\'s orders Excel'}${r.needsAmend ? ` — PRK ${r.order.docs.PRK.number} to be corrected in KIPIS` : ''}`);
  return { ...r, inExcel };
}

module.exports = { applyPlateChange };
