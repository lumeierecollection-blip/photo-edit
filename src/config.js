const path = require('path');
const fs = require('fs');

const SETTINGS_FILE = path.join(__dirname, '../uploads/settings.json');

const DEFAULT_SETTINGS = {
  logoWidthPercent: 48, // 48% of image width
  bottomMarginPercent: 3, // 3% of image height
  logoOpacity: 100, // 100%
  jpegQuality: 95,
  outputFolderSuffix: ' — Watermarked',
  includeSubfolders: false,
  maxConcurrent: 5,
  retryCount: 3
};

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Error reading settings file:', err);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(newSettings) {
  try {
    const current = getSettings();
    const updated = { ...current, ...newSettings };
    const uploadsDir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (err) {
    console.error('Error saving settings file:', err);
    throw err;
  }
}

function getLogoPath() {
  const defaultLogo = path.join(__dirname, '../uploads/church-logo.png');
  return defaultLogo;
}

module.exports = {
  getSettings,
  saveSettings,
  getLogoPath,
  DEFAULT_SETTINGS
};
