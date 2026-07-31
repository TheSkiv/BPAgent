/**
 * Extracts truck plate strings from free-form text.
 *
 * Supports:
 *   - Truck/trailer pairs:  ABC123/AB1234  ABC123//AB1234  ABC123 / AB1234
 *   - Single plates:        ABC123
 *
 * Pairs are returned as a single normalised string: "TRUCK/TRAILER"
 * Each item in the returned array becomes one row in the output Excel.
 *
 * Detection strategy (no strict country validation):
 *   - Token = contiguous alphanumeric run, 4–12 chars
 *   - Plate-like = token contains at least one letter AND at least one digit
 *   - Pairs detected first; their component tokens are not re-emitted as singles
 *
 * Countries in scope: Lithuania, Poland, Latvia, Estonia, Ukraine, Kazakhstan, Uzbekistan.
 */

// A valid plate token: 4–12 uppercase alphanumeric chars
const TOKEN_RE = /\b([A-Z0-9]{4,12})\b/g;

// Two plate tokens separated by one or more slashes (with optional surrounding spaces)
const PAIR_RE = /\b([A-Z0-9]{4,12})\s*\/+\s*([A-Z0-9]{4,12})\b/g;

function isPlatelike(token) {
  return /[A-Z]/.test(token) && /[0-9]/.test(token);
}

function extractPlates(rawText) {
  const text = rawText.toUpperCase();
  const seen = new Set();
  const results = [];
  const pairSpans = []; // [start, end] of each pair match, to skip when scanning singles

  // Pass 1: pairs
  for (const m of text.matchAll(PAIR_RE)) {
    const t1 = m[1];
    const t2 = m[2];

    if (!isPlatelike(t1) || !isPlatelike(t2)) continue;

    pairSpans.push([m.index, m.index + m[0].length]);

    const key = `${t1}/${t2}`;
    if (!seen.has(key)) {
      seen.add(key);
      seen.add(t1); // prevent re-emission as standalone
      seen.add(t2);
      results.push(key);
    }
  }

  // Pass 2: standalone plates — skip positions covered by a pair match
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[1];

    if (!isPlatelike(token) || seen.has(token)) continue;

    const inPair = pairSpans.some(
      ([start, end]) => m.index >= start && m.index + token.length <= end
    );
    if (inPair) continue;

    seen.add(token);
    results.push(token);
  }

  return results;
}

module.exports = { extractPlates };
