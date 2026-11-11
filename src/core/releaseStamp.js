// The release number on the waybill (važtaraštis) before it is printed (owner, 2026-11-11): "for
// us and the client to know which release it belongs to". The waybill comes with the order email
// as a PDF; PortSystem adds one line below everything else on the page — unless the release is
// already on it (Linas Agro's slips print it as "Krovos numeris 2282853" for Helm 228285-3). The
// PDF is changed in memory only and shown for printing; nothing is stored on the PC.
const path            = require('path');
const owners          = require('./owners');
const senderCompanies = require('./senderCompanies');

// Leading zeros dropped: Avilda CMRs write Yara's invoice 620860510 as "Inv 0620860510".
const digits = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
// As the office writes it in the CMR's box 5 (owner's examples, 2026-11-11): Yara
// "Inv. 620860208 / DL 697212772 / Kont. 30289935"; Helm "Release 291568".
const SHORT = { Invoice: 'Inv.', Delivery: 'DL', Contract: 'Kont.', Release: 'Release' };
const releaseText = rel => rel.numbers.map(n => `${SHORT[n.label] || n.label} ${n.value}`).join(' / ');

// The releases an order can belong to. Filed orders recorded their release line (seller, buyer,
// vessel, product); others are matched like the filing does (company's buyer + cargo). One line
// can hold two releases (Linas Agro: TSP on OSLO CARRIER 2 is 228285-3 and 256589) — all are
// returned; the waybill itself, or the operator, says which. Own cargo has no release.
async function releasesFor(order) {
  if (order.loadsFrom?.source === 'own') return { own: true, releases: [] };
  const rows = await owners.fetchReleases();
  let mine;
  if (order.loadsFrom?.releaseKey) {
    mine = rows.filter(r => owners.releaseKey(r) === order.loadsFrom.releaseKey);
  } else {
    const company = senderCompanies.deriveCompany(order.email?.from || '');
    const { buyer } = owners.buyerFor(company, rows);
    mine = buyer ? rows.filter(r => r.buyer === buyer && owners.releaseMatches(order.cargo, r.product)) : [];
  }
  const seen = new Set();
  const releases = [];
  for (const r of mine) {
    if (!r.numbers.length) continue;
    const id = r.numbers.map(n => n.value).join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    releases.push({ id, seller: r.seller, vessel: r.vessel, product: r.product, remainingKg: r.remainingKg, numbers: r.numbers, text: releaseText(r) });
  }
  return { own: false, releases };
}

async function pdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

// Text of every page with positions (PDF points, y from the bottom).
async function readPages(buffer) {
  const { getDocument } = await pdfjs();
  const fonts = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';
  const doc = await getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: fonts, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { width, height } = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], h: Math.abs(i.transform[3]) || 10 }));
    pages.push({ width, height, items });
  }
  await doc.destroy();
  return pages;
}

// Is this release already printed on the document? A number counts when it stands on its own as
// a number token, dashes ignored ("228285-3" = "2282853"); never as part of a longer number.
function foundOn(pages, release) {
  const tokens = new Set();
  for (const p of pages) for (const i of p.items) for (const t of i.str.split(/[^\d-]+/)) if (digits(t).length >= 5) tokens.add(digits(t));
  return release.numbers.some(n => digits(n.value).length >= 5 && tokens.has(digits(n.value)));
}

// One bold line under the lowest text of the last page (a "1/1" page counter does not count),
// left-aligned with the page's text. No room below → above the top line instead.
async function stamp(buffer, release) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pages = await readPages(buffer);
  const last = pages[pages.length - 1];
  const body = last.items.filter(i => !/^\s*\d+\s*\/\s*\d+\s*$/.test(i.str) && !/^--.*--$/.test(i.str.trim()));
  const text = release.text;
  const size = 11;
  const left = body.length ? Math.min(...body.map(i => i.x)) : 40;
  const lowest = body.length ? Math.min(...body.map(i => i.y)) : last.height - 60;
  let y = lowest - size - 10;
  if (y < 18) y = Math.min(last.height - 16, (body.length ? Math.max(...body.map(i => i.y + i.h)) : last.height - 40) + 8);

  const pdf = await PDFDocument.load(buffer);
  const page = pdf.getPages()[pdf.getPageCount() - 1];
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText(text, { x: Math.max(18, left), y, size, font, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save());
}

// The waybill as it should be printed: already showing a release → unchanged; else with the
// chosen release (by id) stamped on. Returns { buffer, stamped, found }.
async function prepareWaybill(buffer, releases, chosenId) {
  const pages = await readPages(buffer);
  const found = releases.find(r => foundOn(pages, r));
  if (found) return { buffer, stamped: false, found };
  const release = releases.find(r => r.id === chosenId) || (releases.length === 1 ? releases[0] : null);
  if (!release) return { buffer, stamped: false, found: null };
  return { buffer: await stamp(buffer, release), stamped: release, found: null };
}

// For the order window: which of the order's releases each PDF already shows.
async function checkWaybill(buffer, releases) {
  const pages = await readPages(buffer);
  return releases.find(r => foundOn(pages, r)) || null;
}

module.exports = { releasesFor, prepareWaybill, checkWaybill, releaseText };
