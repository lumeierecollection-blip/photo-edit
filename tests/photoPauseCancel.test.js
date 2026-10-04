// Pause / resume / cancel for the Photo Watermarker batch, with Google Drive
// and the watermarking replaced by slow stand-ins so the controls can be
// pressed while a "transfer" is in progress.
jest.mock('../src/services/driveService', () => {
  const uploaded = []; // names of uploads that finished (not interrupted ones)
  const abortable = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' })); };
    if (signal && signal.aborted) return abort();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
  return {
    validateFolder: jest.fn(async () => ({ folderId: 'src', folderName: 'Sunday' })),
    listPhotosInFolder: jest.fn(async () => ({
      photos: [1, 2, 3, 4].map(n => ({ id: `id${n}`, name: `IMG_${n}.JPG` })),
      ignoredCount: 0
    })),
    createOutputFolder: jest.fn(async () => ({ folderId: 'out', folderName: 'Sunday — Watermarked', webViewLink: 'https://drive/out' })),
    downloadFileToDisk: jest.fn(async (tokens, file, dest, { signal } = {}) => {
      await abortable(40, signal);
      require('fs').writeFileSync(dest, 'x');
    }),
    listFolderChildren: jest.fn(async () => []),
    uploadFile: jest.fn(async (tokens, folder, file, name, { signal } = {}) => {
      await abortable(40, signal);
      uploaded.push(name);
    }),
    uploaded
  };
});
jest.mock('../src/services/imageService', () => ({
  applyWatermark: jest.fn(async (input, output) => require('fs').writeFileSync(output, 'y')),
  generatePreview: jest.fn()
}));
jest.mock('../src/services/jobService', () => ({ addJobRecord: jest.fn(record => ({ id: 'rec1', ...record })) }));

const express = require('express');
const request = require('supertest');
const drive = require('../src/services/driveService');
const { addJobRecord } = require('../src/services/jobService');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { tokens: {} }; next(); });
app.use('/api/drive', require('../src/routes/drive'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start() {
  const res = await request(app).post('/api/drive/process').send({ folderUrl: 'https://drive.google.com/drive/folders/src' });
  expect(res.status).toBe(200);
  return res.body.jobId;
}

async function status(jobId) {
  return (await request(app).get(`/api/drive/process/${jobId}/status`)).body;
}

async function waitDone(jobId) {
  for (let i = 0; i < 200; i++) {
    const s = await status(jobId);
    if (s.done) return s;
    await sleep(20);
  }
  throw new Error('Batch did not finish.');
}

beforeEach(() => {
  jest.clearAllMocks();
  drive.uploaded.length = 0;
});

test('pausing stops the transfer in progress; resuming redoes that photo and finishes', async () => {
  const jobId = await start();
  await sleep(20); // part-way through downloading the first photo

  expect((await request(app).post(`/api/drive/process/${jobId}/pause`)).body).toEqual({ paused: true });
  await sleep(150);
  const paused = await status(jobId);
  expect(paused).toMatchObject({ paused: true, processed: 0, failed: 0, done: false, etaMs: null });
  const callsWhilePaused = drive.downloadFileToDisk.mock.calls.length + drive.uploadFile.mock.calls.length;
  await sleep(150);
  expect(drive.downloadFileToDisk.mock.calls.length + drive.uploadFile.mock.calls.length).toBe(callsWhilePaused);

  expect((await request(app).post(`/api/drive/process/${jobId}/resume`)).body).toEqual({ paused: false });
  const done = await waitDone(jobId);
  expect(done.result).toMatchObject({ successful: 4, failed: 0, cancelled: false, errors: [] });
  // Every photo uploaded exactly once, including the one that was interrupted.
  expect([...drive.uploaded].sort()).toEqual(['IMG_1.JPG', 'IMG_2.JPG', 'IMG_3.JPG', 'IMG_4.JPG']);
});

test('pausing between photos does not break the next photo after resuming', async () => {
  const jobId = await start();
  await sleep(90); // around the upload of the first photo
  await request(app).post(`/api/drive/process/${jobId}/pause`);
  await sleep(60);
  await request(app).post(`/api/drive/process/${jobId}/resume`);
  await request(app).post(`/api/drive/process/${jobId}/pause`);
  await sleep(30);
  await request(app).post(`/api/drive/process/${jobId}/resume`);
  const done = await waitDone(jobId);
  expect(done.result).toMatchObject({ successful: 4, failed: 0 });
});

test('cancelling stops straight away and keeps what was finished', async () => {
  const jobId = await start();
  // Let the first photo finish (download + upload ≈ 80 ms), then cancel.
  for (let i = 0; i < 100 && (await status(jobId)).processed < 1; i++) await sleep(10);
  expect((await request(app).post(`/api/drive/process/${jobId}/cancel`)).body).toEqual({ cancelled: true });

  const done = await waitDone(jobId);
  expect(done.result).toMatchObject({ successful: 1, failed: 0, cancelled: true, totalPhotos: 4 });
  expect(drive.uploaded).toEqual(['IMG_1.JPG']); // photo 2 was interrupted, 3 and 4 never started
  expect(drive.downloadFileToDisk.mock.calls.map(c => c[1].id)).toEqual(['id1', 'id2']);
  expect(addJobRecord).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true, successful: 1 }));

  // Controls on a finished job are refused rather than silently ignored.
  expect((await request(app).post(`/api/drive/process/${jobId}/pause`)).status).toBe(409);
});

test('cancelling while paused ends the batch', async () => {
  const jobId = await start();
  await sleep(20);
  await request(app).post(`/api/drive/process/${jobId}/pause`);
  await sleep(50);
  await request(app).post(`/api/drive/process/${jobId}/cancel`);
  const done = await waitDone(jobId);
  expect(done.result).toMatchObject({ successful: 0, cancelled: true });
  expect(done.paused).toBe(false);
});

test('running a folder again skips photos already in the output folder (RAW files by their .jpg name)', async () => {
  drive.listPhotosInFolder.mockResolvedValueOnce({
    photos: [{ id: 'a', name: 'IMG_7251.JPG' }, { id: 'b', name: 'IMG_8464.CR2' }, { id: 'c', name: 'IMG_8465.CR2' }],
    ignoredCount: 0
  });
  drive.createOutputFolder.mockResolvedValueOnce({ folderId: 'out', folderName: 'Sunday — Watermarked', webViewLink: 'x', exists: true });
  drive.listFolderChildren.mockResolvedValueOnce([{ id: '1', name: 'IMG_7251.JPG' }, { id: '2', name: 'IMG_8464.jpg' }]);
  const jobId = await start();
  const done = await waitDone(jobId);
  expect(done.result).toMatchObject({ successful: 1, skipped: 2, failed: 0 });
  expect(drive.uploaded).toEqual(['IMG_8465.jpg']);
});

test('unknown jobs give 404', async () => {
  expect((await request(app).post('/api/drive/process/nope/pause')).status).toBe(404);
});
