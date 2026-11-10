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

// The "Būsenos" filter: a "..." button opens a dialog of status checkboxes
// (name "…:busenuTipai", e.g. Ruošiamas = value 1); "Pasirinkti" applies the choice. The whole
// list runs past KIPIS's 500-row cap (seen 2026-11-10), so the delete sweep reads Ruošiamas only.
// The choice stays set in KIPIS between reads, so every read sets it: [] = no status filter.
async function setStatusFilter(page, statuses) {
  await page.locator('input[type="button"][onclick*="busenu_tipai_filter"]').first().click();
  const dialog = page.locator('#busenu_tipai_filter');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const boxes = dialog.locator('input[type="checkbox"][name$=":busenuTipai"]');
  const labels = await boxes.evaluateAll(bs => bs.map(b => (b.parentElement.textContent || '').replace(/\s+/g, ' ').trim()));
  const wanted = statuses.map(s => s.toLowerCase());
  for (const s of wanted) if (!labels.some(l => l.toLowerCase() === s)) throw new Error(`PRK list: no status filter "${s}" (have: ${labels.join(', ')})`);
  for (let i = 0; i < labels.length; i++) {
    const box = boxes.nth(i);
    const want = wanted.includes(labels[i].toLowerCase());
    if (await box.isChecked() !== want) await box.setChecked(want);
  }
  await dialog.locator('input[type="submit"][value="Pasirinkti"]').click();
  await page.waitForLoadState('networkidle');
}

// "Pateikimo data" (submission date) from–to, YYYY-MM-DD; empty = no date filter. Set on every
// read for the same reason as the status filter.
async function setDateFilter(page, from = '', to = '') {
  await page.locator('[id$=":fNuo"]').fill(from);
  await page.locator('[id$=":fIki"]').fill(to);
}

// Navigates to the list and applies the filters (status, submission date) and the row limit.
async function openPrkList({ limit = 500, statuses = null, dateFrom = '', dateTo = '' } = {}) {
  const page = getPage();

  const how = await navigateToPrkList(page);
  const title = await page.title();
  if (!/pra[sš]ymai\s+krovai/i.test(title)) {
    throw new Error(`Unexpected page after navigation via ${how}: "${title}"`);
  }
  console.log(`PRK list: reached via ${how}`);

  await setStatusFilter(page, statuses || []);
  await setDateFilter(page, dateFrom, dateTo);
  await setLimitAndFilter(page, limit);
  return page;
}

// Navigates, reads, and re-queries with a higher limit if the first read was truncated —
// never silently returns an incomplete list.
async function readFullPrkList({ limit = 500, statuses = null, dateFrom = '', dateTo = '' } = {}) {
  const page = await openPrkList({ limit, statuses, dateFrom, dateTo });
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
  if (statuses && statuses.length) {
    const other = result.docs.filter(d => !statuses.some(s => s.toLowerCase() === String(d.status).toLowerCase()));
    if (other.length) throw new Error(`PRK list: the status filter did not apply (${other.length} document(s) with other statuses, e.g. ${other[0].number} ${other[0].status})`);
  }
  console.log(`PRK list: ${result.docs.length} document(s) read (limit=${current}), ${drafts.length} in ${DRAFT_STATUS}`);
  return { ...result, drafts, limitUsed: current };
}

// The status and date filters stay set in KIPIS for the person using the same window: after a
// sweep the operator's list showed only Ruošiamas, and their own submitted PRKs looked missing.
// Every job that filters the list clears them when it is done (no status, no dates). Never throws.
async function clearListFilters() {
  const page = getPage();
  try {
    await navigateToPrkList(page);
    await setStatusFilter(page, []);
    await setDateFilter(page, '', '');
    await page.locator('input[type="submit"][value="Filtruoti/Atnaujinti"]').click();
    await page.waitForLoadState('networkidle');
  } catch (err) {
    console.warn(`PRK list: could not clear the filters — ${err.message}`);
  }
}

// A5: every PRK in KIPIS from the last `days` days for a plate, whoever made it and whatever its
// cargo — the lot check only sees PRKs on lots of the order's own cargo. Two short reads (the
// Ruošiamas drafts, and documents submitted in the window) instead of the whole list, which runs
// past KIPIS's row cap. Returns [{ number, status, plateNorm, created }].
async function recentPrks(days = 2) {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = new Date(); from.setDate(from.getDate() - days);
  const since = iso(from), today = iso(new Date());
  const drafts = (await readFullPrkList({ limit: 500, statuses: [DRAFT_STATUS] })).docs;
  const submitted = (await readFullPrkList({ limit: 500, statuses: [], dateFrom: since, dateTo: today })).docs;
  const seen = new Map();
  for (const d of [...drafts, ...submitted]) if (d.created >= since && d.plateNorm) seen.set(d.number, d);
  await clearListFilters();
  return [...seen.values()].map(d => ({ number: d.number, status: d.status, plateNorm: d.plateNorm, created: d.created }));
}

module.exports = { readPrkListFromDom, navigateToPrkList, openPrkList, readFullPrkList, clearListFilters, recentPrks };
