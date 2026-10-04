// Camera RAW (.CR2 etc.) support. The test builds a small file laid out like
// a Canon CR2: IFD0 holds the full-size camera JPEG (old-style JPEG strip,
// orientation tag), IFD1 a small thumbnail, and a further IFD the sensor data
// as lossless JPEG, which must be skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { extractRawPreview, isRawFileName } = require('../src/services/rawPreview');
const { applyWatermark } = require('../src/services/imageService');

function ifd(entries, nextOffset) {
  const buf = Buffer.alloc(2 + entries.length * 12 + 4);
  buf.writeUInt16LE(entries.length, 0);
  entries.forEach(([tag, type, value], i) => {
    const at = 2 + i * 12;
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(1, at + 4);
    if (type === 3) buf.writeUInt16LE(value, at + 8);
    else buf.writeUInt32LE(value, at + 8);
  });
  buf.writeUInt32LE(nextOffset, 2 + entries.length * 12);
  return buf;
}

async function fakeCr2({ orientation = 6 } = {}) {
  const big = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();
  const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#aa3333' } }).jpeg().toBuffer();
  // Lossless-JPEG "sensor data": SOI, then an SOF3 frame header claiming a huge size.
  const sensor = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc3, 0x00, 0x0b, 0x0c, 0x10, 0x00, 0x20, 0x00, 0x02, 0x01, 0x11, 0x00]), Buffer.alloc(4000)]);

  const header = Buffer.from('II*\0\x10\0\0\0CR\x02\0\0\0\0\0', 'latin1'); // 16 bytes, IFD0 at 16
  const ifd0Size = 2 + 4 * 12 + 4;
  const ifd1Size = 2 + 2 * 12 + 4;
  const ifd2Size = 2 + 3 * 12 + 4;
  const ifd0At = 16;
  const ifd1At = ifd0At + ifd0Size;
  const ifd2At = ifd1At + ifd1Size;
  const bigAt = ifd2At + ifd2Size;
  const thumbAt = bigAt + big.length;
  const sensorAt = thumbAt + thumb.length;

  return Buffer.concat([
    header,
    ifd([[0x0103, 3, 6], [0x0111, 4, bigAt], [0x0112, 3, orientation], [0x0117, 4, big.length]], ifd1At),
    ifd([[0x0201, 4, thumbAt], [0x0202, 4, thumb.length]], ifd2At),
    ifd([[0x0103, 3, 6], [0x0111, 4, sensorAt], [0x0117, 4, sensor.length]], 0),
    big, thumb, sensor
  ]);
}

describe('rawPreview', () => {
  test('recognises camera RAW file names', () => {
    expect(isRawFileName('IMG_8464.CR2')).toBe(true);
    expect(isRawFileName('dsc_1.nef')).toBe(true);
    expect(isRawFileName('photo.dng')).toBe(true);
    expect(isRawFileName('IMG_7251.JPG')).toBe(false);
    expect(isRawFileName('scan.tif')).toBe(false);
  });

  test('picks the full-size camera JPEG, skipping the thumbnail and the sensor data', async () => {
    const preview = extractRawPreview(await fakeCr2());
    expect(preview).toMatchObject({ width: 600, height: 400, orientation: 6 });
    expect((await sharp(preview.jpeg).metadata()).width).toBe(600);
  });

  test('returns null for files that are not TIFF-based RAW', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    expect(extractRawPreview(jpeg)).toBeNull();
    expect(extractRawPreview(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('watermarking camera RAW files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-test-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a .CR2 becomes an upright, watermarked JPEG', async () => {
    const input = path.join(dir, 'IMG_8464.CR2');
    fs.writeFileSync(input, await fakeCr2({ orientation: 6 }));
    const output = path.join(dir, 'IMG_8464.jpg');
    const result = await applyWatermark(input, output);
    // Orientation 6 (camera turned sideways): 600×400 stored → 400×600 upright.
    expect(result).toMatchObject({ width: 400, height: 600, format: 'jpeg', fromRaw: true });
    // The input is not held open, so the temp copy can be deleted at once.
    fs.unlinkSync(input);
  });

  test('a RAW file saved under a .jpg name (the preview temp file) still works', async () => {
    const input = path.join(dir, 'preview_in.jpg');
    fs.writeFileSync(input, await fakeCr2({ orientation: 1 }));
    const result = await applyWatermark(input, path.join(dir, 'preview_out.jpg'));
    expect(result).toMatchObject({ width: 600, height: 400, fromRaw: true });
  });

  test('a sideways camera JPEG is measured after rotating it', async () => {
    const input = path.join(dir, 'sideways.jpg');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#778899' } }).jpeg().withMetadata({ orientation: 6 }).toFile(input);
    const result = await applyWatermark(input, path.join(dir, 'sideways-out.jpg'));
    expect(result).toMatchObject({ width: 600, height: 800, fromRaw: false });
  });

  test('a RAW file with no built-in JPEG gives a clear message', async () => {
    const input = path.join(dir, 'empty.CR2');
    fs.writeFileSync(input, Buffer.concat([Buffer.from('II*\0\x08\0\0\0', 'latin1'), ifd([[0x0103, 3, 1]], 0)]));
    await expect(applyWatermark(input, path.join(dir, 'empty.jpg'))).rejects.toThrow(/no built-in JPEG/);
  });
});
