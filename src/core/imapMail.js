// Direct IMAP access to the real mailbox (terminal@bpa.lt @ mail.bpa.lt), replacing the old
// Gmail-API polling. bpaterminal1@gmail.com was never the real inbox — it was a POP3-imported
// mirror of this same mailbox, and Gmail's own POP3 fetcher runs on an unpredictable schedule of
// its own (observed 2-15 min lag in production headers), which no amount of polling on our side
// could shorten. Connecting here directly removes that hop entirely.
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const XLSX   = require('xlsx');
const fs     = require('fs');
const path   = require('path');
const { PDFParse } = require('pdf-parse');
const { todayString } = require('./dateManager');

const DATA_DIR = path.resolve(__dirname, '../../data');

function isAuthorized() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

// Avast's local Mail Shield intercepts this connection and re-signs it with its own
// "Untrusted Root" CA (not the trusted root it installs for certs it's fine with) — the real
// mail.bpa.lt cert's subject is CN=bpa.lt, a SAN mismatch against the "mail." host we connect to,
// not evidence of tampering. Avast settings are IT-locked so an exclusion isn't available; pin to
// this specific certificate's fingerprint instead of disabling verification outright, so an
// actually different certificate (a real MITM, not just this known mismatch) still gets rejected.
// Re-pin (openssl s_client -connect mail.bpa.lt:993 | openssl x509 -noout -fingerprint -sha256)
// if this expires (valid until 2027-02-03) or the mail server's cert changes. Avast re-issues its
// re-signed cert roughly every 90 days, so expect to re-pin on that cadence.
const PINNED_CERT_FINGERPRINT256 = '78:3C:56:B9:32:5C:ED:58:86:26:5C:98:2D:DF:D6:A3:92:7E:FF:2A:9E:19:3C:7A:D7:C1:89:B8:4A:99:0D:48';

function clientOptions() {
  return {
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
    tls: {
      rejectUnauthorized: false,
      checkServerIdentity: (_host, cert) => {
        if (cert.fingerprint256 === PINNED_CERT_FINGERPRINT256) return undefined;
        return new Error(`IMAP TLS certificate fingerprint mismatch — expected pinned mail.bpa.lt cert, got ${cert.fingerprint256}`);
      },
    },
  };
}

