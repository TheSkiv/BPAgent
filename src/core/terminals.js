const { sameCargo } = require('./stockCache');

// The two terminal dispatch addresses this business emails/receives from — confirmed by the
// operator: dispecerine@ is Ro-Ro, ktdispecerine@ is KKT. Shared here so gmailRoute.js's inbound
// gate-pass detection and the outbound draft-email feature both read from one place.
const TERMINAL_EMAILS = {
  roro: 'dispecerine@terminalas.lt',
  kkt:  'ktdispecerine@terminalas.lt',
};

// Everyone a dispatch email goes to, per terminal, and its Cc — the routing table (SECURITY.md
// §5: a draft's recipients come from here, never from an email's content). Taken from the
// office's own dispatch emails of 2026-11-10: KKT ones also go to the gate and two people.
const DISPATCH_RECIPIENTS = {
  roro: [TERMINAL_EMAILS.roro],
  kkt:  [TERMINAL_EMAILS.kkt, 'vidas@terminalas.lt', 'gates@terminalas.lt', 'lina.armonaitiene@terminalas.lt'],
};
const DISPATCH_CC = ['terminal@bpa.lt'];

// Which terminal a truck loads at (operator, 2026-11-10): KKT for ULSAN's ammonium sulphate and
// for NPK 14-14-21 on any vessel; everything else Ro-Ro. KIPIS's storage place is not reliable
// for this (it lists the ULSAN AS lot as Ro-Ro). The rare exception is fixed by hand in the draft.
const KKT_RULES = [
  { vessel: 'ULSAN', cargo: 'Amonio sulfatas' },
  { cargo: '14-14-21' },
];

function terminalFor({ vessel, cargo }) {
  const hit = KKT_RULES.some(r =>
    (!r.vessel || String(vessel || '').toUpperCase() === r.vessel) &&
    (String(cargo || '').includes(r.cargo) || sameCargo(cargo, r.cargo)));
  return hit ? 'kkt' : 'roro';
}

module.exports = { TERMINAL_EMAILS, DISPATCH_RECIPIENTS, DISPATCH_CC, terminalFor };
