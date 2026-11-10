// A submitted PRK's PDF, in memory, for the dispatch email (ROADMAP A19). The PRK is opened from
// the list (submission date yesterday–today), its header must name it, and "Spausdinti" (print)
// gives the PDF as a download — caught in memory, nothing kept on the PC (D10). Read-only in KIPIS.
const { captureDownload } = require('../../src/core/browser');
const { openFromList } = require('./prkDelete');
const { assertNotPateikti } = require('../safePage');

function localDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchPrkPdf(page, number) {
  const header = await openFromList(page, number, { dateFrom: localDate(1), dateTo: localDate(0) }, 'the submitted PRKs of yesterday–today');
  if (!header || header.number !== number) throw new Error(`${number}: the list link did not open it (page shows ${header ? header.number : 'no PRK'})`);

  const print = page.locator('input[type="submit"][value="Spausdinti"]:visible, input[type="button"][value="Spausdinti"]:visible');
  if (await print.count() !== 1) throw new Error(`${number}: expected one "Spausdinti" button, found ${await print.count()}`);
  await assertNotPateikti(print);
  const { filename, buffer } = await captureDownload(page, () => print.click());
  if (buffer.subarray(0, 4).toString() !== '%PDF') throw new Error(`${number}: "Spausdinti" gave ${filename}, not a PDF`);
  return { filename: filename || `${number}.pdf`, buffer, status: header.status };
}

module.exports = { fetchPrkPdf };
