const { getPage }         = require('../../src/core/browser');
const { navigateToCargo, findRowByPlate } = require('./navigateToCargo');
const { withAutomation }  = require('../safePage');

const KIPIS_URL = 'https://kipis.lt';

async function run(data) {
  const plate = data.plate || data.value;

  // Validate plate exists in Excel before doing anything
  console.log(`kipisLoad: looking up plate "${plate}" in orders Excel...`);
  findRowByPlate(plate); // throws if not found

  console.log(`kipisLoad: running PRK for plate: ${plate}`);

  const page = getPage();

  // Navigate to KIPIS home to ensure clean state
  await page.goto(KIPIS_URL);
  await page.waitForLoadState('networkidle');

  // Validate session is still active
  const hasSekimas = await page.getByText('Sekimas', { exact: true }).first().isVisible().catch(() => false);
  if (!hasSekimas) throw new Error('Session expired. Please reopen KIPIS.');

  // Pateikti guard armed for the whole run (armed after the home page loads: the flag is per origin).
  const result = await withAutomation(page, () => navigateToCargo(page, { plate }));

  console.log('kipisLoad: workflow complete.');
  return result || { submitted: false };
}

module.exports = { run };
