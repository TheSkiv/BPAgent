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
  ].join('\r\n');

  return { terminal, to: DISPATCH_RECIPIENTS[terminal], cc: DISPATCH_CC, subject, text, missing };
}

// The bulk loading order (operator, 2026-11-10; format from Dalius's 15:41 email): bulk is
// ordered first, and the PRK is made once the terminal reports the exact loaded weight. No
// attachment. Subject "PLATES - CARGO (palaidas)". `vessel` comes from the order's release or
// seller (the caller resolves it); `company` is the ordering company's name.
const BULK_LINES = [
  'Grūdovežį reikia pakrauti iki leistino krovumo 40 t (bendros masės)',
  'Prašome po pakrovimo pranešti tikslų svorį – padarysime PRK.',
  'Krovinys turi būti švarus, be priemaišų.',
];
function composeBulkDispatch(order, date, { vessel, company }) {
  const { BULK_DISPATCH_RECIPIENTS } = require('./terminals');
  const plates   = plateText(order.plate);
  const driver   = (excelRow(date, order.plateNorm) || {}).Driver || '';
  const ordered  = cargoName(order.cargo).toUpperCase();
  const lt       = (cargoLtName(order.cargo) || '').toUpperCase();
  const named    = lt && lt !== ordered ? `${ordered} / ${lt}` : ordered;
  const terminal = terminalFor({ vessel, cargo: order.cargo });
  const missing  = [!vessel && 'vessel', !driver && 'driver'].filter(Boolean);
  const subject  = `${plates} - ${lt || ordered} (palaidas)`;
  const text = [
    'Laba diena,',
    '',
    `${plates}${driver ? ' ' + driver : ''}`,
    company || '',
    '',
    `Laivas ${vessel || '—'}`,
    `(${named}) - palaidas`,
    '',
    ...BULK_LINES,
  ].join('\r\n');
  return { terminal, to: BULK_DISPATCH_RECIPIENTS[terminal], cc: DISPATCH_CC, subject, text, missing };
}

// The Lithuanian name of a cargo from cargo_synonyms.json's group (its first name): "Gran AS" →
// "Amonio sulfatas". '' when the cargo is in no group.
function cargoLtName(cargo) {
  try {
    const { groups } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/cargo_synonyms.json'), 'utf8'));
    const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9ąčęėįšųūž]/g, '');
    const g = (groups || []).find(gr => gr.some(name => n(cargo).includes(n(name))));
    return g ? g[0] : '';
  } catch { return ''; }
}

// The company signature, added below the operator's text when the email is sent (owner,
// 2026-11-11): the office's own Outlook signature (Gordey Sebastjanovic's) without a person's
// name — logo, address, phones, e-mail, web. The logo is embedded (Content-ID), not linked.
const LOGO_PATH = path.resolve(__dirname, '../../public/bpa-logo.png');
const LOGO_CID  = 'bpa-logo@bpa.lt';
const CLOSING   = 'Pagarbiai,';
const SIGNATURE = [
  'UAB "BPA"',
  'S.Daukanto str. 37,',
  'LT-92229 Klaipeda, Lithuania',
  'tel: +370-46-355770',
  'mobile: +370-641-81754',
  'e-mail: terminal@bpa.lt',
  'Web: www.bpa.lt',
];
const FONT = "font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:11pt;color:#000000";
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function signatureText() {
  return [CLOSING, ...SIGNATURE].join('\r\n');
}

// logoSrc: "cid:…" in the email, "/bpa-logo.png" in the dashboard preview.
function signatureHtml(logoSrc = `cid:${LOGO_CID}`) {
  const p = inner => `<p style="margin:0;${FONT}">${inner}</p>`;
  const link = (href, label) => `<a href="${href}" style="color:#0563C1">${label}</a>`;
  return [
    p(escHtml(CLOSING)),
    p(`<img src="${logoSrc}" width="122" height="44" alt="BPA" style="width:122px;height:44px;border:0;display:block;margin:6px 0">`),
    ...SIGNATURE.map(line => {
      if (line.startsWith('e-mail: ')) return p(`e-mail:&nbsp;${link('mailto:terminal@bpa.lt', 'terminal@bpa.lt')}`);
      if (line.startsWith('Web: ')) return p(`Web:&nbsp;&nbsp;${link('http://www.bpa.lt/', 'www.bpa.lt')}`);
      return p(escHtml(line));
    }),
  ].join('\n');
}

// The operator's text (as edited on the dashboard) + the signature, as plain text and as HTML.
function withSignature(text) {
  const body = String(text).replace(/\r?\n/g, '\r\n').trimEnd();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>`
    + body.split('\r\n').map(l => `<p style="margin:0;${FONT}">${l.trim() ? escHtml(l) : '&nbsp;'}</p>`).join('\n')
    + `\n<p style="margin:0;${FONT}">&nbsp;</p>\n${signatureHtml()}\n</body></html>`;
  return {
    text: `${body}\r\n\r\n${signatureText()}`,
    html,
    inline: [{ cid: LOGO_CID, filename: 'bpa-logo.png', contentType: 'image/png', buffer: fs.readFileSync(LOGO_PATH) }],
  };
}

// RFC 5322 message, UTF-8 throughout, base64 bodies. With `html`: text/plain and text/html as
// alternatives, the `inline` images (logo) next to them, then the PDF when given.
function buildMime({ from, to, cc, subject, text, html, inline = [], attachment, attachments }) {
  const files = [...(attachment ? [attachment] : []), ...(attachments || [])].filter(Boolean);
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
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(text, 'utf8'))].join('\r\n');
  let body = textPart;
  if (html) {
    const alt = `${boundary}_alt`, rel = `${boundary}_rel`;
    const htmlPart = ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(html, 'utf8'))].join('\r\n');
    const alternative = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`].join('\r\n');
    body = [
      `Content-Type: multipart/related; boundary="${rel}"`, '',
      `--${rel}`, alternative,
      ...inline.map(i => [`--${rel}`, `Content-Type: ${i.contentType}; name="${i.filename}"`, `Content-ID: <${i.cid}>`, `Content-Disposition: inline; filename="${i.filename}"`, 'Content-Transfer-Encoding: base64', '', b64lines(i.buffer)].join('\r\n')),
      `--${rel}--`,
    ].join('\r\n');
  }
  const parts = [
    [`--${boundary}`, body].join('\r\n'),
    ...files.map(a => [`--${boundary}`, `Content-Type: application/pdf; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, 'Content-Transfer-Encoding: base64', '', b64lines(a.buffer)].join('\r\n')),
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

module.exports = { composeDispatch, composeBulkDispatch, buildMime, withSignature, signatureHtml, appendDraft, alreadySent, cargoName, excelRow };
