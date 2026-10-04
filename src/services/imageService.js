const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { getSettings, getLogoPath } = require('../config');
const { extractRawPreview, isRawFileName } = require('./rawPreview');

// sharp keeps recently used files open for speed; on Windows that stops the
// temp copies from being deleted, so never cache files.
sharp.cache({ files: 0 });

// Each EXIF orientation as the rotation (and mirror) that makes it upright.
const ORIENTATION_FIX = {
  1: [0, false], 2: [0, true], 3: [180, false], 4: [180, true],
  5: [90, true], 6: [90, false], 7: [270, true], 8: [270, false]
};

/**
 * Loads a photo as upright pixels. The file is read into memory first, so it
 * is never held open (Windows cannot delete an open file, which left
 * downloaded photos stuck in uploads/temp). Camera RAW files use the
 * full-size JPEG the camera embedded in them.
 */
async function loadUpright(inputPath) {
  const data = fs.readFileSync(inputPath);

  const decode = async (source, orientation) => {
    let pipeline = sharp(source);
    if (orientation === null) {
      pipeline = pipeline.rotate(); // use the photo's own EXIF orientation
    } else {
      const [angle, mirror] = ORIENTATION_FIX[orientation] || ORIENTATION_FIX[1];
      if (mirror) pipeline = pipeline.flop();
      if (angle) pipeline = pipeline.rotate(angle);
    }
    return pipeline.raw().toBuffer({ resolveWithObject: true });
  };
  const fromPreview = async () => {
    const preview = extractRawPreview(data);
    if (!preview) return null;
    const { data: pixels, info } = await decode(preview.jpeg, preview.orientation);
    return { pixels, info, fromRaw: true };
  };

  if (isRawFileName(inputPath)) {
    const result = await fromPreview();
    if (result) return result;
    throw new Error('This camera RAW file has no built-in JPEG to watermark. Export it as a JPEG from the camera or editing software and try again.');
  }

  try {
    const { data: pixels, info } = await decode(data, null);
    return { pixels, info, fromRaw: false };
  } catch (err) {
    // A RAW file saved under another name (e.g. the preview's temp .jpg):
    // fall back to its built-in JPEG only when the file can't be read at all,
    // so a real TIFF photo is never swapped for its small thumbnail.
    const isTiff = /^(II\*\0|MM\0\*)/.test(data.toString('latin1', 0, 4));
    const result = isTiff ? await fromPreview() : null;
    if (result) return result;
    throw err;
  }
}

// The church logo is the red cross with the church's name written beneath it.
// Photos only get the cross: the coloured part of the logo is found and the
// rest (the black lettering) is cropped away. A logo with no colour in it (an
// all-black or all-white one) is used whole, since there is no mark to isolate.
const logoMarkCache = { key: null, buffer: null };

async function loadLogoMark(logoPath) {
  const stat = fs.statSync(logoPath);
  const key = `${logoPath}:${stat.mtimeMs}:${stat.size}`;
  if (logoMarkCache.key === key) return logoMarkCache.buffer;

  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1, coloured = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 40) continue;
      const hi = Math.max(data[i], data[i + 1], data[i + 2]);
      const lo = Math.min(data[i], data[i + 1], data[i + 2]);
      if (hi - lo < 70) continue; // grey, black or white: lettering, not the mark
      coloured++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  let buffer = fs.readFileSync(logoPath);
  // Enough coloured pixels to be a real mark, not a stray speck.
  if (coloured > width * height * 0.005 && maxX > minX && maxY > minY) {
    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    buffer = await sharp(logoPath)
      .extract({ left, top, width: Math.min(width, maxX + pad + 1) - left, height: Math.min(height, maxY + pad + 1) - top })
      .png()
      .toBuffer();
  }
  logoMarkCache.key = key;
  logoMarkCache.buffer = buffer;
  return buffer;
}

