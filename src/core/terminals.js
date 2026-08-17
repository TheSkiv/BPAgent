// The two terminal dispatch addresses this business emails/receives from — confirmed by the
// operator: dispecerine@ is Ro-Ro, ktdispecerine@ is KKT. Shared here so gmailRoute.js's inbound
// gate-pass detection and the outbound draft-email feature both read from one place.
const TERMINAL_EMAILS = {
  roro: 'dispecerine@terminalas.lt',
  kkt:  'ktdispecerine@terminalas.lt',
};

module.exports = { TERMINAL_EMAILS };
