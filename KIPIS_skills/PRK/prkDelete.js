const fs   = require('fs');
const path = require('path');
const { assertNotPateikti } = require('../safePage');

// Deleting PortSystem's unused PRK drafts (`Šalinti`) — RULES.md Rule 7, steps.md "Deleting a
// saved draft". Operator, 2026-11-10: a PRK is always for today or tomorrow, so once a day the
// server deletes every Ruošiamas draft PortSystem filed for an order 2+ days old — no button to
// forget. Every deletion is logged.
const CLEANUP_MIN_AGE_DAYS = 2;

const DRAFT_STATUS = 'Ruošiamas';
const REASON = 'PortSystem: nepanaudotas juodraštis (sunkvežimis neatvyko)';

// "Prašymas krovai: 261110-003786-PRK, Ruošiamas, Saugojimo vieta -> Autotransportas"
async function readDocHeader(page) {
  // document.body directly: a strict locator('body') failed (silently, via the catch) on pages
  // with a second <body> inside them, and the header read as missing (seen 2026-11-10).
  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const m = text.match(/Prašymas krovai:\s*(\d{6}-\d{6}-PRK)\s*,\s*([^,\n]+)/);
  return m ? { number: m[1], status: m[2].trim() } : null;
}

// The header renders after the load event settles — read it only once it names this document
// (seen 2026-11-10: read too early, the header of an open draft came back empty).
async function waitForHeader(page, number, timeout = 15000) {
  await page.getByText(new RegExp(`Prašymas krovai:\\s*${number}`)).first().waitFor({ timeout }).catch(() => {});
  return readDocHeader(page);
}

// Opens a document by its number through KIPIS's "Universali paieška" (on every page): the
// magnifier button shows the dialog, the number goes in, "Ieškoti" opens it. Read-only.
// Not used for deleting: its two quick submits (Tab posts the number, Ieškoti submits the form)
// sometimes get KIPIS's "Užklausa negalioja…" error page (seen 2026-11-10).
async function openDocument(page, number) {
  await page.locator('input.ieskojimoMygtukas').first().click();
  const input = page.locator('[id$=":ieskomasNumeris"]');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(number);
  await input.press('Tab');                      // its onchange posts the value (AJAX)
  await page.waitForLoadState('networkidle');
  await page.locator('[id$=":paieskosMygtukas"]').click();
  await page.waitForLoadState('networkidle');
  return waitForHeader(page, number);
}

// Opens a draft the way a person does: the PRK list filtered to Ruošiamas, then its number (a
// link in the "KIPIS numeris" column). Also proves, right before deleting, that KIPIS still
// lists it as Ruošiamas.
async function openFromDraftList(page, number) {
  return openFromList(page, number, { statuses: [DRAFT_STATUS] }, `KIPIS's ${DRAFT_STATUS} list`);
}

// Any PRK from the list, filtered by `listOpts` (statuses / submission dates — exportPrkList).
async function openFromList(page, number, listOpts, what = 'the PRK list') {
  const { openPrkList } = require('./exportPrkList');
  await openPrkList({ limit: 500, ...listOpts });
  const link = page.locator('a', { hasText: new RegExp(`^\\s*${number}\\s*$`) });
  const count = await link.count();
  if (count !== 1) throw new Error(`${number}: ${count ? `${count} links` : 'not'} in ${what}`);
  await link.click();
  await page.waitForLoadState('networkidle');
  return waitForHeader(page, number);
}

