const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { getSettings, getLogoPath } = require('../config');

async function applyWatermark(inputPath, outputPath, customSettings = {}) {
  const settings = { ...getSettings(), ...customSettings };
  const logoPath = getLogoPath();

  if (!fs.existsSync(logoPath)) {
    // If no church logo uploaded yet, create a default placeholder logo if not exists
    await createDefaultLogo(logoPath);
  }

  // 1. Read input image metadata & orientation
  const image = sharp(inputPath);
  const metadata = await image.metadata();
  
  // Normalize orientation first using sharp().rotate()
  // Sharp automatically reads and applies EXIF orientation when .rotate() is called without args
  const rotatedImage = image.rotate();
  const rotatedMetadata = await rotatedImage.metadata();

  const width = rotatedMetadata.width;
  const height = rotatedMetadata.height;

  // 2. Calculate logo dimensions proportionally
  const logoWidthPercent = settings.logoWidthPercent || 12; // e.g. 12%
  const bottomMarginPercent = settings.bottomMarginPercent || 3; // e.g. 3%

  const targetLogoWidth = Math.round(width * (logoWidthPercent / 100));
  
  // Read logo metadata to maintain aspect ratio
  const logoImage = sharp(logoPath);
  const logoMetadata = await logoImage.metadata();
  const logoAspect = logoMetadata.width / logoMetadata.height;
  const targetLogoHeight = Math.round(targetLogoWidth / logoAspect);

  // Resize logo
  const resizedLogoBuffer = await logoImage
    .resize(targetLogoWidth, targetLogoHeight, { fit: 'contain' })
    .toBuffer();

  // 3. Calculate position (Bottom Center)
  const left = Math.max(0, Math.round((width - targetLogoWidth) / 2));
  const bottomMargin = Math.round(height * (bottomMarginPercent / 100));
  const top = Math.max(0, height - targetLogoHeight - bottomMargin);

  // 4. Composite logo onto image
  let pipeline = rotatedImage.composite([
    {
      input: resizedLogoBuffer,
      top: top,
      left: left,
      blend: 'over'
    }
  ]);

  // 5. Export format & quality preservation
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.png') {
    pipeline = pipeline.png({ lossless: true });
  } else if (ext === '.webp') {
    pipeline = pipeline.webp({ quality: settings.jpegQuality || 95 });
  } else {
    // Default JPEG
    pipeline = pipeline.jpeg({
      quality: settings.jpegQuality || 95,
      chromaSubsampling: '4:4:4',
      mozjpeg: true
    });
  }

  await pipeline.toFile(outputPath);

  // 6. Validate output
  const outputMetadata = await sharp(outputPath).metadata();
  if (
    outputMetadata.width !== width ||
    outputMetadata.height !== height
  ) {
    throw new Error('Output dimensions do not match original dimensions.');
  }

  return {
    width,
    height,
    format: outputMetadata.format
  };
}

async function generatePreview(inputPath, outputPath, customSettings = {}) {
  return await applyWatermark(inputPath, outputPath, customSettings);
}

async function createDefaultLogo(logoPath) {
  const dir = path.dirname(logoPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Create a clean default semi-transparent church logo (e.g. 300x100 PNG with text)
  const svgLogo = `
    <svg width="300" height="100" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="100" fill="rgba(255,255,255,0.85)" rx="12"/>
      <text x="150" y="58" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#1e3a8a" text-anchor="middle">CHURCH LOGO</text>
    </svg>
  `;

  await sharp(Buffer.from(svgLogo))
    .png()
    .toFile(logoPath);
}

module.exports = {
  applyWatermark,
  generatePreview,
  createDefaultLogo
};
