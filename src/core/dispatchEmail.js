const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { DISPATCH_RECIPIENTS, DISPATCH_CC, terminalFor } = require('./terminals');

// The dispatch email for a submitted PRK (ROADMAP A19), shown on the dashboard for the operator to
// check and send (sent only on their Send — SECURITY.md §5; the office's POP3 clients never see
// server-side Drafts, so appendDraft is no longer used). Format from
// the office's own dispatch emails (2026-11-10): subject "VESSEL CARGO PLATES"; body with the
// cargo and bag count, the vessel, the plates and the driver; the PRK PDF attached (fetched from
// KIPIS in memory, D10).

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');

// The order's row in that day's orders Excel — the driver lives there.
function excelRow(date, plateNorm) {
  const fp = path.join(DATA_DIR, `${date}_orders.xlsx`);
  if (!fs.existsSync(fp)) return null;
  const wb = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const norm = s => String(s || '').replace(/[\s/\\]+/g, '').toLowerCase();
  return rows.find(r => norm(r.Plate) === plateNorm) || null;
}

// "Karbamidas (500) gran." → "Karbamidas gran."; "Trigubas superfosfatas 0-46-0, po 600 kg" →
// "Trigubas superfosfatas 0-46-0" — bag sizes go into the bag count instead.
function cargoName(cargo) {
  return String(cargo || '')
    .replace(/\(\s*\d{3,4}\s*(kg)?\s*\)/gi, '')
    .replace(/,?\s*po\s+\d{3,4}\s*kg\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const plateText = p => String(p || '').replace(/\/+/g, '/');   // "MLL371//RZ817" → "MLL371/RZ817"

// order: an orderStore order (with loadsFrom); date: its order file's date; bagKg: from the cargo.
function composeDispatch(order, date, bagKg) {
  const vessel   = order.loadsFrom?.vessel || '';
  const cargo    = cargoName(order.cargo);
  const plates   = plateText(order.plate);
  const bags     = order.weight ? Math.round(Number(order.weight) / bagKg) : null;
  const driver   = (excelRow(date, order.plateNorm) || {}).Driver || '';
  const terminal = terminalFor({ vessel, cargo: order.cargo });
  const missing  = [!vessel && 'vessel', !driver && 'driver', !bags && 'weight'].filter(Boolean);

  const subject = [vessel, cargo, plates].filter(Boolean).join(' ');
  const text = [
    'Laba diena,',
    '',
    `${cargo}${bags ? ` – ${bags} big bags` : ''}`,
    `Atgabenta: laivas ${vessel || '—'}`,
    '',
    `Transportas: ${plates}`,
    `Vairuotojas: ${driver || '—'}`,
    '',
    'Pagarbiai,',
    'UAB "BPA"',
  ].join('\r\n');

  return { terminal, to: DISPATCH_RECIPIENTS[terminal], cc: DISPATCH_CC, subject, text, missing };
}

// RFC 5322 message: text/plain + one PDF, UTF-8 throughout, base64 bodies.
function buildMime({ from, to, cc, subject, text, attachment }) {
  const b64lines = buf => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
  const enc = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const boundary = `----=_PortSystem_${crypto.randomBytes(12).toString('hex')}`;
  const domain = String(from).split('@')[1] || 'bpa.lt';
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(text, 'utf8'))].join('\r\n'),
    [`--${boundary}`, `Content-Type: application/pdf; name="${attachment.filename}"`, `Content-Disposition: attachment; filename="${attachment.filename}"`, 'Content-Transfer-Encoding: base64', '', b64lines(attachment.buffer)].join('\r\n'),
  ];
  return Buffer.from([...headers, '', ...parts, `--${boundary}--`, ''].join('\r\n'), 'utf8');
}

// Appends the message to the Drafts folder — the one mailbox write the code may do (SECURITY.md
// §5). `\Draft` so mail clients open it as a draft; `\Seen` so it does not show as unread.
async function appendDraft(raw) {
  const { withClient } = require('./imapMail');
  return withClient(async client => {
    const boxes = await client.list();
    const drafts = boxes.find(b => b.specialUse === '\\Drafts');
    if (!drafts) throw new Error('no Drafts folder found on the mail server');
    await client.append(drafts.path, raw, ['\\Draft', '\\Seen']);
    return drafts.path;
  });
}

// Was this truck's dispatch email already sent today? The office Cc's terminal@bpa.lt, so the
// copy is in the inbox: from terminal@bpa.lt, to a dispatch address, naming the tractor plate.
async function alreadySent(plate) {
  const { fetchEmailsMatching } = require('./imapMail');
  const { TERMINAL_EMAILS } = require('./terminals');
  const key = s => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const tractor = key(String(plate).split(/\/+/)[0]);
  const dispatch = Object.values(TERMINAL_EMAILS);
  const emails = await fetchEmailsMatching('from:terminal@bpa.lt');
  return emails.some(e => dispatch.some(d => String(e.to || '').toLowerCase().includes(d))
    && key(`${e.subject} ${e.body}`).includes(tractor));
}

module.exports = { composeDispatch, buildMime, appendDraft, alreadySent, cargoName };
