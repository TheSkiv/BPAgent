/**
 * Microsoft Graph API client — real implementation.
 *
 * Auth:    OAuth2 client credentials flow (app-only / no user sign-in).
 * Env:     GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_USER_EMAIL
 * Runtime: Node 18+ (built-in fetch used; no extra dependencies).
 *
 * NOTE — /me vs /users/{email}:
 *   The spec mentions /me/messages, but /me requires delegated (user) auth.
 *   Client credentials is app-only, so the correct endpoint is:
 *     /v1.0/users/{GRAPH_USER_EMAIL}/messages
 *   Grant the app "Mail.Read" (Application permission) in Azure AD.
 *
 * Token caching:
 *   Access tokens are cached in memory for the lifetime of the process.
 *   A 60-second buffer before the stated expiry triggers a proactive refresh.
 *   This is sufficient for a CLI tool that runs and exits.
 */

const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const TOKEN_BASE  = 'https://login.microsoftonline.com';

// ── token cache ───────────────────────────────────────────────────────────────

let _cachedToken     = null;
let _tokenExpiresAt  = 0;   // epoch ms

async function fetchNewToken() {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = process.env;

  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error(
      'Missing Graph credentials. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, ' +
      'GRAPH_CLIENT_SECRET in .env'
    );
  }

  const res = await fetch(
    `${TOKEN_BASE}/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     GRAPH_CLIENT_ID,
        client_secret: GRAPH_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Token request failed [${res.status}]: ${detail}`);
  }

  return res.json();
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }

  const data       = await fetchNewToken();
  _cachedToken     = data.access_token;
  _tokenExpiresAt  = Date.now() + (data.expires_in - 60) * 1000;

  return _cachedToken;
}

// ── HTML stripping ────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')   // remove style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')  // remove script blocks
    .replace(/<[^>]+>/g, ' ')                    // remove all tags
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function toPlainText(body) {
  const content = body?.content || '';
  return body?.contentType === 'html' ? stripHtml(content) : content;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function getMessages() {
  const token = await getToken();
  const email = process.env.GRAPH_USER_EMAIL;

  if (!email) {
    throw new Error('GRAPH_USER_EMAIL is not set in .env');
  }

  const params = new URLSearchParams({
    $select:  'id,subject,from,receivedDateTime,body',
    $filter:  'isRead eq false',
    $top:     '50',
  });

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(email)}/messages?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Messages fetch failed [${res.status}]: ${detail}`);
  }

  const data = await res.json();

  // Return the same shape the rest of the pipeline expects (emailParser.parseGraphMessage).
  // HTML is resolved here; contentType is always 'text' on return so emailParser
  // does not attempt a second html-to-text pass.
  return (data.value || []).map((msg) => ({
    id:               msg.id,
    subject:          msg.subject || '',
    from:             msg.from,                  // { emailAddress: { name, address } }
    receivedDateTime: msg.receivedDateTime,
    body: {
      contentType: 'text',
      content:     toPlainText(msg.body),
    },
  }));
}

async function markAsRead(messageId) {
  const token = await getToken();
  const email = process.env.GRAPH_USER_EMAIL;

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(email)}/messages/${messageId}`,
    {
      method:  'PATCH',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`markAsRead failed [${res.status}]: ${detail}`);
  }
}

module.exports = { getMessages, markAsRead };
