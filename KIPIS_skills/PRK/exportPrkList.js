const { getPage } = require('../../src/core/browser');
const { splitLoadTo, docDate, DRAFT_STATUS } = require('./prkLedger');
const { normalizePlate } = require('../../src/core/orderStore');

const MAX_LIMIT = 500; // 500 covers a full day's volume; do not raise without checking memory impact

// Reads the PRK list straight from the rendered table — no download round-trip. Proven against
// a live Ruošiamas draft: catches it, and DOM-vs-XLS agreed before the XLS path was dropped as
// unnecessary complexity (KIPIS-skills/PRK/steps.md).
async function readPrkListFromDom(page) {
  const raw = await page.evaluate(() => {
    const line = el => (el.innerText || el.textContent || '')
      .split('\n').map(s => s.trim()).filter(Boolean).join('\n');

    const table = [...document.querySelectorAll('table')]
      .reverse()
      .find(t => /KIPIS\s*numeris/i.test(t.textContent || ''));
    if (!table) return { error: 'PRK table not found on page' };

    // Scope to :scope so a nested table inside a cell cannot inflate the row count.
    const headRows = [...table.querySelectorAll(':scope > thead > tr')];
    const leaf     = headRows.length ? headRows[headRows.length - 1] : null;
    const headers  = leaf ? [...leaf.children].map(th => line(th).replace(/\n/g, ' ')) : [];
    const rows     = [...table.querySelectorAll(':scope > tbody > tr')].map(tr => [...tr.children].map(line));

    const limitInput = document.querySelector('[id$=":limit"]');
    const limitField  = limitInput ? Number(limitInput.value) || 0 : 0;

    return { headers, rows, headRowCount: headRows.length, limitField };
  });

  if (raw.error) throw new Error(raw.error);

  const idx = re => raw.headers.findIndex(h => re.test(h));

  // "Krauti iš" and "Krauti į" differ by one accented character. A loose class (e.g. [įi])
  // makes "iš" win both columns. Identify the pair instead: whichever contains "iš" is the
  // source, the other is the destination — this is what previously mis-read the plate.
  const krauti  = raw.headers.map((h, i) => ({ h, i })).filter(x => /^\s*Krauti\b/i.test(x.h));
  const fromCol = krauti.find(x => /i[šs]/i.test(x.h));
  const toCol   = krauti.find(x => x !== fromCol);

  const col = {
    number:   idx(/KIPIS\s*numeris/i),
    status:   idx(/B[ūu]sena/i),
    loadFrom: fromCol ? fromCol.i : -1,
    loadTo:   toCol   ? toCol.i   : -1,
    weight:   idx(/Svoris/i),
    employee: idx(/Atsakingas/i),
  };
  if (col.number === -1 || col.status === -1) {
    throw new Error(`PRK table headers not recognised: ${JSON.stringify(raw.headers)}`);
  }
  if (col.loadTo === -1) {
    throw new Error(`Could not identify the "Krauti į" column: ${JSON.stringify(raw.headers)}`);
  }

  const at = (cells, i) => (i >= 0 && i < cells.length ? cells[i] : '');

  const docs = raw.rows
    .filter(cells => cells.length === raw.headers.length && /-PRK\b/i.test(at(cells, col.number)))
    .map(cells => {
      const { transport, plate } = splitLoadTo(at(cells, col.loadTo));
      const number = at(cells, col.number).replace(/\s+/g, '');
      return {
        number,
        status:    at(cells, col.status),
        created:   docDate(number),
        transport,
        plate,
        plateNorm: normalizePlate(plate),
        employee:  at(cells, col.employee).split(',')[0].trim(),
        loadFrom:  at(cells, col.loadFrom).replace(/\n/g, ' '),
        weight:    at(cells, col.weight),
      };
    });

  // KIPIS's own "Maks. įrašų skaičius" field caps how many records the query returns
  // server-side. Matching exactly that many rows means the true total is very likely higher
  // and the tail is invisible to us — a truncation, not a coincidence.
  const truncated = raw.limitField > 0 && docs.length >= raw.limitField;

  return {
    docs, headers: raw.headers, headRowCount: raw.headRowCount,
    rawRowCount: raw.rows.length, limitField: raw.limitField, truncated,
  };
}

// KIPIS navigation is stateful JSF — a direct URL lands on Pranešimai, not the list. Reach it
// the way a human does: the left-hand shortcut, falling back to Krova → Prašymai krovai.
async function navigateToPrkList(page) {
  const shortcut = page.locator('a:has-text("Prašymai krovai")').first();
  if (await shortcut.count().catch(() => 0) && await shortcut.isVisible().catch(() => false)) {
    await shortcut.click();
    await page.waitForLoadState('networkidle');
    if (/pra[sš]ymai\s+krovai/i.test(await page.title())) return 'shortcut';
  }

  await page.locator('text=Krova').first().click();
  await page.waitForLoadState('networkidle');
  await page.locator('text="Prašymai krovai"').first().click();
  await page.waitForLoadState('networkidle');
  return 'top-menu';
}

async function setLimitAndFilter(page, limit) {
  const limitInput = page.locator('[id$=":limit"]');
  await limitInput.waitFor({ state: 'visible', timeout: 10000 });
  await limitInput.fill(String(limit));
  await page.locator('input[type="submit"][value="Filtruoti/Atnaujinti"]').click();
  await page.waitForLoadState('networkidle');
}

// Navigates to the list and applies the starting row limit.
async function openPrkList({ limit = 500 } = {}) {
  const page = getPage();

  const how = await navigateToPrkList(page);
  const title = await page.title();
  if (!/pra[sš]ymai\s+krovai/i.test(title)) {
    throw new Error(`Unexpected page after navigation via ${how}: "${title}"`);
  }
  console.log(`PRK list: reached via ${how}`);

  await setLimitAndFilter(page, limit);
  return page;
}

// Navigates, reads, and re-queries with a higher limit if the first read was truncated —
// never silently returns an incomplete list.
async function readFullPrkList({ limit = 500 } = {}) {
  const page = await openPrkList({ limit });
  let current = limit;
  let result  = await readPrkListFromDom(page);

  while (result.truncated && current < MAX_LIMIT) {
    current = Math.min(current * 4, MAX_LIMIT);
    console.warn(`PRK list: truncated at ${result.docs.length} rows — retrying with limit=${current}`);
    await setLimitAndFilter(page, current);
    result = await readPrkListFromDom(page);
  }

  if (result.truncated) {
    throw new Error(`PRK list still truncated at the maximum limit (${MAX_LIMIT}) — cannot read the full list.`);
  }

  const drafts = result.docs.filter(d => d.status === DRAFT_STATUS);
  console.log(`PRK list: ${result.docs.length} document(s) read (limit=${current}), ${drafts.length} in ${DRAFT_STATUS}`);
  return { ...result, drafts, limitUsed: current };
}

module.exports = { readPrkListFromDom, navigateToPrkList, openPrkList, readFullPrkList };
