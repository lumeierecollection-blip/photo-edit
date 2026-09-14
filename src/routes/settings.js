const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getSettings, saveSettings, getLogoPath } = require('../config');

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for logo
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG or JPEG logo files are supported.'));
    }
  }
});

router.get('/', (req, res) => {
  res.json(getSettings());
});

router.post('/', (req, res) => {
  try {
    const updated = saveSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logo', upload.single('logo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No logo file provided.' });
    }

    const targetPath = getLogoPath();
    fs.renameSync(req.file.path, targetPath);

    res.json({ success: true, message: 'Logo uploaded and updated successfully.' });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/logo', (req, res) => {
  const logoPath = getLogoPath();
  if (fs.existsSync(logoPath)) {
    res.sendFile(logoPath);
  } else {
    res.status(404).json({ error: 'Logo not found.' });
  }
});

module.exports = router;
