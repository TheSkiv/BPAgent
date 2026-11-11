// The CMR (international consignment note), drawn on blank A4 like the one Avilda prints
// (owner, 2026-11-11: "print out the same style CMRs instead of Avilda"). Layout follows the
// office's own Avilda printouts (Y:\Scaner_Agensy\CMR templates.pdf). Positions are written in
// the pixels of that scan (924 × 1306) and converted to PDF points, so the two can be compared
// box by box. Arial (Windows) is embedded for the Lithuanian letters.
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const PAGE_W = 595.28, PAGE_H = 841.89;
const S = PAGE_W / 924;
const X = px => px * S;
const Y = py => PAGE_H - py * S;

const L = 62, R = 868, MID = 468;            // outer edges and the column divider
const INK = rgb(0, 0, 0), GREY = rgb(0.45, 0.45, 0.45), MARK = rgb(0.78, 0.78, 0.78);
const FONT_DIR = process.env.CMR_FONT_DIR || 'C:\\Windows\\Fonts';

async function fonts(pdf) {
  pdf.registerFontkit(fontkit);
  return {
    reg:  await pdf.embedFont(fs.readFileSync(`${FONT_DIR}\\arial.ttf`), { subset: true }),
    bold: await pdf.embedFont(fs.readFileSync(`${FONT_DIR}\\arialbd.ttf`), { subset: true }),
  };
}

function painter(page, f) {
  const line = (x1, y1, x2, y2, w = 0.6, color = INK) => page.drawLine({ start: { x: X(x1), y: Y(y1) }, end: { x: X(x2), y: Y(y2) }, thickness: w, color });
  const hair = (x1, x2, y) => line(x1, y, x2, y, 0.35, GREY);
  const text = (s, x, y, { size = 9.5, bold = false, color = INK, align = 'left', maxPx } = {}) => {
    s = String(s ?? '');
    if (!s) return;
    const font = bold ? f.bold : f.reg;
    let width = font.widthOfTextAtSize(s, size);
    if (maxPx && width > X(maxPx)) { size = size * X(maxPx) / width; width = font.widthOfTextAtSize(s, size); }
    const x0 = align === 'right' ? X(x) - width : align === 'center' ? X(x) - width / 2 : X(x);
    page.drawText(s, { x: x0, y: Y(y), size, font, color });
  };
  // A box label: the big number, then the Lithuanian and English lines in small type.
  const label = (n, lt, en, x, y) => {
    let dx = 0;
    if (n) { text(n, x, y + 19, { size: 12, bold: true }); dx = f.bold.widthOfTextAtSize(String(n), 12) / S + 4; }
    text(lt, x + dx, y + 10, { size: 5.6 });
    if (en) text(en, x + dx, y + 17, { size: 5.6 });
  };
  return { line, hair, text, label };
}