// Fresh connection per call — simplest and most robust for a periodic-polling use case; avoids
// needing keepalive/reconnect handling that a long-lived connection would require.
async function withClient(fn) {
  if (!isAuthorized()) throw new Error('AUTH_REQUIRED');
  const client = new ImapFlow(clientOptions());
  // imapflow emits a socket-level 'error' (e.g. ECONNRESET on a flaky connection) separately
  // from rejecting the in-flight operation's promise. An EventEmitter 'error' with no listener
  // is fatal in Node — it crashed the whole server on 2026-08-04. The caller's own try/catch
  // around connect()/fn() already handles the promise-rejection side of the same failure; this
  // listener only exists to stop that duplicate event from taking the process down.
  client.on('error', err => console.error('IMAP connection error:', err.message));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Cheap live check for the dashboard's status badge — actually connects, unlike isAuthorized().
async function checkConnection() {
  try {
    await withClient(async client => { await client.mailboxOpen('INBOX', { readOnly: true }); });
    return true;
  } catch {
    return false;
  }
}

function seenFilePath() {
  return path.join(DATA_DIR, `seen_${todayString()}.json`);
}
function loadSeenIds() {
  const p = seenFilePath();
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { return new Set(); }
}
function markSeen(ids) {
  const seen = loadSeenIds();
  ids.forEach(id => seen.add(id));
  fs.writeFileSync(seenFilePath(), JSON.stringify([...seen]));
}

// A check that failed after fetching (e.g. the AI extraction was unreachable) hands its emails
// back, so the next check reads them again instead of losing them.
function unmarkSeen(ids) {
  const seen = loadSeenIds();
  ids.forEach(id => seen.delete(String(id)));
  fs.writeFileSync(seenFilePath(), JSON.stringify([...seen]));
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// mailparser already flattens MIME parts into a plain attachments array — no tree-walk needed
// the way the Gmail API payload required.
const DOC_EXT = ['.pdf', '.xlsx', '.xls'];
function isDocAttachment(att) {
  const filename = (att.filename || '').toLowerCase();
  return DOC_EXT.some(ext => filename.endsWith(ext));
}

// attachmentId doubles as the filename — IMAP/mailparser has no separate per-attachment ID the
// way Gmail's API does, and using the filename directly keeps the calling code in gmailRoute.js
// and server.js unchanged (they already carry both fields through as opaque strings).
function mapParsed(uid, parsed) {
  return {
    id: String(uid),
    subject: parsed.subject || '',
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    date: parsed.date || new Date(),
    body: parsed.text || parsed.html || '',
    attachments: (parsed.attachments || []).filter(isDocAttachment).map(att => ({
      attachmentId: att.filename || 'attachment',
      filename: att.filename || 'attachment',
    })),
  };
}

async function fetchMessagesByUid(client, uids) {
  const emails = [];
  for (const uid of uids) {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const parsed = await simpleParser(msg.source);
    emails.push(mapParsed(uid, parsed));
  }
  return emails;
}

// Today's not-yet-seen messages, newest `max`. Mirrors the old fetchRecentEmails(max, query)
// signature; `query` is accepted but ignored — every caller only ever passed 'in:inbox', which
// is just "the mailbox" now that there's nothing else to filter by.
async function fetchRecentEmails(max = 30, _query) {
  const seen = loadSeenIds();
  return withClient(async client => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = await client.search({ since: startOfToday() }, { uid: true });
    if (!uids || !uids.length) return [];

    const freshUids = uids.filter(uid => !seen.has(String(uid))).slice(-max);
    if (!freshUids.length) return [];

    const emails = await fetchMessagesByUid(client, freshUids);
    markSeen(freshUids.map(String));
    return emails;
  });
}

// query: only the "from:<address>" shape is ever used (the terminal gate-pass confirmation
// scan) — no need for a general query-language parser for one call site.
async function fetchEmailsMatching(query) {
  const m = String(query || '').match(/^from:(.+)$/i);
  const from = m ? m[1].trim() : null;

  return withClient(async client => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const criteria = { since: startOfToday() };
    if (from) criteria.from = from;
    const uids = await client.search(criteria, { uid: true });
    if (!uids || !uids.length) return [];
    return fetchMessagesByUid(client, uids);
  });
}

async function findAttachmentBuffer(uid, filename) {
  return withClient(async client => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found`);
    const parsed = await simpleParser(msg.source);
    const att = (parsed.attachments || []).find(a => (a.filename || '') === filename);
    if (!att) throw new Error(`Attachment "${filename}" not found on message ${uid}`);
    return att.content; // Buffer
  });
}

function spreadsheetToText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim();
    if (csv) parts.push(wb.SheetNames.length > 1 ? `Sheet "${sheetName}":\n${csv}` : csv);
  }
  return parts.join('\n\n');
}

async function fetchAttachmentText(messageId, attachmentId) {
  const buffer = await findAttachmentBuffer(messageId, attachmentId);
  const lower = String(attachmentId || '').toLowerCase();
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

// One message by its UID, read-only — the truck window's last resort when the email store does not
// have an order's email. Shaped like the email store's entries (body, attachments, messageId).
async function fetchMessage(uid) {
  return withClient(async client => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const [m] = await fetchMessagesByUid(client, [uid]);
    return m ? { ...m, messageId: m.id } : null;
  });
}

async function fetchAttachmentBytes(messageId, attachmentId) {
  return findAttachmentBuffer(messageId, attachmentId);
}

module.exports = {
  isAuthorized, checkConnection, withClient, PINNED_CERT_FINGERPRINT256,
  fetchRecentEmails, unmarkSeen, fetchEmailsMatching,
  fetchAttachmentText, fetchAttachmentBytes, fetchMessage,
};
