const fs   = require('fs');
const path = require('path');
const { assertNotPateikti } = require('../safePage');

// Deleting PortSystem's unused PRK drafts (`Šalinti`) — RULES.md Rule 7, steps.md "Deleting a
// saved draft". Operator, 2026-11-10: a dashboard button deletes every Ruošiamas draft PortSystem
// filed for trucks due today or earlier; the press is the approval, every deletion is logged.

const DRAFT_STATUS = 'Ruošiamas';
const REASON = 'PortSystem: nepanaudotas juodraštis (sunkvežimis neatvyko)';

// "Prašymas krovai: 261110-003786-PRK, Ruošiamas, Saugojimo vieta -> Autotransportas"
async function readDocHeader(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  const m = text.match(/Prašymas krovai:\s*(\d{6}-\d{6}-PRK)\s*,\s*([^,\n]+)/);
  return m ? { number: m[1], status: m[2].trim() } : null;
}

// Opens a document by its number through KIPIS's "Universali paieška" (on every page): the
// magnifier button shows the dialog, the number goes in, "Ieškoti" opens it. Read-only.
async function openDocument(page, number) {
  await page.locator('input.ieskojimoMygtukas').first().click();
  const input = page.locator('[id$=":ieskomasNumeris"]');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(number);
  await input.press('Tab');                      // its onchange posts the value (AJAX)
  await page.waitForLoadState('networkidle');
  await page.locator('[id$=":paieskosMygtukas"]').click();
  await page.waitForLoadState('networkidle');
  return readDocHeader(page);
}

// Deletes one Ruošiamas draft. Pateikti and Šalinti are siblings differing only by an index
// (…:_id4598:0:_id4599 = Pateikti, …:1:… = Šalinti) and their _id numbers change per session, so:
// read the visible Pateikti's name, derive the :1: sibling, and click it only if its label is
// exactly "Šalinti". Same for the confirmation dialog. Anything unexpected → throw, nothing clicked.
async function deleteDraft(page, number) {
  const before = await openDocument(page, number);
  if (!before || before.number !== number) throw new Error(`${number}: search did not open it (page shows ${before ? before.number : 'no PRK'})`);
  if (before.status !== DRAFT_STATUS) throw new Error(`${number}: status is "${before.status}", not ${DRAFT_STATUS} — not deleted`);

  const pateikti = page.locator('input[type="button"][value="Pateikti"]:visible');
  if (await pateikti.count() !== 1) throw new Error(`${number}: expected one visible Pateikti button, found ${await pateikti.count()}`);
  const pName = await pateikti.getAttribute('name');
  const m = String(pName).match(/^(.*):0:([^:]+)$/);
  if (!m) throw new Error(`${number}: Pateikti button name "${pName}" is not the mapped …:0:… form`);
  const prefix = `${m[1]}:1:`;

  const salinti = page.locator(`input[name="${prefix}${m[2]}"]`);
  if (await salinti.count() !== 1 || await salinti.getAttribute('value') !== 'Šalinti') {
    throw new Error(`${number}: the button next to Pateikti is not "Šalinti" — not deleted`);
  }
  await assertNotPateikti(salinti);
  await salinti.click();

  // "Patvirtinkite operacijos vykdymą": reason + Šalinti, named under the same :1: prefix.
  const confirm = page.locator(`input[type="submit"][name^="${prefix}old:"][value="Šalinti"]`);
  await confirm.waitFor({ state: 'visible', timeout: 10000 });
  const reason = page.locator(`textarea[name^="${prefix}old:"]`);
  if (await reason.count() && await reason.first().isVisible()) await reason.first().fill(REASON);
  await assertNotPateikti(confirm);
  await confirm.click();
  await page.waitForLoadState('networkidle');

  const after = await readDocHeader(page);
  if (after && after.number === number && after.status === DRAFT_STATUS) {
    throw new Error(`${number}: still shows ${DRAFT_STATUS} after Šalinti — check it in KIPIS`);
  }
  return { number, statusBefore: before.status, statusAfter: after && after.number === number ? after.status : '(gone)' };
}

const AUDIT_PATH = path.resolve(__dirname, '../../data/prk_deletions.jsonl');
function audit(entry) {
  fs.appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// The dashboard button. Reads KIPIS's PRK list (never truncated — readFullPrkList re-queries
// past the row cap), keeps the Ruošiamas drafts PortSystem itself saved for orders of today or
// earlier (orderStore.prkNumbersFiled — a person's draft is never on that list, and an order file
// is never later than today), and deletes them one by one. Each deletion is logged and closes its
// order. The first failure stops the sweep: the page may be in an unknown state.
async function sweepDrafts(page) {
  const { readFullPrkList } = require('./exportPrkList');
  const orderStore = require('../../src/core/orderStore');

  const ours = orderStore.prkNumbersFiled();
  const { drafts } = await readFullPrkList({ limit: 500 });
  const targets = drafts.filter(d => ours.has(d.number));
  console.log(`PRK sweep: ${drafts.length} ${DRAFT_STATUS} draft(s) in KIPIS, ${targets.length} filed by PortSystem`);

  const deleted = [], failed = [];
  for (const d of targets) {
    const o = ours.get(d.number);
    try {
      const r = await deleteDraft(page, d.number);
      audit({ action: 'Šalinti', number: d.number, plate: o.plate, orderId: o.orderId, orderDate: o.date, statusBefore: r.statusBefore, statusAfter: r.statusAfter, by: 'dashboard button' });
      orderStore.attachDocument(o.orderId, { type: 'PRK', number: d.number, status: 'Ištrintas (Šalinti)' }, { actor: 'operator', date: o.date });
      orderStore.setState(o.orderId, 'cancelled', { actor: 'operator', detail: `PRK draft ${d.number} deleted (Šalinti) — not used`, date: o.date });
      console.log(`PRK sweep: deleted ${d.number} (${o.plate})`);
      deleted.push({ number: d.number, plate: o.plate });
    } catch (err) {
      audit({ action: 'Šalinti FAILED', number: d.number, plate: o.plate, orderId: o.orderId, error: err.message, by: 'dashboard button' });
      console.error(`PRK sweep: ${d.number} failed — ${err.message}`);
      failed.push({ number: d.number, plate: o.plate, error: err.message });
      break;
    }
  }
  return {
    deleted, failed,
    remaining: targets.length - deleted.length - failed.length,
    othersKept: drafts.length - targets.length,   // drafts PortSystem did not file — never touched
  };
}

module.exports = { openDocument, readDocHeader, deleteDraft, sweepDrafts, audit, DRAFT_STATUS };
