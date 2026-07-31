const { convert } = require('html-to-text');

/**
 * Normalises a raw Graph API message object into a consistent internal shape.
 * Returns: { messageId, from, senderName, subject, receivedAt, body }
 *
 * html-to-text is used only when body.contentType === 'html', keeping
 * the body as plain text throughout the rest of the pipeline.
 */
function parseGraphMessage(msg) {
  const { emailAddress } = msg.from || {};
  const rawBody = msg.body?.content || '';

  const body =
    msg.body?.contentType === 'html'
      ? convert(rawBody, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] })
      : rawBody;

  return {
    messageId:    msg.id,
    from:         emailAddress?.address || '',
    senderName:   emailAddress?.name    || '',
    subject:      msg.subject           || '',
    receivedAt:   msg.receivedDateTime  || null,
    body:         body.trim(),
  };
}

module.exports = { parseGraphMessage };
