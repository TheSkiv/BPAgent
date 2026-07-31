function cutAtMarkers(text, markers) {
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index !== -1) {
      return text.slice(0, index);
    }
  }
  return text;
}

function cleanText(raw) {
  if (!raw) return "";

  let text = raw;

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n");

  // UPPERCASE FIRST (critical)
  text = text.toUpperCase();

  // Cut forwarded chains
  text = cutAtMarkers(text, [
    "-----ORIGINAL MESSAGE-----",
    "FORWARDED MESSAGE",
    "\nFROM:"
  ]);

  // Cut signatures (EN + LT)
  text = cutAtMarkers(text, [
    "\n--",
    "BEST REGARDS",
    "KIND REGARDS",
    "SENT FROM MY IPHONE",

    // Lithuanian
    "PAGARBIAI",
    "SU PAGARBA",
    "IŠ ANKSTO DĖKOJU",
    "IS ANKSTO DEKOJU",
    "DĖKOJU",
    "DEKOJU",
    "AČIŪ",
    "ACIU",
    "GERO DARBO",
    "LINKĖJIMAI",
    "LINKEJIMAI"
  ]);

  // Trim + collapse
  text = text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join(" ");

  return text;
}

module.exports = { cleanText };
