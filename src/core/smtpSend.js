const tls = require('tls');
const { PINNED_CERT_FINGERPRINT256 } = require('./imapMail');

// Sends one ready-built message through mail.bpa.lt (SMTP over TLS, port 465) as terminal@bpa.lt.
// Only ever called when the operator presses Send on the dashboard for one dispatch email
// (SECURITY.md §5, operator 2026-11-10: the office reads mail over POP3, so a server-side draft
// was invisible). Same pinned certificate as IMAP (Avast re-signs both); same account, from .env.
// A minimal client — EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA — no new dependency.

function smtpOptions() {
  const host = process.env.SMTP_HOST || process.env.IMAP_HOST;
  const user = process.env.SMTP_USER || process.env.IMAP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD;
  if (!host || !user || !pass) throw new Error('Mail credentials not configured — check .env');
  return { host, port: Number(process.env.SMTP_PORT) || 465, user, pass };
}

// raw: the RFC 5322 message (Buffer); envelope: { from, recipients: [...] } — every To and Cc.
// authOnly: log in and quit — checks the account without sending anything.
async function sendRaw(raw, { from, recipients, authOnly = false }) {
  const o = smtpOptions();
  const sock = tls.connect({
    host: o.host, port: o.port, servername: o.host, rejectUnauthorized: false,
    checkServerIdentity: (_h, cert) => cert.fingerprint256 === PINNED_CERT_FINGERPRINT256
      ? undefined
      : new Error(`SMTP TLS certificate fingerprint mismatch — expected the pinned mail.bpa.lt cert, got ${cert.fingerprint256}`),
  });
  sock.setTimeout(30000, () => sock.destroy(new Error('SMTP timeout')));

  // One reply = lines until one whose 4th char is a space ("250 ..." after "250-...").
  let buffer = '', waiter = null;
  sock.on('data', d => { buffer += d.toString('utf8'); if (waiter) waiter(); });
  const reply = () => new Promise((resolve, reject) => {
    const check = () => {
      const m = buffer.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (!m) return;
      const end = buffer.indexOf(m[0]) + m[0].length;
      const text = buffer.slice(0, end); buffer = buffer.slice(end); waiter = null;
      resolve({ code: Number(m[2]), text: text.trim() });
    };
    waiter = check;
    sock.once('error', reject);
    check();
  });
  const cmd = async (line, expect) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'}: ${r.text.replace(/\r\n/g, ' | ')}`);
    return r;
  };

  try {
    await new Promise((resolve, reject) => { sock.once('secureConnect', resolve); sock.once('error', reject); });
    await cmd(null, [220]);
    await cmd('EHLO portsystem.bpa.lt', [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(Buffer.from(o.user).toString('base64'), [334]);
    await cmd(Buffer.from(o.pass).toString('base64'), [235]);
    if (authOnly) { await cmd('QUIT', [221]).catch(() => {}); return 'login ok'; }
    await cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251]);
    await cmd('DATA', [354]);
    // Dot-stuffing: a line starting with "." gets a second one.
    const body = raw.toString('utf8').replace(/\r\n\./g, '\r\n..');
    sock.write(body.endsWith('\r\n') ? body : body + '\r\n');
    const done = await cmd('.', [250]);
    await cmd('QUIT', [221]).catch(() => {});
    return done.text;
  } finally {
    sock.destroy();
  }
}

const checkLogin = () => sendRaw(null, { authOnly: true });

module.exports = { sendRaw, checkLogin };
