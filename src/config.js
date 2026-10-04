const path = require('path');
const fs = require('fs');

const SETTINGS_FILE = path.join(__dirname, '../uploads/settings.json');

const DEFAULT_SETTINGS = {
  logoWidthPercent: 48, // 48% of image width
  watermarkOpacity: 35, // see-through watermark in the center (a soft dark edge keeps it readable on bright photos)
  watermarkColor: '#f0f0f0', // whitish grey; the logo's own colors are not used
  jpegQuality: 95,
  outputFolderSuffix: ' — Watermarked',
  includeSubfolders: false,
  maxConcurrent: 5,
  retryCount: 3,

  // Video Converter (advanced). Defaults need no configuration.
  videoOutputFolderSuffix: ' — MP4 Converted',
  videoCodec: 'h264', // 'h264' (most compatible) or 'hevc'
  videoCrf: 18, // visually lossless for H.264
  videoPreset: 'medium',
  videoAudioBitrateKbps: 256, // per stereo pair when audio must be re-encoded
  videoKeepHevc: false, // remux H.265 sources instead of converting them to H.264
  videoPreserveMetadata: true,
  videoMaxConcurrentFiles: 0, // 0 = automatic
  videoMaxConcurrentEncodes: 0, // 0 = automatic
  videoRetryCount: 5,
  videoFullDecodeCheck: false, // decode every frame of each output (slow) instead of sampling

  // Church News
  newsWhisperModel: 'base', // 'tiny' (fastest), 'base', or 'small' (most accurate, slowest)
  newsLanguage: 'english', // spoken language, or 'auto' to detect it
  newsTranslateToEnglish: false, // write the transcript in English when another language is spoken
  newsNetworkName: 'Church News' // name on the news studio's corner badge
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
