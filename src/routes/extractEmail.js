const express        = require('express');
const router         = express.Router();
const { extractAll } = require('../core/emailExtract');

router.post('/', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ error: 'No text provided' });
  const result = extractAll(text);
  console.log('extract-email:', result);
  res.json(result);
});

module.exports = router;
