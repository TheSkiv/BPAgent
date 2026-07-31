require('dotenv').config();
const { launchBrowser }     = require('./core/browser');
const { navigateToCargo }   = require('../KIPIS_skills/PRK/navigateToCargo');

const KIPIS_URL = 'https://kipis.lt';

async function main() {
  const { page } = await launchBrowser();

  await page.goto(KIPIS_URL);

  // Auto-fill credentials if login form is present
  try {
    const loginInput = page.getByRole('textbox', { name: /prisijungimo vardas/i });
    await loginInput.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Login form detected, filling credentials...');
    await loginInput.fill(process.env.KIPIS_USER);
    await page.getByRole('textbox', { name: /slaptažodis/i }).fill(process.env.KIPIS_PASS);
    await page.getByRole('button', { name: /prisijungti/i }).click();
    await page.waitForLoadState('networkidle');
    // Focus the MFA input so the user can type immediately without clicking
    const mfaInput = page.locator('input[type="text"], input[type="number"], input[type="tel"]').first();
    await mfaInput.waitFor({ state: 'visible', timeout: 10000 });
    await mfaInput.focus();
    console.log('Credentials submitted. Enter the 6-digit authenticator code.');
  } catch {
    console.log('Login form not found, assuming already logged in or at MFA step.');
  }

  // Wait for either the main page or a session conflict prompt (no timeout — MFA can take time)
  const reached = await Promise.race([
    page.waitForSelector('text=Sekimas', { timeout: 0 }).then(() => 'main'),
    page.waitForSelector('text=Uždaryti sesij', { timeout: 0 }).then(() => 'session'),
  ]);

  if (reached === 'session') {
    console.log('Existing session detected, closing it...');
    await page.locator('text=Uždaryti sesij').first().click();
    await page.waitForSelector('text=Sekimas', { timeout: 0 });
  }

  await navigateToCargo(page);

  console.log('Reached Kroviniai page.');

  await page.pause();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
