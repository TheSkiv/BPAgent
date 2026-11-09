const XLSX = require('xlsx');

const { todayFilePath } = require('../../src/core/dateManager');
const { checkPrkCompletion, readBackIssues } = require('./checkPrk');
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

async function getVesselName(row) {
  const cargo = row['Cargo'] || row['cargo'];
  if (!cargo) throw new Error('Field "Cargo" not found in row');

  // 1. Live stock data — most current, same as the web UI
  try {
    const { fetchStockRows, resolveVessel } = require('../../src/core/stockCache');
    const stockRows = await fetchStockRows();
    const fromStock = resolveVessel(cargo, stockRows);
    if (fromStock) { console.log('Vessel from stock:', fromStock); return fromStock; }
  } catch { /* BPA unreachable, try next */ }

  // 2. cargo.xlsx lookup (with fuzzy matching)
  const { getVesselForCargo } = require('../../src/core/cargoList');
  const fromCargo = getVesselForCargo(cargo);
  if (fromCargo) {
    const vessel = fromCargo.split(' / ')[0].trim(); // first vessel if multiple
    console.log('Vessel from cargo list:', vessel);
    return vessel;
  }

  // 3. Instructions.xlsx fallback
  const instructions = readInstructions();
  const match = instructions.find(r => cargoMatches(r['Cargo'] || '', cargo));
  if (match && match['Vessel']) { console.log('Vessel from Instructions:', match['Vessel']); return match['Vessel']; }

  throw new Error(`No vessel found for cargo: "${cargo}"`);
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

async function navigateToCargo(page, data = {}) {
  await page.waitForLoadState('networkidle');

  console.log('Clicking Sekimas...');
  await page.locator('text=Sekimas').click();
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
  try {
    const row = findRowByPlate(data.plate);
    console.log('Matched Excel row for plate:', row['Plate']);

    const vesselName = await getVesselName(row);
    const cargoName  = row['Cargo'] || row['cargo'] || '';

    // ── Apply filters ────────────────────────────────────────────────────────
    const vesselInput = page.locator('[id$=":fAtgabenimoDokumentas"]');
    await vesselInput.waitFor({ state: 'visible', timeout: 10000 });
    await vesselInput.fill(vesselName);
    console.log('Filled Atgabenimo dokumentas:', vesselName);

    if (cargoName) {
      await page.locator('[id$=":fPavadinimas"]').fill(cargoName);
      console.log('Filled Pavadinimas:', cargoName);
    }

    await page.locator('input[type="submit"][value="Filtruoti/Atnaujinti"]').click();
    await page.waitForLoadState('networkidle');
    console.log('Filters applied, waiting for results...');

    await page.waitForSelector('table tbody tr', { timeout: 15000 });

    // ── Scope to cargo results table ─────────────────────────────────────────
    let cargoTable = page.locator('table').filter({
      has: page.locator('th', { hasText: 'Siuntos numeris' }),
    }).last();

    let rowCount = await cargoTable.locator('xpath=./tbody/tr').count();
    console.log('Row count (with cargo filter):', rowCount);

    // If cargo name filter returned nothing, retry without it
    if (rowCount === 0 && cargoName) {
      console.log('No results with cargo filter — retrying without Pavadinimas');
      await page.locator('[id$=":fPavadinimas"]').fill('');
      await page.locator('input[type="submit"][value="Filtruoti/Atnaujinti"]').click();
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('table tbody tr', { timeout: 15000 });
      cargoTable = page.locator('table').filter({
        has: page.locator('th', { hasText: 'Siuntos numeris' }),
      }).last();
      rowCount = await cargoTable.locator('xpath=./tbody/tr').count();
      console.log('Row count (vessel-only filter):', rowCount);
    }

    if (rowCount === 0) throw new Error('No cargo rows found after filtering');

    // ── Identify columns ─────────────────────────────────────────────────────
    // The header is two rows: a group row (Siuntos duomenys / Atgabenta / Veiksmai su siunta)
    // and the real leaf-column row. Body <td>s align with the LEAF row, so index off that —
    // the flattened `thead th` list would be off by the group-row cells.
    const headers = await cargoTable.locator('thead tr').last().locator('th').allTextContents();

    const lastDocIdx = headers.findIndex(h => h.toLowerCase().includes('paskutinis dokumentas'));
    console.log('Last-document column index:', lastDocIdx, lastDocIdx !== -1 ? `(${headers[lastDocIdx].replace(/\s+/g, ' ').trim()})` : '(not found)');
    if (lastDocIdx === -1) throw new Error('Could not locate "Paskutinis dokumentas" column in results table');

    const svorisIdx = headers.findIndex(h => h.toLowerCase().includes('svoris bruto, kg'));
    console.log('Weight column index:', svorisIdx, svorisIdx !== -1 ? `(${headers[svorisIdx].replace(/\s+/g, ' ').trim()})` : '(not found)');

    const parseRemaining = (raw) => {
      const part = raw.includes('/') ? raw.split('/').pop() : raw;
      const digits = part.replace(/[^\d]/g, '');
      return digits ? parseInt(digits, 10) : 0;
    };

    // ── Pick the available shipment ───────────────────────────────────────────
    // A VZT (važtaraštis) or KDA (krovos darbų aktas) in the last-document column means the
    // row is already loaded onto a truck. The available vessel cargo has an IMP as its last
    // document — and only in THIS column (a dispatched row can carry an IMP in Saugojimo
    // deklaracija). Results use rowspan grouping: a parent row has all columns, but its
    // sub-rows drop the leading rowspan'd columns, so cells are shifted left by `offset`.
    const tableRows    = cargoTable.locator('xpath=./tbody/tr');
    const eligibleRows = [];

    for (let i = 0; i < rowCount; i++) {
      const cells  = await tableRows.nth(i).locator('xpath=./td').allTextContents();
      const offset = headers.length - cells.length;
      if (offset < 0) continue; // not a data row (e.g. repeated header)
      const cellAt = (leafIdx) => {
        const k = leafIdx - offset;
        return k >= 0 && k < cells.length ? cells[k] : '';
      };
      const lastDoc = cellAt(lastDocIdx).toUpperCase().trim();
      const weight  = svorisIdx !== -1 ? parseRemaining(cellAt(svorisIdx)) : 0;
      const dispatched = /\b(VZT|KDA)\b/.test(lastDoc);
      const eligible   = /\bIMP\b/.test(lastDoc) && !dispatched;
      console.log(`Row ${i}: lastDoc="${lastDoc}" weight=${weight} kg ${eligible ? 'ELIGIBLE' : 'skip'}`);
      if (eligible) eligibleRows.push({ i, weight });
    }

    if (eligibleRows.length === 0) {
      throw new Error('No available IMP shipment found — every row is already dispatched (VZT/KDA) or has no IMP last document');
    }

    eligibleRows.sort((a, b) => b.weight - a.weight);
    const bestRowIdx = eligibleRows[0].i;
    const bestWeight = eligibleRows[0].weight;

    if (bestWeight < 24000) {
      console.warn(`Warning: selected shipment remaining weight is ${bestWeight} kg — below 24 000 kg threshold`);
    } else {
      console.log(`Selected row ${bestRowIdx} with ${bestWeight} kg remaining`);
    }

    const targetRow = tableRows.nth(bestRowIdx);
    const checkbox  = targetRow.locator('input[type="checkbox"]');
    await checkbox.first().scrollIntoViewIfNeeded();
    await checkbox.first().click();
    console.log('Checkbox clicked in row', bestRowIdx);

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

    console.log('Filling Originalaus dokumento numeris...');
    const originalDoc = page.getByRole('textbox', { name: /originalaus dokumento numeris/i });
    await originalDoc.waitFor({ state: 'visible', timeout: 10000 });
    await originalDoc.fill(plates.join(', '));

    console.log('Filling Kita Procedūra...');
    await page.getByRole('textbox', { name: /kita procedūra/i }).fill(' ');

    console.log('Filling Kodas (Mokėtojas už krovos)...');
    await page.locator('[id$=":moketojas:subjf-kodas"]').fill(PAYER_CODE);

    console.log('Filling Pavadinimas (Mokėtojas už krovos)...');
    await page.locator('[id$=":moketojas:subjf-pav"]').fill(PAYER_NAME);

    console.log('Filling Instrukcijos...');
    const instructions = getInstructions(row);
    await page.locator('[id$=":prkr_info:instrukcijos"]').fill(instructions);

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
      { field: 'Originalaus dokumento numeris', locator: page.locator('[id$=":prkr_info:originaloNumeris"]'), expected: plates.join(', ') },
      { field: 'Mokėtojas — kodas',             locator: page.locator('[id$=":moketojas:subjf-kodas"]'),      expected: PAYER_CODE },
      { field: 'Mokėtojas — pavadinimas',       locator: page.locator('[id$=":moketojas:subjf-pav"]'),        expected: PAYER_NAME },
      { field: 'Instrukcijos',                  locator: page.locator('[id$=":prkr_info:instrukcijos"]'),     expected: instructions },
      { field: 'Krovos darbų aktą tvirtinti automatiškai', locator: page.locator('[id$=":prkr_info:patvirtintiKda"]'),       expected: true, kind: 'checked' },
      { field: 'Generuoti važtaraštį automatiškai',        locator: page.locator('[id$=":prkr_info:generuotiVaztarasti"]'), expected: true, kind: 'checked' },
      // A saved transport row shows its plate as text; the plate typed into
      // Originalaus dokumento numeris is an input value and does not count here.
      ...plates.map(p => ({ field: `Transportas ${p}`, locator: page.getByText(p), expected: p, kind: 'present' })),
    ]);

    console.log('Navigating to Kroviniai tab...');
    await page.locator('a[onclick*="prkr_kroviniai"]').click();
    await page.waitForLoadState('networkidle');

    const weight = getWeight(row);
    const bags   = Math.round(weight / 600);
    const total  = weight + bags;
    console.log(`Weight: ${weight}, Bags: ${bags}, Total bruto: ${total}`);

    // Row text inputs: name contains "prkr_kroviniai" and ":0:", exclude checkboxes
    const rowInputs = page.locator('input[type="text"][name*="prkr_kroviniai"][name*=":0:"], input[type="number"][name*="prkr_kroviniai"][name*=":0:"]');
    await rowInputs.first().waitFor({ state: 'visible', timeout: 10000 });

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
      bags,
      grossWeight:  total,
      instructions,
      payerCode:    PAYER_CODE,
      payerName:    PAYER_NAME,
    });

    if (check.ok === null)      console.warn(`AI check could not run: ${check.summary}`);
    else if (check.ok)          console.log(`AI check PASSED: ${check.summary}`);
    else {
      console.warn(`AI check FAILED: ${check.summary}`);
      for (const i of check.issues) console.warn(`  [${i.severity}] ${i.field}: expected "${i.expected}", found "${i.found}"`);
    }

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
      submitted = true;
      console.log('PRK draft saved. Pateikti is HUMAN-ONLY — not pressed (see RULES.md).');
    }

  } catch (error) {
    console.error('ERROR:', error.message);
    throw error;
  }

  return { submitted, check, fieldCheck, blocked };
}

module.exports = { navigateToCargo, findRowByPlate };
