const { chromium }        = require('playwright');
const path                = require('path');
const fs                  = require('fs');
const { exec, execSync }  = require('child_process');
const XLSX                = require('xlsx');

const DOWNLOADS_DIR = path.resolve(__dirname, '../../downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
const { todayFilePath } = require('./dateManager');
const { installPateiktiGuard } = require('../../KIPIS_skills/safePage');

const KIPIS_URL = 'https://kipis.lt';

// Credentials come from .env only — never hardcode them (SECURITY.md rule 1).
function kipisUser() {
  const v = process.env.KIPIS_USER;
  if (!v) throw new Error('KIPIS_USER is not set in .env');
  return v;
}
function kipisPass() {
  const v = process.env.KIPIS_PASS;
  if (!v) throw new Error('KIPIS_PASS is not set in .env');
  return v;
}

const ORDERS_COLUMNS = ['Plate', 'Driver', 'Cargo', 'Weight', 'Sender', 'Received'];

function ensureTodayExcel() {
  const filePath = todayFilePath();
  if (fs.existsSync(filePath)) {
    console.log(`Today's Excel exists: ${filePath}`);
    return;
  }

  console.log(`Creating today's Excel: ${filePath}`);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([ORDERS_COLUMNS]);
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  XLSX.writeFile(wb, filePath);
  console.log('Excel created with template columns.');
}

let context    = null;
let kipis_page = null;
// Automated exports suppress this so a sweep does not pop Excel open on every download.
let autoOpenDownloads = true;
function setAutoOpenDownloads(value) { autoOpenDownloads = !!value; }
const sessionPath = path.resolve(__dirname, '../../session');

function killSessionChrome() {
  try {
    const out = execSync('wmic process where "Name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8', timeout: 5000 });
    out.split('\n').forEach(line => {
      if (!line.includes('PortSystem') && !line.includes('session')) return;
      const cols = line.trim().split(',');
      const pid  = cols[cols.length - 1]?.trim();
      if (pid && /^\d+$/.test(pid)) {
        try { execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 }); console.log(`Killed stale Chrome PID ${pid}`); } catch {}
      }
    });
  } catch {}
}

function clearSessionLock() {
  ['SingletonLock', 'SingletonCookie', 'lockfile'].forEach(f => {
    const p = path.join(sessionPath, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  });
}

async function openKipis() {
  ensureTodayExcel();

  if (kipis_page && !kipis_page.isClosed()) {
    console.log('KIPIS already open, reusing existing page.');
    return;
  }

  // Close stale Playwright context gracefully
  if (context) {
    try { await context.close(); } catch {}
    context    = null;
    kipis_page = null;
  }

  console.log('Launching browser...');

  // Try to launch; on profile-lock failure kill stale Chrome and retry once
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      context = await chromium.launchPersistentContext(sessionPath, {
        headless: false,
        slowMo: 50,
        acceptDownloads: true,
      });
      break;
    } catch (err) {
      if (attempt === 0) {
        console.log('Launch failed, clearing stale Chrome session and retrying...');
        killSessionChrome();
        clearSessionLock();
        await new Promise(r => setTimeout(r, 1500));
      } else {
        throw err;
      }
    }
  }

  function attachDownloadHandler(page) {
    page.on('download', async download => {
      try {
        const filename = download.suggestedFilename() || `kipis_${Date.now()}`;
        const savePath = path.join(DOWNLOADS_DIR, filename);
        await download.saveAs(savePath);
        console.log(`Download saved: ${savePath}`);
        if (autoOpenDownloads) exec(`start "" "${savePath}"`);
      } catch (err) {
        console.error('Download handling failed:', err.message);
      }
    });
  }

  context.on('page', page => {
    attachDownloadHandler(page);
    installPateiktiGuard(page).catch(err => console.error('PateiktiGuard install failed:', err.message));
  });

  kipis_page = context.pages()[0] || await context.newPage();
  attachDownloadHandler(kipis_page);
  await installPateiktiGuard(kipis_page);
  await kipis_page.goto(KIPIS_URL);

  // Auto-fill credentials if login form is present
  try {
    const loginInput = kipis_page.getByRole('textbox', { name: /prisijungimo vardas/i });
    await loginInput.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Login form detected, filling credentials...');
    await loginInput.fill(kipisUser());
    await kipis_page.getByRole('textbox', { name: /slaptažodis/i }).fill(kipisPass());
    await kipis_page.getByRole('button', { name: /prisijungti/i }).click();
    await kipis_page.waitForLoadState('networkidle');
    const mfaInput = kipis_page.locator('input[type="text"], input[type="number"], input[type="tel"]').first();
    await mfaInput.waitFor({ state: 'visible', timeout: 10000 });
    await mfaInput.focus();
    console.log('Credentials submitted. Waiting for login...');
  } catch {
    console.log('Login form not found, assuming session active or at MFA step.');
  }

  console.log('Waiting for login...');

  const reached = await Promise.race([
    kipis_page.waitForSelector('text=Sekimas', { timeout: 0 }).then(() => 'main'),
    kipis_page.waitForSelector('text=Uždaryti sesij', { timeout: 0 }).then(() => 'session'),
  ]);

  if (reached === 'session') {
    console.log('Existing session detected, closing it...');
    await kipis_page.locator('text=Uždaryti sesij').first().click();
    await kipis_page.waitForSelector('text=Sekimas', { timeout: 0 });
  }

  console.log('Login detected. KIPIS opened.');
}

function getPage() {
  if (!kipis_page) throw new Error('Browser not initialized. Open KIPIS first.');
  return kipis_page;
}

module.exports = { openKipis, getPage, setAutoOpenDownloads };