// Deletes one Ruošiamas draft. Pateikti and Šalinti are siblings differing only by an index
// (…:_id4598:0:_id4599 = Pateikti, …:1:… = Šalinti) and their _id numbers change per session, so:
// read the visible Pateikti's name, derive the :1: sibling, and click it only if its label is
// exactly "Šalinti". Same for the confirmation dialog. Anything unexpected → throw, nothing clicked.
async function deleteDraft(page, number) {
  const before = await openFromDraftList(page, number);
  if (!before || before.number !== number) throw new Error(`${number}: the list link did not open it (page shows ${before ? before.number : 'no PRK'}) — not deleted`);
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
  await page.waitForTimeout(1500);   // let the page re-render before reading whether it is gone

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

// One of PortSystem's own drafts (Rule 7 condition 2: its number is in `ours`, from
// orderStore.prkNumbersFiled). Deletes, logs, closes the order; throws (logged) on any doubt.
async function deleteOurDraft(page, number, ours, by) {
  const orderStore = require('../../src/core/orderStore');
  ours = ours || orderStore.prkNumbersFiled();
  const o = ours.get(number);
  if (!o) throw new Error(`${number} was not saved by PortSystem — not deleted (RULES.md Rule 7)`);
  try {
    const r = await deleteDraft(page, number);
    audit({ action: 'Šalinti', number, plate: o.plate, orderId: o.orderId, orderDate: o.date, statusBefore: r.statusBefore, statusAfter: r.statusAfter, by });
    orderStore.attachDocument(o.orderId, { type: 'PRK', number, status: 'Ištrintas (Šalinti)' }, { actor: 'operator', date: o.date });
    orderStore.setState(o.orderId, 'cancelled', { actor: 'operator', detail: `PRK draft ${number} deleted (Šalinti) — not used`, date: o.date });
    console.log(`PRK delete: ${number} (${o.plate}) deleted — ${by}`);
    return { number, plate: o.plate };
  } catch (err) {
    audit({ action: 'Šalinti FAILED', number, plate: o.plate, orderId: o.orderId, error: err.message, by });
    console.error(`PRK delete: ${number} failed — ${err.message}`);
    throw err;
  }
}

// The daily cleanup (and its "run now" button). Reads KIPIS's PRK list filtered to Ruošiamas
// (never truncated — readFullPrkList re-queries past the row cap), keeps the drafts PortSystem
// itself saved for orders 2+ days old (orderStore.prkNumbersFiled — a person's draft is never on
// that list; today's and yesterday's are not on it either), and deletes them one by one. Each
// deletion is logged and closes its order. The first failure stops the sweep: the page may be
// in an unknown state.
// minAgeDays: 2 for the automatic daily run; the operator's "Run now" passes 0 — today's unused
// drafts too (operator, 2026-11-10). Other people's drafts are never on the list either way.
async function sweepDrafts(page, by = 'daily cleanup', { minAgeDays = CLEANUP_MIN_AGE_DAYS } = {}) {
  const { readFullPrkList } = require('./exportPrkList');
  const orderStore = require('../../src/core/orderStore');

  const ours = orderStore.prkNumbersFiled({ minAgeDays });
  const { drafts } = await readFullPrkList({ limit: 500, statuses: [DRAFT_STATUS] });
  const targets = drafts.filter(d => ours.has(d.number));
  console.log(`PRK cleanup: ${drafts.length} ${DRAFT_STATUS} draft(s) in KIPIS, ${targets.length} filed by PortSystem${minAgeDays ? ` for orders ${minAgeDays}+ days old` : ' (today\'s included)'}`);

  const deleted = [], failed = [];
  for (const d of targets) {
    try {
      deleted.push(await deleteOurDraft(page, d.number, ours, by));
    } catch (err) {
      failed.push({ number: d.number, plate: ours.get(d.number).plate, error: err.message });
      break;
    }
  }
  // Why the rest stayed, for the dashboard: PortSystem's own drafts still under the age limit,
  // and drafts other people made (never touched). A "0 deleted" read like a failure without it.
  await require('./exportPrkList').clearListFilters();   // the operator's list view, unfiltered again
  const ownAll = orderStore.prkNumbersFiled();
  const tooYoung = drafts.filter(d => ownAll.has(d.number) && !ours.has(d.number)).length;
  return {
    deleted, failed,
    remaining: targets.length - deleted.length - failed.length,
    tooYoung,
    othersKept: drafts.length - targets.length - tooYoung,   // drafts PortSystem did not file — never touched
  };
}

module.exports = { openDocument, openFromDraftList, openFromList, waitForHeader, readDocHeader, deleteDraft, deleteOurDraft, sweepDrafts, audit, DRAFT_STATUS, CLEANUP_MIN_AGE_DAYS };
