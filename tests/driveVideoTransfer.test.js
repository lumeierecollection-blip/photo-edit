// Simulates interrupted Google Drive transfers to prove large videos resume
// instead of restarting, and that corrupted transfers are rejected.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const mockFiles = { get: jest.fn(), list: jest.fn(), create: jest.fn() };
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        on: jest.fn(),
        getAccessToken: jest.fn().mockResolvedValue({ token: 'test-token' })
      }))
    },
    drive: () => ({ files: mockFiles })
  }
}));
jest.mock('axios');

const axios = require('axios');
const { downloadFileToDisk, uploadFileResumable, isTransientError, withRetry } = require('../src/services/driveService');

const tmpDir = path.join(__dirname, '../uploads/temp/transfer-tests');
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

beforeAll(() => fs.mkdirSync(tmpDir, { recursive: true }));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => jest.clearAllMocks());

describe('error classification', () => {
  test('temporary problems are retried, permanent ones are not', () => {
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError({ response: { status: 503 } })).toBe(true);
    expect(isTransientError({ response: { status: 429 } })).toBe(true);
    expect(isTransientError({ response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } })).toBe(true);
    expect(isTransientError({ response: { status: 404 } })).toBe(false);
    expect(isTransientError({ response: { status: 403, data: 'insufficientPermissions' } })).toBe(false);
    expect(isTransientError({ name: 'AbortError' })).toBe(false);
  });

  test('withRetry gives up on permanent errors immediately', async () => {
    const fn = jest.fn().mockRejectedValue({ response: { status: 404 }, message: 'nope' });
    await expect(withRetry(fn, { retries: 5 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('downloadFileToDisk', () => {
  test('resumes an interrupted download with an HTTP Range request and verifies MD5', async () => {
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const half = 1024 * 1024;
    const dest = path.join(tmpDir, 'download.bin');

    mockFiles.get
      .mockImplementationOnce(async () => {
        const stream = new Readable({ read() {} });
        stream.push(data.subarray(0, half));
        // Let the first half reach the disk, then drop the connection.
        setTimeout(() => stream.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 300);
        return { status: 200, data: stream };
      })
      .mockImplementationOnce(async (params, opts) => {
        expect(opts.headers.Range).toBe(`bytes=${half}-`);
        return { status: 206, data: Readable.from([data.subarray(half)]) };
      });

    await downloadFileToDisk({}, { id: 'f1', size: data.length, md5Checksum: md5(data) }, dest, { retries: 3 });
    expect(md5(fs.readFileSync(dest))).toBe(md5(data));
    expect(mockFiles.get).toHaveBeenCalledTimes(2);
  }, 20000);

  test('resumes after the "aborted" error Node gives for a dropped download (no error code)', async () => {
    const data = crypto.randomBytes(2 * 1024 * 1024);
    const dest = path.join(tmpDir, 'aborted.bin');
    const piece = 512 * 1024;
    let served = 0;

    // Each connection delivers one 512 KiB piece, then dies with a bare "aborted".
    // That is 4 drops — more than retries=2 — but every attempt makes progress.
    mockFiles.get.mockImplementation(async (params, opts) => {
      const from = opts.headers.Range ? Number(/bytes=(\d+)-/.exec(opts.headers.Range)[1]) : 0;
      expect(from).toBe(served);
      const stream = new Readable({ read() {} });
      const end = Math.min(data.length, from + piece);
      stream.push(data.subarray(from, end));
      served = end;
      if (end === data.length) stream.push(null);
      else setTimeout(() => stream.destroy(new Error('aborted')), 200);
      return { status: from ? 206 : 200, data: stream };
    });

    await downloadFileToDisk({}, { id: 'f3', size: data.length, md5Checksum: md5(data) }, dest, { retries: 2 });
    expect(md5(fs.readFileSync(dest))).toBe(md5(data));
    expect(mockFiles.get).toHaveBeenCalledTimes(4);
  }, 60000);

  test("waits out Google's per-file download limit and then completes on its own", async () => {
    const data = crypto.randomBytes(256 * 1024);
    const dest = path.join(tmpDir, 'quota.bin');
    const quotaError = Object.assign(new Error('The download quota for this file has been exceeded.'), {
      response: { status: 403, data: { error: { errors: [{ reason: 'downloadQuotaExceeded' }] } } }
    });
    mockFiles.get
      .mockRejectedValueOnce(quotaError)
      .mockRejectedValueOnce(quotaError)
      .mockImplementationOnce(async () => ({ status: 200, data: Readable.from([data]) }));

    const waits = [];
    await downloadFileToDisk({}, { id: 'f5', size: data.length, md5Checksum: md5(data) }, dest, {
      retries: 0, maxQuotaWaits: 24, quotaWaitMs: 20, onQuotaWait: n => waits.push(n)
    });
    expect(waits).toEqual([1, 2]);
    expect(md5(fs.readFileSync(dest))).toBe(md5(data));
  }, 30000);

  test('without a wait allowance, the download limit fails immediately (not retried as a network error)', async () => {
    const dest = path.join(tmpDir, 'quota2.bin');
    mockFiles.get.mockRejectedValue(Object.assign(new Error('The download quota for this file has been exceeded.'), {
      response: { status: 403, data: { error: { errors: [{ reason: 'downloadQuotaExceeded' }] } } }
    }));
    await expect(downloadFileToDisk({}, { id: 'f6', size: 10 }, dest, { retries: 5 })).rejects.toThrow(/download quota/);
    expect(mockFiles.get).toHaveBeenCalledTimes(1);
  }, 30000);

  test('gives up only after repeated failures that make no progress', async () => {
    const dest = path.join(tmpDir, 'dead.bin');
    mockFiles.get.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' }));
    await expect(downloadFileToDisk({}, { id: 'f4', size: 100 }, dest, { retries: 1 }))
      .rejects.toThrow(/no progress/);
    expect(mockFiles.get).toHaveBeenCalledTimes(2);
  }, 30000);

  test('rejects a download whose content does not match Drive\'s checksum', async () => {
    const dest = path.join(tmpDir, 'bad.bin');
    mockFiles.get.mockImplementation(async () => ({ status: 200, data: Readable.from([Buffer.from('corrupted!')]) }));
    await expect(downloadFileToDisk({}, { id: 'f2', size: 10, md5Checksum: 'deadbeef' }, dest, { retries: 1 }))
      .rejects.toThrow(/MD5 mismatch/);
  }, 20000);
});

describe('uploadFileResumable', () => {
  test('uploads in chunks and, after a dropped connection, resumes from the byte Drive confirmed', async () => {
    const MB = 1024 * 1024;
    const size = 20 * MB; // spans three 8 MiB chunks
    const data = crypto.randomBytes(size);
    const file = path.join(tmpDir, 'upload.mp4');
    fs.writeFileSync(file, data);
    const confirmed = 4 * MB; // Drive kept half of the chunk that dropped

    axios.post.mockResolvedValue({ headers: { location: 'https://upload.example/session' } });
    const puts = [];
    axios.put.mockImplementation(async (url, body, opts) => {
      puts.push(opts.headers['Content-Range']);
      switch (puts.length) {
        case 1: throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        case 2: return { status: 308, headers: { range: `bytes=0-${confirmed - 1}` } }; // status query
        case 3: return { status: 308, headers: { range: `bytes=0-${12 * MB - 1}` } };
        case 4: return { status: 200, headers: {}, data: { id: 'new-file' } };
        default: throw new Error('unexpected request');
      }
    });
    mockFiles.get.mockResolvedValue({ data: { id: 'new-file', size: String(size), md5Checksum: md5(data), webViewLink: 'link' } });

    const result = await uploadFileResumable({}, 'folder', file, 'Sunday_Service.mp4', { mimeType: 'video/mp4', retries: 3 });

    expect(result.id).toBe('new-file');
    expect(axios.post.mock.calls[0][1]).toMatchObject({ name: 'Sunday_Service.mp4', parents: ['folder'], mimeType: 'video/mp4' });
    expect(puts).toEqual([
      `bytes 0-${8 * MB - 1}/${size}`,
      `bytes */${size}`,
      `bytes ${confirmed}-${12 * MB - 1}/${size}`,
      `bytes ${12 * MB}-${size - 1}/${size}`
    ]);
    puts.forEach((_, i) => expect(axios.put.mock.calls[i][2].timeout).toBeGreaterThan(0));
  }, 30000);

  test('keeps going through more drops than the retry limit, as long as chunks get through', async () => {
    const MB = 1024 * 1024;
    const size = 24 * MB; // three chunks
    const data = crypto.randomBytes(size);
    const file = path.join(tmpDir, 'flaky-upload.mp4');
    fs.writeFileSync(file, data);

    axios.post.mockResolvedValue({ headers: { location: 'https://upload.example/flaky' } });
    let accepted = 0;
    axios.put.mockImplementation(async (url, body, opts) => {
      const range = opts.headers['Content-Range'];
      if (range.startsWith('bytes */')) {
        return { status: 308, headers: accepted ? { range: `bytes=0-${accepted - 1}` } : {} };
      }
      // Every chunk fails once with the connection drop seen in the field, then succeeds.
      const start = Number(/bytes (\d+)-/.exec(range)[1]);
      if (!axios.put.dropped) axios.put.dropped = new Set();
      if (!axios.put.dropped.has(start)) {
        axios.put.dropped.add(start);
        throw Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' });
      }
      accepted = Math.min(size, start + 8 * MB);
      return accepted === size
        ? { status: 200, headers: {}, data: { id: 'flaky-file' } }
        : { status: 308, headers: { range: `bytes=0-${accepted - 1}` } };
    });
    mockFiles.get.mockResolvedValue({ data: { id: 'flaky-file', size: String(size), md5Checksum: md5(data) } });

    // 3 drops in total but never 2 in a row without progress: retries=1 must be enough.
    const result = await uploadFileResumable({}, 'folder', file, 'flaky.mp4', { retries: 1 });
    expect(result.id).toBe('flaky-file');
    delete axios.put.dropped;
  }, 60000);

  test('fails loudly if the file in Drive does not match what was sent', async () => {
    const file = path.join(tmpDir, 'small.mp4');
    fs.writeFileSync(file, Buffer.from('hello world'));
    axios.post.mockResolvedValue({ headers: { location: 'https://upload.example/s2' } });
    axios.put.mockResolvedValue({ status: 200, headers: {}, data: { id: 'x' } });
    mockFiles.get.mockResolvedValue({ data: { id: 'x', size: '11', md5Checksum: 'different' } });
    await expect(uploadFileResumable({}, 'folder', file, 'small.mp4', { retries: 0 })).rejects.toThrow(/mismatch/);
  });
});