async function applyWatermark(inputPath, outputPath, customSettings = {}) {
  const settings = { ...getSettings(), ...customSettings };
  const logoPath = getLogoPath();

  if (!fs.existsSync(logoPath)) {
    // If no church logo uploaded yet, create a default placeholder logo if not exists
    await createDefaultLogo(logoPath);
  }

  // 1. Load the photo upright, and measure it after rotation, so sideways
  // (portrait) camera photos get the right width and height.
  const { pixels, info, fromRaw } = await loadUpright(inputPath);
  const rotatedImage = sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } });

  const width = info.width;
  const height = info.height;

  // 2. Calculate logo dimensions proportionally
  const logoWidthPercent = settings.logoWidthPercent || 12; // e.g. 12%
  const opacity = Math.min(100, Math.max(1, Number(settings.watermarkOpacity) || 35)) / 100;

  const targetLogoWidth = Math.round(width * (logoWidthPercent / 100));
  
  // Only the church's mark goes on photos, not the name written beneath it.
  // Read logo metadata to maintain aspect ratio
  const logoImage = sharp(await loadLogoMark(logoPath));
  const logoMetadata = await logoImage.metadata();
  const logoAspect = logoMetadata.width / logoMetadata.height;
  const targetLogoHeight = Math.round(targetLogoWidth / logoAspect);

  // Resize logo
  const resizedLogo = await logoImage
    .resize(targetLogoWidth, targetLogoHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  // Turn the logo into a faint, single-color silhouette: keep only its shape
  // (alpha channel), scaled by the opacity, and paint it in the watermark color
  // so it never competes with the photo's own colors
  const { width: logoW, height: logoH } = resizedLogo.info;
  const fadedAlpha = await sharp(resizedLogo.data)
    .extractChannel('alpha')
    .raw()
    .toBuffer();
  for (let i = 0; i < fadedAlpha.length; i++) {
    fadedAlpha[i] = Math.round(fadedAlpha[i] * opacity);
  }
  const lightLayer = await sharp({
    create: { width: logoW, height: logoH, channels: 3, background: settings.watermarkColor || '#f0f0f0' }
  })
    .joinChannel(fadedAlpha, { raw: { width: logoW, height: logoH, channels: 1 } })
    .png()
    .toBuffer();

  // A light logo alone vanishes on bright parts of a photo (white walls, stage
  // lights, light clothing). A soft dark halo around it keeps the shape
  // readable on light and dark areas alike, while staying see-through.
  const blurSigma = Math.max(1, logoW * 0.004);
  const shadowAlpha = await sharp(fadedAlpha, { raw: { width: logoW, height: logoH, channels: 1 } })
    .blur(blurSigma)
    .extractChannel(0) // blur can widen the mask to three channels; keep one
    .raw()
    .toBuffer();
  for (let i = 0; i < shadowAlpha.length; i++) {
    shadowAlpha[i] = Math.min(255, Math.round(shadowAlpha[i] * 0.9));
  }
  const shadowLayer = await sharp({ create: { width: logoW, height: logoH, channels: 3, background: '#000000' } })
    .joinChannel(shadowAlpha, { raw: { width: logoW, height: logoH, channels: 1 } })
    .png()
    .toBuffer();

  const resizedLogoBuffer = await sharp({ create: { width: logoW, height: logoH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shadowLayer }, { input: lightLayer }])
    .png()
    .toBuffer();

  // 3. Calculate position (Dead Center)
  const left = Math.max(0, Math.round((width - targetLogoWidth) / 2));
  const top = Math.max(0, Math.round((height - targetLogoHeight) / 2));

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

  // 6. Validate output (read from memory so the file isn't left open)
  const outputMetadata = await sharp(fs.readFileSync(outputPath)).metadata();
  if (
    outputMetadata.width !== width ||
    outputMetadata.height !== height
  ) {
    throw new Error('Output dimensions do not match original dimensions.');
  }

  return {
    width,
    height,
    format: outputMetadata.format,
    fromRaw
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
