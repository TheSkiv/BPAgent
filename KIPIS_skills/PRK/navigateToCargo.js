const XLSX = require('xlsx');

const { todayFilePath } = require('../../src/core/dateManager');
const { checkPrkCompletion, readBackIssues, captureFormState } = require('./checkPrk');
const INSTRUCTIONS_PATH = 'C:\\PortSystem\\Instructions\\Instructions.xlsx';

const PAYER_CODE = 'LT242134730';
const PAYER_NAME = 'UAB "BPA"';

// Safety default: fill the PRK form but do NOT submit. Set KIPIS_DRY_RUN=false to auto-submit.
const DRY_RUN = process.env.KIPIS_DRY_RUN !== 'false';

function readExcel() {
  const workbook = XLSX.readFile(todayFilePath());
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

function readInstructions() {
  const wb = XLSX.readFile(INSTRUCTIONS_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

function normalizePlate(str) {
  return str.replace(/[\s/\\]+/g, '').toLowerCase();
}

function normalizeCargo(str) {
  return str.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function cargoMatches(instructionsCargo, ordersCargo) {
  const normOrders = normalizeCargo(ordersCargo);
  const tokens = instructionsCargo.split(/\s+/).map(normalizeCargo).filter(t => t.length > 2);
  return tokens.length > 0 && tokens.every(t => normOrders.includes(t));
}

function findRowByPlate(inputPlate) {
  const data = readExcel();
  const needle = normalizePlate(inputPlate);
  const row = data.find(r => normalizePlate(r['Plate'] || r['plate'] || '').includes(needle));
  if (!row) throw new Error(`Plate "${inputPlate}" not found in orders Excel`);
  return row;
}

const DEFAULT_INSTRUCTIONS =
  'KRAUTI MAISUS TIK SU SVARIA BEI SVEIKA PAKUOTE!\n' +
  'MAISUS REIKIA GERAI NUVALYTI!\n' +
  'ISITIKINTIS, KAD PRIEKABOJE NERA PASALINIU ELEMENTU, KURIE GALI PAZEISTI KROVINI.';

function isBulkRow(row) {
  return row['Bulk'] === '1' || row['Bulk'] === 1 || row['bulk'] === '1' || row['bulk'] === 1;
}

function getInstructions(row) {
  const cargo = row['Cargo'] || row['cargo'];
  if (!cargo) throw new Error('Field "Cargo" not found in row');
  console.log('Cargo from orders:', cargo);

  const instructions = readInstructions();
  const match = instructions.find(r => cargoMatches(r['Cargo'] || '', cargo));
  if (match) {
    console.log('Instructions found for cargo:', cargo);
    return match['Instructions'] || '';
  }

  if (isBulkRow(row)) {
    console.log('BULK cargo — leaving instructions blank');
    return '';
  }

  console.log('Using default instructions for cargo:', cargo);
  return DEFAULT_INSTRUCTIONS;
}

// Bag size from the order's cargo text: "(500)", "(600)", "po 600 kg". 600 kg is the usual bag;
// 500 kg is rare but real ("Karbamidas (500) gran.", operator 2026-11-09). No size written → 600.
const DEFAULT_BAG_KG = 600;
function getBagKg(cargo) {
  const text = String(cargo || '');
  const m = text.match(/\((\d{3,4})\)/) || text.match(/(\d{3,4})\s*kg\b/i);
  const kg = m ? Number(m[1]) : 0;
  return kg >= 300 && kg <= 1500 ? kg : DEFAULT_BAG_KG;
}

function getWeight(row) {
  const weight = row['Weight'] || row['weight'];
  if (!weight) throw new Error('Field "Weight" not found in row');
  console.log('Weight from Excel:', weight);
  return Number(weight);
}

function getPlates(row) {
  const plate = row['Plate'] || row['plate'];
  if (!plate) throw new Error('Field "Plate" not found in row');
  console.log('Plate from Excel:', plate);
  return [plate];
}

// The two storage places in our terminals. A lot row whose "Krauti/pakrauta į" names one of these
// is cargo still in storage — loadable. Rows loading to Autotransportas / Vagonai are other trucks'
// and wagons' loads (operator rule, 2026-11-09; replaces the old IMP-last-document rule — these
// lots carry PTA/PRK last documents and no IMP at all).
const OUR_STORAGE = [
  /ro-ro ir generalinių krovinių terminalo sandėlis/i,
  /konteinerių terminalo sandėlis/i,
];
const isOurStorage = dest => /saugojimo vieta/i.test(dest) && OUR_STORAGE.some(re => re.test(dest));
const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
const plateKey = s => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SEARCH_LIMIT = 500;

// KIPIS document numbers start with their date: "261110-001994-VZT" = 2026-11-10. Recent = today
// or the two days before (a PRK pre-made the day before the truck comes — ROADMAP D4).
const RECENT_DAYS = 2;
function isRecentDoc(lastDoc) {
  const m = String(lastDoc || '').match(/\b(\d{2})(\d{2})(\d{2})-\d{6}-[A-Z]{2,4}\b/);
  if (!m) return false;
  const docDay = new Date(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const ageDays = (today - docDay) / 86400000;
  return ageDays >= 0 && ageDays <= RECENT_DAYS;
}

function parseKg(raw) {
  const part = raw.includes('/') ? raw.split('/').pop() : raw;
  const digits = part.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

// Filters Kroviniai by a cargo keyword and reads every row. Results use rowspan grouping: a lot's
// first row has all columns, its sub-rows drop the leading rowspan'd ones (lot number, name, …), so
// cells are shifted left by `offset` and sub-rows inherit the lot from the row above.
async function searchLots(page, keyword) {
  await page.locator('[id$=":fAtgabenimoDokumentas"]').fill('');
  await page.locator('[id$=":fPavadinimas"]').fill(keyword);
  // The default "Maks. įrašų skaičius" (50) can cut lots off a broad keyword search.
  await page.locator('[id$=":limit"]').fill(String(SEARCH_LIMIT));
  await page.locator('input[type="submit"][value="Filtruoti/Atnaujinti"]').click();
  await page.waitForLoadState('networkidle');

  const cargoTable = page.locator('table').filter({ has: page.locator('th', { hasText: 'Siuntos numeris' }) }).last();
  if (!(await cargoTable.count())) return { rows: [], tableRows: null };

  // Body <td>s align with the LEAF header row, not the group row above it.
  const headers = (await cargoTable.locator('thead tr').last().locator('th').allTextContents()).map(h => squash(h).toLowerCase());
  const idx = test => headers.findIndex(test);
  const col = {
    lot:       idx(h => h.startsWith('siuntos numeris')),
    name:      idx(h => h === 'pavadinimas'),
    transport: idx(h => h === 'transportas'),
    weight:    idx(h => h.includes('svoris bruto, kg') && !h.includes('pradinis')),
    lastDoc:   idx(h => h.includes('paskutinis dokumentas')),
    dest:      idx(h => h.includes('krauti/pakrauta')),
  };
  const missing = Object.entries(col).filter(([, i]) => i === -1).map(([k]) => k);
  if (missing.length) throw new Error(`Kroviniai table: column(s) not found: ${missing.join(', ')}`);

  const tableRows = cargoTable.locator('xpath=./tbody/tr');
  // One browser call for the whole table: reading it row by row took minutes on a broad keyword
  // ("YARA" — every Yara product on every vessel, with all their truck sub-rows; seen live
  // 2026-11-09).
  const allCells = await tableRows.evaluateAll(trs =>
    trs.map(tr => [...tr.children].filter(c => c.tagName === 'TD').map(td => td.textContent)));
  const rows = [];
  let lot = '', name = '', lotCount = 0;
  for (let i = 0; i < allCells.length; i++) {
    const cells  = allCells[i];
    const offset = headers.length - cells.length;
    if (offset < 0 || cells.length < 2) continue;
    const cellAt = leafIdx => {
      const k = leafIdx - offset;
      return k >= 0 && k < cells.length ? squash(cells[k]) : '';
    };
    if (offset === 0) { lot = cellAt(col.lot); name = cellAt(col.name); lotCount++; }
    if (!lot) continue;
    rows.push({
      i, lot, name,
      transport: cellAt(col.transport),
      weightKg:  parseKg(cellAt(col.weight)),
      lastDoc:   cellAt(col.lastDoc),
      dest:      cellAt(col.dest),
    });
  }
  // KIPIS stops at "Maks. įrašų skaičius" lots: at the cap, some lots are simply not shown.
  return { rows, tableRows, lotCount, truncated: lotCount >= SEARCH_LIMIT };
}

async function navigateToCargo(page, data = {}) {
  await page.waitForLoadState('networkidle');

  console.log('Clicking Sekimas...');
  // Exact text: a "Sekimas / Siuntos duomenys" label on some pages also matches a loose
  // text=Sekimas (strict-mode error, seen live 2026-11-10).
  await page.getByText('Sekimas', { exact: true }).first().click();
  await page.waitForLoadState('networkidle');

  console.log('Clicking Kroviniai...');
  await page.locator('text="Kroviniai"').click();
  await page.waitForLoadState('networkidle');

  // Manual/dev mode (no plate): just land on Kroviniai and pause for inspection.
  if (!data.plate) {
    await page.pause();
    return { submitted: false };
  }

  let submitted  = false;
  let check      = null;
  let fieldCheck = null;
  let blocked    = null;
  let saved      = null;
  let loadsFrom  = null;
  try {
    const row = findRowByPlate(data.plate);
    console.log('Matched Excel row for plate:', row['Plate']);

    const cargoName   = row['Cargo'] || row['cargo'] || '';
    const weight     = getWeight(row);
    const bagKg      = getBagKg(cargoName);
    const bags       = Math.round(weight / bagKg);
    const total      = weight + bags;
    const packaging  = isBulkRow(row) ? 'bulk' : 'bagged';
    console.log(`Weight: ${weight}, bag size: ${bagKg} kg, Bags: ${bags}, Total bruto: ${total}, packaging: ${packaging}`);

    // ── Whose cargo, on which vessel (owners.js) ─────────────────────────────────
    // The order's company → its Helm/Yara release (seller + vessel), or a self-loader's own lots.
    // Never "every vessel that has this cargo": that loaded one owner's trucks from another's lot.
    const owners   = require('../../src/core/owners');
    const registry = require('../../src/core/lotRegistry');
    const { deriveCompany } = require('../../src/core/senderCompanies');
    const company = deriveCompany(row['Sender'] || '');
    const { pendingReleaseKg } = require('../../src/core/orderStore');
    const source  = await owners.resolveOrder({ company, cargo: cargoName, grossKg: total }, registry.ownLotsOf, pendingReleaseKg);
    if (source.stop) {
      blocked = `order source — ${source.stop}`;
      console.warn(`Not filing: ${blocked}`);
      return { submitted: false, check, fieldCheck, blocked, needsLotOwners: true };
    }
    console.log(`Loads from: ${source.note}`);
    const vesselNames = source.vessels;

    // ── Find the lots of this cargo on every stock vessel ───────────────────────
    // KIPIS's Pavadinimas filter only matches short text, and its vessel filters did not find
    // the vessel (2026-11-09) — so search by a cargo keyword and read the vessel from the
    // Transportas column ("Laivas ULSAN 1078092, …").
    const { cargoKeywords, sameCargo } = require('../../src/core/stockCache');
    const vesselRes = vesselNames.map(v => ({ vessel: v, re: new RegExp(`\\b${escapeRe(v)}\\b`, 'i') }));
    const vesselOf  = transport => (vesselRes.find(v => v.re.test(transport)) || {}).vessel || '';
    const vesselList = vesselNames.join(', ');
    let rows = [], cargoRows = [], tableRows = null;
    const tried = [], truncatedWords = [];
    for (const keyword of cargoKeywords(cargoName)) {
      tried.push(keyword);
      console.log(`Searching Kroviniai: Pavadinimas = "${keyword}"`);
      const found = await searchLots(page, keyword);
      if (found.truncated) {
        // Some lots are not shown — never choose from that list; try the next word.
        console.log(`  "${keyword}" hit KIPIS's ${SEARCH_LIMIT}-lot limit — too broad, trying the next word`);
        truncatedWords.push(keyword);
        continue;
      }
      cargoRows = found.rows.filter(r => sameCargo(cargoName, r.name));
      rows = cargoRows
        .map(r => ({ ...r, vessel: vesselOf(r.transport) }))
        .filter(r => r.vessel);
      console.log(`  ${found.lotCount} lot(s), ${found.rows.length} row(s); ${rows.length} for ${vesselList} / this cargo`);
      if (rows.length) { tableRows = found.tableRows; break; }
    }
    // ── RULES.md Rule 6: is this truck already filed? ───────────────────────────
    // A sub-row loading to "Autotransportas <plate>" (KIPIS writes "MLL371/RZ817") whose last
    // document is recent — of ANY type: once the PRK is submitted and loaded it becomes a VZT or
    // KDA (LNF355//NR385 had "261110-001994-VZT (Patvirtintas)", filed by hand, seen 2026-11-10;
    // the old PRK-only check missed it). Older documents are the same truck's earlier trips.
    // Checked across every vessel of this cargo: a hand-filed load may be on another lot.
    const existing = cargoRows.find(r => /autotransportas/i.test(r.dest) && plateKey(r.dest).includes(plateKey(data.plate)) && isRecentDoc(r.lastDoc));
    if (existing) {
      console.log(`PRK already exists for ${data.plate}: ${existing.lastDoc} (lot ${existing.lot}) — not filing another`);
      return { submitted: false, existingPrk: existing.lastDoc, lot: existing.lot };
    }
    if (!rows.length) {
      const cut = truncatedWords.length ? ` — too broad, over ${SEARCH_LIMIT} lots: ${truncatedWords.join(', ')}` : '';
      throw new Error(`No lot of "${cargoName}" on ${vesselList} found in KIPIS (searched Pavadinimas: ${tried.join(', ')}${cut})`);
    }

    // ── Pick the lot: the owner's, by loading order / already loading / oldest ───
    const loadingRows = lot => rows.filter(r => r.lot === lot && /autotransportas|vagonai/i.test(r.dest)).length;
    const candidates = rows
      .filter(r => isOurStorage(r.dest))
      .map(r => ({ i: r.i, lot: r.lot, vessel: r.vessel, name: r.name, place: r.dest, weightKg: r.weightKg, trucksLoading: loadingRows(r.lot) }));
    for (const c of candidates) console.log(`  lot ${c.lot} ${c.vessel} "${c.name}" — ${c.weightKg} kg in storage, ${c.trucksLoading} truck/wagon load(s) on it`);

    // Every lot seen goes on the Lots page, so the operator can confirm owners before they block.
    registry.recordSeen(candidates.map(({ i, place, ...c }) => c));
    const choice = registry.chooseLot(candidates, source.owner, total);
    if (choice.stop) {
      blocked = `lot choice — ${choice.stop}`;
      console.warn(`Not filing: ${blocked}`);
      return { submitted: false, check, fieldCheck, blocked, needsLotOwners: !!choice.needsOwners };
    }
    console.log(`Lot chosen: ${choice.note}`);
    // Recorded on the order once saved: later orders subtract it from the release (A7).
    loadsFrom = {
      owner: source.owner, source: source.source, vessel: choice.pick.vessel, lot: choice.pick.lot, grossKg: total,
      releaseKey: (source.releases || []).find(r => r.vessel === choice.pick.vessel)?.key || null,
    };

    const checkbox = tableRows.nth(choice.pick.i).locator('input[type="checkbox"]');
    await checkbox.first().scrollIntoViewIfNeeded();
    await checkbox.first().click();
    console.log(`Checkbox ticked: lot ${choice.pick.lot} (${choice.pick.vessel}), storage row with ${choice.pick.weightKg} kg`);
    const vesselName = choice.pick.vessel;

    console.log('Clicking Krauti button to open popup...');
    await page.locator('input[type="button"][value="Krauti"]').click();

    console.log('Waiting for popup...');
    const popupKrauti = page.locator('input[type="submit"][value="Krauti"]');
    await popupKrauti.waitFor({ state: 'visible', timeout: 10000 });

    console.log('Selecting Klaipedos konteineriu terminalas in second dropdown...');
    const dialog = page.locator('#krova_tag_krauti');
    const selects = dialog.locator('select');

    // Second dropdown — pick the terminal
    await selects.nth(1).selectOption({ label: 'Klaipėdos konteinerių terminalas, UAB' });
    console.log('Terminal selected');

    await popupKrauti.click();
    console.log('Krauti clicked in popup');

    console.log('Waiting for Prašymas krovai form...');
    await page.waitForLoadState('networkidle');

    const plates = getPlates(row);

    // Originalaus dokumento numeris is left empty (operator, 2026-11-09 — it used to carry the
    // plates). Still waited on: its appearance is how we know the PRK form has loaded.
    const originalDoc = page.getByRole('textbox', { name: /originalaus dokumento numeris/i });
    await originalDoc.waitFor({ state: 'visible', timeout: 10000 });

    console.log('Filling Kita Procedūra...');
    await page.getByRole('textbox', { name: /kita procedūra/i }).fill(' ');

    console.log('Filling Kodas (Mokėtojas už krovos)...');
    await page.locator('[id$=":moketojas:subjf-kodas"]').fill(PAYER_CODE);

    console.log('Filling Pavadinimas (Mokėtojas už krovos)...');
    await page.locator('[id$=":moketojas:subjf-pav"]').fill(PAYER_NAME);

    console.log('Filling Instrukcijos...');
    const instructions = getInstructions(row);
    await page.locator('[id$=":prkr_info:instrukcijos"]').fill(instructions);

    // Receiver's country (Gavėjas → Valstybė): KIPIS requires it before the Kroviniai tab opens,
    // and some lots leave it empty (Agrokoncernas's own ULSAN lot, 2026-11-10). Filled from the
    // company's setting (operator: "Lietuva only"), and only when empty — never over a value
    // KIPIS took from the lot.
    const receiverCountry = owners.receiverCountryFor(company);
    const countrySelect   = page.locator('[id$=":prkr_info:gavejas:subjf-valst"]');
    let countryFilled = '';
    if (receiverCountry && await countrySelect.count()) {
      const current = await countrySelect.evaluate(s => (s.selectedOptions[0]?.textContent || '').trim());
      if (!current || current === '--') {
        const value = await countrySelect.evaluate((s, name) => {
          const n = name.toLowerCase();
          const o = [...s.options].find(x => x.textContent.trim().toLowerCase() === n)
                 || [...s.options].find(x => x.textContent.toLowerCase().includes(n));
          return o ? o.value : null;
        }, receiverCountry);
        if (!value) throw new Error(`Receiver country "${receiverCountry}" is not in KIPIS's country list`);
        console.log(`Filling Gavėjas valstybė: ${receiverCountry} (${company}'s setting)...`);
        await countrySelect.selectOption(value);
        await page.waitForLoadState('networkidle');
        countryFilled = receiverCountry;
      }
    }

    console.log('Checking Krovos darbų aktą tvirtinti automatiškai...');
    await page.getByLabel(/krovos darbų aktą tvirtinti automatiškai/i).check();

    console.log('Checking Generuoti važtaraštį automatiškai...');
    await page.getByLabel(/generuoti važtaraštį automatiškai/i).check();

    // Add transport entries — one per plate
    for (const plate of plates) {
      console.log(`Adding transport for plate: ${plate}`);

      console.log('Clicking Pridėti (Į autotransportą)...');

      await page.getByRole('button', { name: /pridėti/i }).first().click();
      await page.waitForLoadState('networkidle');

      console.log('Filling Markė...');
      await page.getByRole('textbox', { name: /markė/i }).fill(' ');

      console.log('Filling Numeris...');
      await page.getByRole('textbox', { name: /numeris/i }).fill(plate);

      console.log('Clicking Saugoti...');
      await page.getByRole('button', { name: /saugoti/i }).click();
      await page.waitForLoadState('networkidle');

      console.log(`Transport added for plate: ${plate}`);
    }

    // Read back the main-tab fields now: adding a transport row re-renders the form, which is
    // where an earlier fill could be lost, and these fields may not be readable once the
    // Kroviniai tab is open.
    const fieldIssues = await readBackIssues([
      { field: 'Originalaus dokumento numeris (must stay empty)', locator: page.locator('[id$=":prkr_info:originaloNumeris"]'), expected: '' },
      { field: 'Mokėtojas — kodas',             locator: page.locator('[id$=":moketojas:subjf-kodas"]'),      expected: PAYER_CODE },
      { field: 'Mokėtojas — pavadinimas',       locator: page.locator('[id$=":moketojas:subjf-pav"]'),        expected: PAYER_NAME },
      { field: 'Instrukcijos',                  locator: page.locator('[id$=":prkr_info:instrukcijos"]'),     expected: instructions },
      ...(countryFilled ? [{ field: 'Gavėjas — valstybė', locator: countrySelect, expected: countryFilled, kind: 'selectedText' }] : []),
      { field: 'Krovos darbų aktą tvirtinti automatiškai', locator: page.locator('[id$=":prkr_info:patvirtintiKda"]'),       expected: true, kind: 'checked' },
      { field: 'Generuoti važtaraštį automatiškai',        locator: page.locator('[id$=":prkr_info:generuotiVaztarasti"]'), expected: true, kind: 'checked' },
      // A saved transport row shows its plate as text (input values do not count here).
      ...plates.map(p => ({ field: `Transportas ${p}`, locator: page.getByText(p), expected: p, kind: 'present' })),
    ]);
    // A saved transport row shows its plate as text, not an input, so captureFormState misses it
    // and the model reported the plate as empty (seen live 2026-11-10). Give it the rows' text.
    const transportRows = [];
    for (const p of plates) {
      const el = page.getByText(p).first();
      if (!await el.count()) continue;
      const text = await el.evaluate(n => (n.closest('tr') || n).innerText.replace(/\s+/g, ' ').trim());
      transportRows.push({ label: 'Į autotransportą (saved transport row)', name: '', type: 'text', value: text.slice(0, 200) });
    }
    const mainTabFields = [...transportRows, ...(await captureFormState(page)).fields];

    console.log('Navigating to Kroviniai tab...');
    await page.locator('a[onclick*="prkr_kroviniai"]').click();
    await page.waitForLoadState('networkidle');

    // Row text inputs: name contains "prkr_kroviniai" and ":0:", exclude checkboxes
    const rowInputs = page.locator('input[type="text"][name*="prkr_kroviniai"][name*=":0:"], input[type="number"][name*="prkr_kroviniai"][name*=":0:"]');
    // KIPIS validates the first tab before switching: a required field it wants (e.g. the
    // receiver's country, "Valstybė: Reikšmė privaloma", on Agrokoncernas's ULSAN lot,
    // 2026-11-10) keeps the form on Informacija. Report KIPIS's own message, not a timeout.
    try {
      await rowInputs.first().waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      const messages = await page.locator('[class*="rror"], [class*="essage"], font[color="red"], span[style*="red"]')
        .evaluateAll(els => [...new Set(els.filter(e => e.offsetParent).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(t => t && !/\*$/.test(t)))]);
      throw new Error(`KIPIS did not open the Kroviniai tab${messages.length ? ': ' + messages.join('; ') : ''} — the form is left open, not saved`);
    }

    console.log('Filling Svoris bruto, kg...');
    await rowInputs.nth(0).fill(String(total));

    console.log('Filling Vietų skaičius...');
    await rowInputs.nth(2).fill(String(bags));

    console.log('Form fields filled.');

    fieldIssues.push(...await readBackIssues([
      { field: 'Svoris bruto, kg', locator: rowInputs.nth(0), expected: total, kind: 'number' },
      { field: 'Vietų skaičius',   locator: rowInputs.nth(2), expected: bags,  kind: 'number' },
    ]));
    fieldCheck = { ok: fieldIssues.length === 0, issues: fieldIssues };
    if (fieldCheck.ok) console.log('Field read-back PASSED: every filled value is on the form.');
    else {
      console.warn('Field read-back FAILED:');
      for (const i of fieldIssues) console.warn(`  ${i.field}: expected "${i.expected}", found "${i.found}"`);
    }

    // AI check of the completed form, before Saugoti. Never proceeds past Saugoti — see RULES.md.
    console.log('Running AI completion check...');
    check = await checkPrkCompletion(page, {
      plate:        plates.join(', '),
      cargo:        cargoName,
      vessel:       vesselName,
      orderWeight:  weight,
      bagKg,
      bags,
      grossWeight:  total,
      instructions,
      payerCode:    PAYER_CODE,
      payerName:    PAYER_NAME,
      ...(countryFilled ? { receiverCountry: countryFilled } : {}),
    }, mainTabFields);

    if (check.ok === null)      console.warn(`AI check could not run: ${check.summary}`);
    else if (check.ok)          console.log(`AI check PASSED — no problem with any value this run filled. (Model's note: ${check.summary})`);
    else {
      console.warn(`AI check FAILED: ${check.summary}`);
      for (const i of check.issues) console.warn(`  [${i.severity}] ${i.field}: expected "${i.expected}", found "${i.found}"`);
    }
    for (const i of check.ignored || []) console.log(`  (not blocking — not a field this run fills) ${i.field}: expected "${i.expected}", found "${i.found}"`);

    // RULES.md Rule 3 — never save an unverified form. The read-back must always pass; the AI check
    // must not have failed. AI unavailable + read-back passed is enough to save (ROADMAP D2).
    if (!fieldCheck.ok) {
      blocked = 'field read-back failed: ' + fieldIssues.map(i => `${i.field} expected "${i.expected}", found "${i.found}"`).join('; ');
    } else if (check.ok === false) {
      blocked = `AI check failed: ${check.summary}`;
    }

    if (DRY_RUN) {
      console.log('DRY RUN — PRK form filled but NOT saved. Review it in the browser and click Saugoti manually, or set KIPIS_DRY_RUN=false to auto-save the draft.');
      if (blocked) console.warn(`(would not have saved — ${blocked})`);
    } else if (blocked) {
      console.warn(`Not clicking Saugoti — ${blocked}. The form is left open in KIPIS for manual review.`);
    } else {
      if (check.ok === null) console.log('Saving on the field read-back alone (AI check unavailable — ROADMAP D2).');
      console.log('Saving PRK draft (Saugoti)...');
      const saveBtn = page.locator('input[type="submit"][value="Saugoti"]:visible').last();
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForLoadState('networkidle');
      saved = await confirmSaved(page);
      submitted = true;
      console.log(`PRK draft saved: ${saved.number} (${saved.status}). Pateikti is HUMAN-ONLY — not pressed (see RULES.md).`);
    }

  } catch (error) {
    console.error('ERROR:', error.message);
    throw error;
  }

  return { submitted, check, fieldCheck, blocked, prkNumber: saved?.number || null, prkStatus: saved?.status || null, loadsFrom };
}

// After Saugoti, KIPIS swaps the header "Naujas dokumentas" for
// "Prašymas krovai: 260720-005851-PRK, Ruošiamas, Saugojimo vieta -> Autotransportas".
// That header is the proof of the save (ROADMAP A3) and carries the PRK number (A4). No header →
// not saved as far as we can tell: throw, so the order is never marked done on a guess. If KIPIS
// did save it after all, a rerun finds that PRK on the lot (Rule 6) instead of filing another.
async function confirmSaved(page, timeout = 20000) {
  const header = page.getByText(/Prašymas krovai:\s*\d{6}-\d{6}-PRK/).first();
  try {
    await header.waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error('Saugoti was pressed, but KIPIS shows no saved PRK number — not counting it as saved. Check the form in KIPIS.');
  }
  const text = squash(await header.textContent());
  const m = text.match(/(\d{6}-\d{6}-PRK)\s*,\s*([^,]+)/);
  if (!m) throw new Error(`Saved-document header not understood: "${text}"`);
  const status = m[2].trim();
  if (!/^ruošiamas$/i.test(status)) {
    throw new Error(`PRK ${m[1]} was saved with status "${status}", expected Ruošiamas — check it in KIPIS`);
  }
  return { number: m[1], status };
}

module.exports = { navigateToCargo, findRowByPlate, searchLots, isOurStorage, isRecentDoc, getBagKg, confirmSaved };
