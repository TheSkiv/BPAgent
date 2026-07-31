const fs   = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../../config/sender_companies.json');

// Domains with no company signal of their own — dispatchers on these send from a personal
// account, so the display name (not the domain) is what actually carries the company.
const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com']);

function parseAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

function loadMap() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function saveMap(map) {
  fs.writeFileSync(FILE, JSON.stringify(map, null, 1));
}

// Small trucking outfits often sign with the company name in both the "first" and "last"
// name slot (e.g. "Transwina Transwina") — collapse that to just the one word.
function collapseRepeatedWord(name) {
  const words = name.trim().split(/\s+/);
  if (words.length === 2 && words[0].toLowerCase() === words[1].toLowerCase()) return words[0];
  return name;
}

// Manual assignment always wins. Otherwise: corporate domain -> domain name; free-mail domain
// -> display name if present. Returns '' when none of that establishes a company.
function deriveCompany(sender) {
  const email = parseAddress(sender);
  const map   = loadMap();
  if (map[email]) return map[email];

  const domain = email.split('@')[1] || '';
  if (domain && !FREE_MAIL_DOMAINS.has(domain)) {
    const parts = domain.split('.');
    const name  = parts.length > 1 ? parts[0] : domain;
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  }

  const m = String(sender || '').match(/^"?([^"<]*)"?\s*<[^>]+>/);
  const displayName = m ? m[1].trim() : '';
  return displayName ? collapseRepeatedWord(displayName) : '';
}

function setCompany(sender, company) {
  const email = parseAddress(sender);
  if (!email) return false;
  const map = loadMap();
  map[email] = company;
  saveMap(map);
  return true;
}

module.exports = { deriveCompany, setCompany, parseAddress };
