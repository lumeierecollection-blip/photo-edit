// Camera RAW support for the Photo Watermarker.
//
// sharp/libvips cannot develop RAW files (Canon .CR2, Nikon .NEF, Sony .ARW,
// .DNG…); it sees their TIFF structure and fails with errors such as
// "tiff2vips: Old-style JPEG compression support is not configured". Every one
// of these formats, though, carries a full-size JPEG the camera rendered when
// the photo was taken (the image shown on the camera's screen). This module
// walks the TIFF structure, finds the largest embedded JPEG that is an
// ordinary (baseline/progressive) JPEG, and returns it with the RAW file's
// orientation. The actual sensor data (stored as lossless JPEG) is skipped.

const RAW_EXTENSIONS = new Set(['.cr2', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.pef', '.rw2', '.orf', '.raf', '.3fr', '.erf', '.kdc', '.mrw', '.srw', '.x3f', '.iiq', '.crw', '.cr3']);

const TAG = {
  COMPRESSION: 0x0103,
  STRIP_OFFSETS: 0x0111,
  ORIENTATION: 0x0112,
  STRIP_BYTE_COUNTS: 0x0117,
  SUB_IFDS: 0x014a,
  JPEG_OFFSET: 0x0201,
  JPEG_LENGTH: 0x0202,
  EXIF_IFD: 0x8769
};

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };

function isRawFileName(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot >= 0 && RAW_EXTENSIONS.has(String(name).slice(dot).toLowerCase());
}

function reader(buf, little) {
  return {
    u16: o => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    u32: o => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  };
}

/** Reads the values of one IFD entry (SHORT/LONG/IFD types only). */
function entryValues(buf, r, entryOffset) {
  const type = r.u16(entryOffset + 2);
  const count = r.u32(entryOffset + 4);
  const size = TYPE_SIZES[type] || 1;
  if (![3, 4, 13].includes(type) || count > 1 << 16) return [];
  const inline = size * count <= 4;
  const at = inline ? entryOffset + 8 : r.u32(entryOffset + 8);
  if (at + size * count > buf.length) return [];
  const values = [];
  for (let i = 0; i < count; i++) values.push(type === 3 ? r.u16(at + i * 2) : r.u32(at + i * 4));
  return values;
}

/**
 * The frame type of a JPEG: 0xC0/0xC1/0xC2 are ordinary JPEGs any decoder
 * reads; 0xC3 is lossless JPEG (RAW sensor data), which sharp cannot.
 */
function jpegFrameType(buf, start, end) {
  if (buf[start] !== 0xff || buf[start + 1] !== 0xd8) return null;
  let i = start + 2;
  while (i + 4 <= end) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return marker;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function jpegDimensions(buf, start, end) {
  let i = start + 2;
  while (i + 9 <= end) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Finds the best embedded JPEG in a TIFF-based RAW file.
 * Returns { jpeg: Buffer, orientation: 1-8, width, height } or null.
 */
function extractRawPreview(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const r = reader(buf, little);
  const magic = r.u16(2);
  // 42 = TIFF; Olympus ORF and Panasonic RW2 use their own magic numbers.
  if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return null;

  const candidates = [];
  let orientation = 1;
  const seen = new Set();
  const queue = [{ offset: r.u32(4), top: true }];

  while (queue.length && seen.size < 64) {
    const { offset, top } = queue.shift();
    if (!offset || offset + 2 > buf.length || seen.has(offset)) continue;
    seen.add(offset);
    const count = r.u16(offset);
    if (offset + 2 + count * 12 + 4 > buf.length) continue;

    const tags = {};
    for (let e = 0; e < count; e++) {
      const at = offset + 2 + e * 12;
      tags[r.u16(at)] = at;
    }
    const get = tag => (tags[tag] !== undefined ? entryValues(buf, r, tags[tag]) : []);

    if (top && tags[TAG.ORIENTATION] !== undefined && orientation === 1) {
      const [o] = get(TAG.ORIENTATION);
      if (o >= 1 && o <= 8) orientation = o;
    }

    const jpegOffset = get(TAG.JPEG_OFFSET)[0];
    const jpegLength = get(TAG.JPEG_LENGTH)[0];
    if (jpegOffset && jpegLength) candidates.push([jpegOffset, jpegLength]);

    const [compression] = get(TAG.COMPRESSION);
    const strips = get(TAG.STRIP_OFFSETS);
    const stripLengths = get(TAG.STRIP_BYTE_COUNTS);
    if ([6, 7].includes(compression) && strips.length === 1 && stripLengths.length === 1) {
      candidates.push([strips[0], stripLengths[0]]);
    }

    for (const sub of get(TAG.SUB_IFDS)) queue.push({ offset: sub, top: false });
    const next = r.u32(offset + 2 + count * 12);
    if (next) queue.push({ offset: next, top });
  }

  let best = null;
  for (const [start, length] of candidates) {
    const end = start + length;
    if (end > buf.length || length < 1024) continue;
    const frame = jpegFrameType(buf, start, end);
    if (![0xc0, 0xc1, 0xc2].includes(frame)) continue; // skip lossless sensor data
    const dims = jpegDimensions(buf, start, end);
    if (!dims) continue;
    const area = dims.width * dims.height;
    if (!best || area > best.area) best = { start, end, area, ...dims };
  }
  if (!best) return null;
  return { jpeg: buf.subarray(best.start, best.end), orientation, width: best.width, height: best.height };
}

module.exports = { extractRawPreview, isRawFileName, RAW_EXTENSIONS };