// data: see sampleData() for the shape. Returns the PDF bytes.
async function buildCmr(data) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`CMR ${data.number || ''}`.trim());
  pdf.setCreator('PortSystem (UAB "BPA")');
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const f = await fonts(pdf);
  const { line, hair, text, label } = painter(page, f);
  const rows = (lines, x, ys, opts) => (lines || []).forEach((s, i) => ys[i] !== undefined && text(s, x, ys[i], opts));

  // ── Corner number and outer frame ────────────────────────────────────────
  text(data.number, R, 16, { size: 10.5, align: 'right' });
  line(L, 40, R, 40, 0.9); line(L, 40, L, 1215, 0.9); line(R, 40, R, 1215, 0.9); line(L, 1215, R, 1215, 0.9);
  line(MID, 40, MID, 466, 0.9);

  // ── Box 1: sender ────────────────────────────────────────────────────────
  label('1', 'Siuntėjas (pavadinimas, adresas, šalis)', 'Sender (name, address, country)', L + 6, 40);
  for (const y of [79, 99, 119, 139]) hair(L + 4, MID - 4, y);
  rows(data.sender, L + 18, [74, 94, 114, 134]);
  line(L, 145, R, 145, 0.9);

  // ── Title and the convention text ────────────────────────────────────────
  text('TARPTAUTINIS KROVINIŲ TRANSPORTAVIMO', MID + 14, 57, { size: 10, bold: true, maxPx: 790 - MID - 14 });
  text('VAŽTARAŠTIS', MID + 14, 71, { size: 10, bold: true });
  text('INTERNATIONAL CONSIGNMENT NOTE', MID + 14, 86, { size: 10, bold: true, maxPx: 790 - MID - 14 });
  page.drawEllipse({ x: X(830), y: Y(70), xScale: X(28), yScale: X(14), borderColor: INK, borderWidth: 1.4 });
  text('CMR', 830, 75, { size: 9.5, bold: true, align: 'center' });
  const conv = ['Šis pervežimas vykdomas, neatsižvel-', 'giant į kitus susitarimus, pagal Tarptau-', 'tinių krovinių pervežimo sutarčių kon-', 'vencija (CMR)'];
  const convEn = ['This carriage is subject, notwithstan-', 'ding any clause to the contrary, to', 'the Convention on the Contract for', 'the International Carriage of goods', 'by read (CMR)'];
  conv.forEach((s, i) => text(s, MID + 14, 104 + i * 9, { size: 5.8 }));
  convEn.forEach((s, i) => text(s, 680, 104 + i * 9, { size: 5.8 }));

  // ── Box 2: consignee · Box 16: carrier ───────────────────────────────────
  label('2', 'Gavėjas (pavadinimas, adresas, šalis)', 'Consignee (name, address, country)', L + 6, 145);
  for (const y of [185, 205, 225, 245]) hair(L + 4, MID - 4, y);
  rows(data.consignee, L + 18, [181, 201, 221, 241]);
  label('16', 'Vežėjas (pavadinimas, adresas, šalis)', 'Carrier (name, address, country)', MID + 10, 145);
  for (const y of [185, 205, 225, 245]) hair(MID + 4, R - 4, y);
  rows(data.carrier, (MID + R) / 2, [181, 201, 221, 241], { align: 'center' });
  line(L, 255, R, 255, 0.9);

  // ── Box 3: place of delivery · Box 17: successive carriers ──────────────
  label('3', 'Krovinio iškrovimo vieta', 'Place of delivery of the goods', L + 6, 255);
  text('Vieta/Place', L + 4, 292, { size: 6.2 }); text(data.delivery?.place, L + 74, 292, { maxPx: MID - L - 80 });
  text('Šalis/Country', L + 4, 311, { size: 6.2 }); text(data.delivery?.address, L + 74, 311, { maxPx: MID - L - 80 });
  text(data.delivery?.extra, L + 4, 330, { maxPx: MID - L - 10 });
  for (const y of [297, 316, 336]) hair(L + 4, MID - 4, y);
  label('17', 'Sekantis vežėjas (pavadinimas, adresas, šalis)', 'Successive carriers (name, address, country)', MID + 10, 255);
  for (const y of [297, 316, 336]) hair(MID + 4, R - 4, y);
  rows(data.successive, MID + 18, [292, 311, 330]);
  line(L, 345, MID, 345, 0.9);

  // ── Box 4: place and date of taking over ────────────────────────────────
  label('4', 'Krovinio pakrovimo vieta ir data', 'Place and date of taking over the goods', L + 6, 345);
  text('Vieta/Place', L + 4, 382, { size: 6.2 }); text(data.loading?.place, L + 74, 382, { maxPx: MID - L - 80 });
  text('Šalis/Country', L + 4, 401, { size: 6.2 }); text(data.loading?.address, L + 74, 401, { maxPx: MID - L - 80 });
  text('Data/Date', L + 4, 420, { size: 6.2 }); text(data.loading?.date, L + 74, 420);
  for (const y of [387, 406, 425]) hair(L + 4, MID - 4, y);
  line(L, 430, MID, 430, 0.9);

  // ── Box 18: carrier's reservations ──────────────────────────────────────
  for (const y of [355, 365]) hair(MID + 4, R - 4, y);
  line(MID, 372, R, 372, 0.9);
  label('18', 'Vežėjo sąlygos ir pastabos', 'Carrier\'s reservations and observations', MID + 10, 372);
  for (const y of [414, 432, 450]) hair(MID + 4, R - 4, y);
  rows(data.reservations, MID + 14, [410, 428, 446]);

  // ── Box 5: documents attached ───────────────────────────────────────────
  label('5', 'Pridedami dokumentai', 'Documents attached', L + 6, 430);
  text(data.documents, L + 18, 461, { maxPx: R - L - 24 });
  line(L, 466, R, 466, 0.9);

  // ── Boxes 6–12: the goods ───────────────────────────────────────────────
  const cols = [L, 196, 296, 400, 578, 678, 778, R];
  line(L, 506, R, 506, 0.9);
  label('6', 'Ženklai ir numeriai', 'Marks and Nos', L + 6, 470);
  label('7', 'Vietų skaičius', 'Number of packages', 200, 470);
  label('8', 'Įpakavimo būdas', 'Method of packing', 300, 470);
  label('9', 'Krovinio pavadinimas*', 'Nature of the goods*', 405, 470);
  label('10', 'Statistinis Nr.', 'Statist. number', 582, 470);
  label('11', 'Svoris bruto, kg', 'Gross weight in kg', 682, 470);
  label('12', 'Tūris, m³', 'Volume in m³', 782, 470);
  for (const x of cols.slice(4, 7)) line(x, 470, x, 765, 0.6);
  for (let y = 542; y < 760; y += 18) hair(L + 4, R - 4, y);
  // The big grey CMR mark, as on the printed form
  page.drawEllipse({ x: X(468), y: Y(634), xScale: X(132), yScale: X(52), borderColor: MARK, borderWidth: 9 });
  text('CMR', 468, 664, { size: 64, bold: true, color: MARK, align: 'center' });
  (data.goods || []).forEach((g, i) => text(g.text, g.indent ? 190 : L + 18, 537 + i * 18, { maxPx: 578 - L - 24 }));
  text(data.statNo, 628, 537, { align: 'center' });
  text(data.grossKg, 728, 539, { align: 'center' });
  text(data.volume, 823, 539, { align: 'center' });
  line(L, 765, R, 765, 0.9);

  // ── ADR line and box 13: sender's instructions ──────────────────────────
  text('Klasė', L + 4, 771, { size: 5.6 }); text('Class', L + 4, 778, { size: 5.6 });
  text('Skaičius', 172, 771, { size: 5.6 }); text('Number', 172, 778, { size: 5.6 });
  text('Raidė', 280, 771, { size: 5.6 }); text('Letter', 280, 778, { size: 5.6 });
  text('Sutartis', 412, 771, { size: 5.6 }); text('(ADR)', 412, 778, { size: 5.6 });
  label('13', 'Siuntėjo nurodymai (muitinės ir kita informacija)', 'Sender\'s instructions (custom\'s and another information)', L + 6, 781);
  for (const y of [834, 854, 873]) hair(L + 4, MID - 4, y);
  rows(data.instructions, L + 18, [829, 849, 868]);
  text('Pareikštoji krovinio vertė', L + 4, 886, { size: 5.6 }); text('Stated value of the goods', L + 4, 893, { size: 5.6 });
  hair(L + 4, MID - 4, 915);

  // ── Box 19: to be paid by ───────────────────────────────────────────────
  line(MID, 781, R, 781, 0.9); line(MID, 781, MID, 925, 0.9);
  label('19', 'Apmokėjimui:', 'To be paid by:', MID + 8, 781);
  const pay = [['Pervežimo kaina', 'Carriage charges'], ['Nuolaida', 'Deductions'], ['Skirtumas', 'Balance'], ['Priedai', 'Supplem. charges'], ['Papildoma rinkliava', 'Additional charges'], ['Kiti', 'Other'], ['Viso apmokėjimui', 'Total']];
  pay.forEach(([lt, en], i) => { const y = 806 + i * 17; text(lt, MID + 4, y, { size: 5.4 }); text(en, MID + 4, y + 6.5, { size: 5.4 }); hair(MID + 4, R - 4, y + 9); });
  for (const x of [568, 665, 765]) line(x, 781, x, 925, 0.5);
  text('Siuntėjas', 616, 788, { size: 5.6, align: 'center' }); text('Sender', 616, 795, { size: 5.6, align: 'center' });
  text('Valiuta', 715, 788, { size: 5.6, align: 'center' }); text('Currency', 715, 795, { size: 5.6, align: 'center' });
  text('Gavėjas', 816, 788, { size: 5.6, align: 'center' }); text('Consignee', 816, 795, { size: 5.6, align: 'center' });
  line(L, 925, R, 925, 0.9);

  // ── Boxes 14, 15, 20 ────────────────────────────────────────────────────
  label('14', 'Grąžinimas', 'Restitution', L + 6, 925);
  line(L, 945, R, 945, 0.9);
  label('15', 'Apmokėjimo sąlygos', 'Instructions as to payment for carriage', L + 6, 945);
  line(MID, 945, MID, 985, 0.9);
  label('20', 'Ypatingos suderintos sąlygos', 'Special agreements', MID + 10, 945);
  rows(data.special, MID + 18, [978]);
  hair(L + 4, R - 4, 985); hair(L + 4, R - 4, 1003);
  line(L, 1008, R, 1008, 0.9);

  // ── Boxes 21–24: signatures ─────────────────────────────────────────────
  label('21', 'Surašyta', 'Established in', L + 6, 1010);
  text(data.establishedIn, 172, 1024);
  text('Data', 322, 1019, { size: 5.6 }); text('on', 322, 1026, { size: 5.6 });
  text(data.date, 345, 1024);
  hair(165, 315, 1029); hair(340, 470, 1029);
  line(L, 1034, 618, 1034, 0.6);
  line(618, 1008, 618, 1125, 0.9);
  label('24', 'Krovinys gautas', 'Goods received', 626, 1010);
  text('Data', 780, 1019, { size: 5.6 }); text('Date', 780, 1026, { size: 5.6 });
  text('on ______________ 20___', 700, 1048, { size: 6.2 });
  label('22', '', '', L + 6, 1034);
  const arr = (x, y, lt, en) => { text(lt, x, y, { size: 5.6 }); text(en, x, y + 7, { size: 5.6 }); text('Išvykimas', x, y + 14, { size: 5.6 }); text('Departure', x, y + 21, { size: 5.6 }); text('_____ val. _____ min.', x + 125, y + 7, { size: 5.6 }); text('_____ val. _____ min.', x + 125, y + 21, { size: 5.6 }); };
  arr(L + 4, 1064, 'Atvykimas pakrovimui', 'Arrival for loading');
  arr(626, 1058, 'Atvykimas iškrovimui', 'Arrival for unloading');
  line(320, 1034, 320, 1125, 0.6);
  label('23', 'Kelionės lapas', '', 326, 1034);
  hair(410, 520, 1047); text('20___', 528, 1046, { size: 6.2 });
  text('Vairuotojų', 345, 1066, { size: 6.2 }); text('pavardės', 345, 1084, { size: 6.2 });
  text(data.driver, 405, 1066, { maxPx: 205 });
  hair(398, 612, 1070);
  text('Siuntėjo parašas ir spaudas', L + 4, 1110, { size: 5.6 }); text('Signature and stamp of the sender', L + 4, 1117, { size: 5.6 });
  text('Vežėjo parašas ir spaudas', 326, 1110, { size: 5.6 }); text('Signature and stamp of the carrier', 326, 1117, { size: 5.6 });
  text('Gavėjo parašas ir spaudas', 626, 1110, { size: 5.6 }); text('Signature and stamp of the consignee', 626, 1117, { size: 5.6 });
  line(L, 1125, R, 1125, 0.9);

  // ── Boxes 25–27: vehicle ────────────────────────────────────────────────
  label('25', 'Registracinis nr./Vehicle reg. no.', 'Vilkikas/Tow Puspriek./Semitrailer', L + 6, 1125);
  line(265, 1125, 265, 1215, 0.6);
  label('26', 'Markė/Type', 'Vilkikas/Tow Puspriek./Semitrailer', 271, 1125);
  line(465, 1125, 465, 1215, 0.6);
  label('27', 'Tarifas', 'už 1 km', 471, 1125);
  const tariff = [[530, 'Tarifinis', 'atstumas'], [592, '% už naudojimąsi', 'vilkiku/puspriek.'], [662, 'Zonos', 'koef.'], [728, 'Kiti', 'mokėjimai'], [800, 'VISO', '']];
  tariff.forEach(([x, a, b]) => { line(x, 1125, x, 1215, 0.5); text(a, x + 4, 1135, { size: 5.4 }); text(b, x + 4, 1142, { size: 5.4 }); });
  line(L, 1150, R, 1150, 0.6);
  text(data.plates, L + 18, 1173);
  text(data.vehicleType, 280, 1173);
  line(L, 1185, R, 1185, 0.6);

  text('Parengta PortSystem, UAB "BPA"', L, 1232, { size: 6.4, color: GREY });
  return Buffer.from(await pdf.save());
}

module.exports = { buildCmr };
