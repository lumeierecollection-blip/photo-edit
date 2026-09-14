const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { applyWatermark } = require('../src/services/imageService');

describe('Image Service & Watermarking Engine', () => {
  const tempDir = path.join(__dirname, '../uploads/temp');
  
  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  test('should apply watermark to landscape image and preserve dimensions', async () => {
    const inputPath = path.join(tempDir, 'test_landscape.jpg');
    const outputPath = path.join(tempDir, 'out_landscape.jpg');

    await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 200, g: 200, b: 200 }
      }
    })
      .jpeg()
      .toFile(inputPath);

    const result = await applyWatermark(inputPath, outputPath);

    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
    expect(fs.existsSync(outputPath)).toBe(true);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }, 10000);

  test('should apply watermark to portrait image and preserve dimensions', async () => {
    const inputPath = path.join(tempDir, 'test_portrait.jpg');
    const outputPath = path.join(tempDir, 'out_portrait.jpg');

    await sharp({
      create: {
        width: 800,
        height: 1200,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    })
      .jpeg()
      .toFile(inputPath);

    const result = await applyWatermark(inputPath, outputPath);

    expect(result.width).toBe(800);
    expect(result.height).toBe(1200);
    expect(fs.existsSync(outputPath)).toBe(true);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }, 10000);

  test('should apply watermark to square image and preserve dimensions', async () => {
    const inputPath = path.join(tempDir, 'test_square.jpg');
    const outputPath = path.join(tempDir, 'out_square.jpg');

    await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: { r: 50, g: 200, b: 100 }
      }
    })
      .jpeg()
      .toFile(inputPath);

    const result = await applyWatermark(inputPath, outputPath);

    expect(result.width).toBe(1000);
    expect(result.height).toBe(1000);
    expect(fs.existsSync(outputPath)).toBe(true);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }, 10000);
});
