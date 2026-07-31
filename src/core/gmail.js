const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const { PDFParse } = require('pdf-parse');
const XLSX       = require('xlsx');
const { todayString } = require('./dateManager');

const DATA_DIR    = path.resolve(__dirname, '../../data');
const CREDS_DIR   = path.resolve(__dirname, '../../credentials');
const TOKEN_FILE  = path.join(CREDS_DIR, 'token.json');
const SCOPES      = ['https://www.googleapis.com/auth/gmail.readonly'];
const OAUTH_PORT  = 3002;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;

function loadCredentials() {
  const files = fs.readdirSync(CREDS_DIR).filter(f => f.startsWith('client_secret') && f.endsWith('.json'));
  if (!files.length) throw new Error('No credentials file found in C:\\PortSystem\\credentials\\');
  const parsed = JSON.parse(fs.readFileSync(path.join(CREDS_DIR, files[0])));
  return parsed.installed || parsed.web;
}

function createOAuth2Client() {
  const { client_id, client_secret } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function isAuthorized() {
  return fs.existsSync(TOKEN_FILE);
}

async function getAuthorizedClient() {
  const oAuth2 = createOAuth2Client();
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('Gmail not authorized. Run /gmail/auth first.');
  const token = JSON.parse(fs.readFileSync(TOKEN_FILE));
  oAuth2.setCredentials(token);
  oAuth2.on('tokens', updated => {
    const existing = JSON.parse(fs.readFileSync(TOKEN_FILE));
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...updated }));
  });
  // Validate the token is still usable; catches invalid_grant before any API call
  try {
    await oAuth2.getAccessToken();
  } catch (err) {
    if (err.message?.includes('invalid_grant') || err.response?.data?.error === 'invalid_grant') {
      fs.unlinkSync(TOKEN_FILE);
      throw new Error('AUTH_REQUIRED');
    }
    throw err;
  }
  return oAuth2;
}

// Starts the one-time callback server and returns the auth URL immediately.
// Call awaitAuthCode() to wait for the user to complete the flow.
let pendingOAuth = null;

function beginAuthFlow() {
  const oAuth2 = createOAuth2Client();
  const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  const codePromise = waitForCode(OAUTH_PORT);
  pendingOAuth = { oAuth2, codePromise };
  console.log('Gmail auth flow started. URL:', authUrl);
  return authUrl;
}

async function completeAuthFlow() {
  if (!pendingOAuth) throw new Error('No auth flow in progress. Call beginAuthFlow first.');
  const { oAuth2, codePromise } = pendingOAuth;
  pendingOAuth = null;
  const code = await codePromise;
  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  console.log('Gmail token saved.');
}

function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        const code = url.searchParams.get('code');
        if (!code) { res.end('No code received.'); return; }
        res.end('<html><body style="font-family:sans-serif;padding:2rem"><h2>Authorization successful!</h2><p>You can close this tab.</p></body></html>');
        server.close();
        resolve(code);
      } catch (e) {
        res.end('Error'); reject(e);
      }
    });
    server.listen(port, () => console.log(`OAuth callback server listening on port ${port}`));
    server.on('error', reject);
    // 3-minute timeout
    setTimeout(() => { server.close(); reject(new Error('OAuth auth timed out after 3 minutes.')); }, 180000);
  });
}

function seenFilePath() {
  return path.join(DATA_DIR, `seen_${todayString()}.json`);
}

function loadSeenIds() {
  const p = seenFilePath();
  if (!fs.existsSync(p)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(p)));
}

function markSeen(ids) {
  const seen = loadSeenIds();
  ids.forEach(id => seen.add(id));
  fs.writeFileSync(seenFilePath(), JSON.stringify([...seen]));
}

function todayGmailFilter() {
  // Gmail date format: YYYY/MM/DD
  return 'after:' + todayString().replace(/-/g, '/');
}

async function fetchRecentEmails(maxResults = 20, query = 'in:inbox') {
  const auth  = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Always restrict to today and unseen
  const fullQuery = `${query} ${todayGmailFilter()}`;
  console.log(`Gmail query: ${fullQuery}`);

  const list = await gmail.users.messages.list({ userId: 'me', maxResults, q: fullQuery });
  if (!list.data.messages?.length) return [];

  // Filter out already-seen IDs
  const seen = loadSeenIds();
  const fresh = list.data.messages.filter(m => !seen.has(m.id));
  if (!fresh.length) { console.log('Gmail: no new emails.'); return []; }

  console.log(`Gmail: ${fresh.length} new email(s) out of ${list.data.messages.length} today.`);

  const emails = await Promise.all(
    fresh.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' }))
  );

  // Mark as seen before returning
  markSeen(fresh.map(m => m.id));

  return emails.map(mapMessage);
}

function mapMessage(e) {
  const headers = e.data.payload.headers;
  const get = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    id:      e.data.id,
    subject: get('Subject'),
    from:    get('From'),
    to:      get('To'),
    date:    get('Date'),
    body:        extractBody(e.data.payload),
    attachments: findDocAttachments(e.data.payload),
  };
}

// Fetches today's emails matching an arbitrary query, WITHOUT the seen-id filter, so it can
// be re-run every poll (idempotent callers). Used for the terminal PRK-confirmation scan.
async function fetchEmailsMatching(query, maxResults = 50) {
  const auth  = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const fullQuery = `${query} ${todayGmailFilter()}`;
  const list = await gmail.users.messages.list({ userId: 'me', maxResults, q: fullQuery });
  if (!list.data.messages?.length) return [];

  const emails = await Promise.all(
    list.data.messages.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' }))
  );
  return emails.map(mapMessage);
}

// Recursively find PDF and spreadsheet attachment parts — loading lists (BULK/big-bag,
// quantity, release no.) as often come as an .xlsx as a PDF — and return
// { attachmentId, filename }[].
const DOC_EXTENSIONS = ['.pdf', '.xlsx', '.xls'];
const DOC_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // legacy .xls
]);
function findDocAttachments(payload) {
  const results = [];
  const filename = (payload.filename || '').toLowerCase();
  const isDoc = DOC_MIME_TYPES.has(payload.mimeType) ||
    ((payload.mimeType === 'application/octet-stream' || !payload.mimeType) &&
      DOC_EXTENSIONS.some(ext => filename.endsWith(ext)));
  if (isDoc && payload.body?.attachmentId) {
    results.push({ attachmentId: payload.body.attachmentId, filename: payload.filename || 'attachment' });
  }
  for (const part of payload.parts || []) {
    results.push(...findDocAttachments(part));
  }
  return results;
}

// Spreadsheet -> plain text (CSV per sheet) so it can go through the same "Attachment text"
// path as a parsed PDF.
function spreadsheetToText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim();
    if (csv) parts.push(wb.SheetNames.length > 1 ? `Sheet "${sheetName}":\n${csv}` : csv);
  }
  return parts.join('\n\n');
}

async function fetchAttachmentText(messageId, attachmentId, filename = '') {
  const auth   = await getAuthorizedClient();
  const gmail  = google.gmail({ version: 'v1', auth });
  const resp   = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  // Gmail returns base64url — convert to standard base64 before decoding
  const base64 = resp.data.data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(base64, 'base64');

  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return spreadsheetToText(buffer);
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function fetchAttachmentBytes(messageId, attachmentId) {
  const auth  = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const resp  = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const base64 = resp.data.data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      const found = extractBody(part);
      if (found) return found;
    }
  }
  return '';
}

module.exports = { isAuthorized, beginAuthFlow, completeAuthFlow, fetchRecentEmails, fetchEmailsMatching, fetchAttachmentText, fetchAttachmentBytes };
