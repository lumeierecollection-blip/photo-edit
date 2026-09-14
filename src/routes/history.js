const express = require('express');
const router = express.Router();
const { getHistory } = require('../services/jobService');

router.get('/', (req, res) => {
  try {
    const history = getHistory();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
