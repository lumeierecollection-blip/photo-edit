// Exercises the whole batch pipeline (download → analyze → convert → validate
// → upload) with real FFmpeg but a simulated Google Drive.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

jest.mock('../src/services/driveService', () => {
  const actual = jest.requireActual('../src/services/driveService');
  return {
    ...actual,
    downloadFileToDisk: jest.fn(),
    uploadFileResumable: jest.fn()
  };
});
jest.mock('../src/services/jobService', () => ({ addJobRecord: jest.fn(r => ({ id: 'h1', ...r })) }));

const drive = require('../src/services/driveService');
const { getEngine } = require('../src/services/videoService');
const { startVideoJob, snapshot, cancelVideoJob, outputNameFor, TEMP_ROOT, APP_PROPERTY_SOURCE, sourceCachePath } = require('../src/services/videoJobService');
const { buildFixture } = require('./helpers/videoFixtures');

const describeIfEngine = getEngine().available ? describe : describe.skip;

describe('outputNameFor', () => {
  test('only the extension changes', () => {
    const used = new Set();
    expect(outputNameFor('Sunday_Service.MOV', used)).toBe('Sunday_Service.mp4');
    expect(outputNameFor('Camera_003.MKV', used)).toBe('Camera_003.mp4');
    expect(outputNameFor('Interview_Final.WEBM', used)).toBe('Interview_Final.mp4');
    expect(outputNameFor('no_extension', used)).toBe('no_extension.mp4');
  });

  test('collisions get a safe numbered name instead of overwriting', () => {
    const used = new Set(['clip.mp4']);
    expect(outputNameFor('Clip.MOV', used)).toBe('Clip (2).mp4');
    expect(outputNameFor('Clip.MKV', used)).toBe('Clip (3).mp4');
  });
});

function waitForJob(jobId, timeoutMs = 240000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = snapshot(jobId);
      if (s && s.done) return resolve(s);
      if (Date.now() - start > timeoutMs) return reject(new Error('Job timed out'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

describeIfEngine('Video batch job (simulated Google Drive)', () => {
  const localFiles = {}; // drive file id -> local fixture path
  const uploads = [];
  const sourceHashes = {};

  const md5 = file => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

  function driveFile(id, fixture, name) {
    localFiles[id] = buildFixture(fixture);
    sourceHashes[id] = md5(localFiles[id]);
    return { id, name, size: fs.statSync(localFiles[id]).size, md5Checksum: sourceHashes[id] };
  }

  beforeEach(() => {
    uploads.length = 0;
    drive.downloadFileToDisk.mockImplementation(async (tokens, file, dest) => {
      if (file.id === 'network-dead') {
        throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
      }
      fs.copyFileSync(localFiles[file.id], dest);
      return dest;
    });
    drive.uploadFileResumable.mockImplementation(async (tokens, folderId, filePath, name, opts) => {
      uploads.push({ folderId, name, size: fs.statSync(filePath).size, appProperties: opts.appProperties, mimeType: opts.mimeType });
      return { id: `up-${uploads.length}`, name, webViewLink: `https://drive.google.com/file/d/up-${uploads.length}/view` };
    });
  });

  test('mixed folder: remux + re-encode succeed, corrupt/missing fail, audio-only skipped, batch continues', async () => {
    const videos = [
      driveFile('a', 'mov_h264_aac_1080p30', 'Sunday_Service.MOV'),
      driveFile('b', 'webm_vp9_opus_720p', 'Interview_Final.WEBM'),
      driveFile('c', 'corrupt', 'Camera_021.AVI'),
      driveFile('d', 'audio_only', 'sermon_audio.mp4'),
      driveFile('e', 'portrait_phone_rotated', 'IMG_0420.MOV'),
      driveFile('f', 'mkv_multi_audio_subs', 'Sunday_Service.MKV'), // name clash with 'a'
      { id: 'network-dead', name: 'Gone.mov', size: 1000 }
    ];

    const jobId = startVideoJob({
      tokens: {},
      ownerSessionId: 's1',
      folderInfo: { folderId: 'src', folderName: 'Church Event Videos — September 2026' },
      videos,
      outputFolder: { folderId: 'out', folderName: 'Church Event Videos — September 2026 — MP4 Converted', webViewLink: 'https://drive.google.com/drive/folders/out' }
    });
    const result = await waitForJob(jobId);
    const byName = Object.fromEntries(result.files.map(f => [f.name, f]));

    expect(result.total).toBe(7);
    expect(result.successful).toBe(4);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(1);

    expect(byName['Sunday_Service.MOV']).toMatchObject({ status: 'complete', strategy: 'remux', outputName: 'Sunday_Service.mp4' });
    expect(byName['Sunday_Service.MKV']).toMatchObject({ status: 'complete', strategy: 'remux-video', outputName: 'Sunday_Service (2).mp4' });
    expect(byName['Interview_Final.WEBM']).toMatchObject({ status: 'complete', strategy: 'encode' });
    expect(byName['IMG_0420.MOV'].outputSummary.orientation).toBe('portrait');
    expect(byName['sermon_audio.mp4'].status).toBe('skipped');
    expect(byName['Camera_021.AVI'].error).toMatchObject({ stage: 'Analysis', category: 'Unreadable or unsupported file' });
    expect(byName['Camera_021.AVI'].error.recommendedAction).toBeTruthy();
    expect(byName['Gone.mov'].error).toMatchObject({ stage: 'Download', category: 'File not found in Google Drive' });

    // Everything went to the NEW folder as MP4, tagged with its source id.
    expect(uploads).toHaveLength(4);
    uploads.forEach(u => {
      expect(u.folderId).toBe('out');
      expect(u.mimeType).toBe('video/mp4');
      expect(u.name).toMatch(/\.mp4$/);
      expect(u.appProperties[APP_PROPERTY_SOURCE]).toBeTruthy();
    });

    // Originals untouched; no temp copies left behind — finished, skipped and
    // corrupt videos don't leave a cached download either.
    for (const [id, file] of Object.entries(localFiles)) expect(md5(file)).toBe(sourceHashes[id]);
    expect(fs.existsSync(path.join(TEMP_ROOT, jobId))).toBe(false);
    videos.forEach(v => expect(fs.existsSync(sourceCachePath(v))).toBe(false));
  }, 300000);

  test("Google's per-file download limit is reported as such, not as storage full", async () => {
    const quotaBody = { error: { code: 403, message: 'The download quota for this file has been exceeded.', errors: [{ reason: 'downloadQuotaExceeded', domain: 'usageLimits' }] } };
    drive.downloadFileToDisk.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The download quota for this file has been exceeded.'), { response: { status: 403, data: quotaBody } });
    });
    const jobId = startVideoJob({
      tokens: {}, ownerSessionId: 's1', folderInfo: { folderId: 'src', folderName: 'S' },
      videos: [driveFile('q', 'mov_h264_aac_1080p30', 'Big.MXF')],
      outputFolder: { folderId: 'out', folderName: 'S — MP4 Converted', webViewLink: 'x' }
    });
    const result = await waitForJob(jobId);
    expect(result.files[0].error.category).toMatch(/daily download limit/);
    expect(result.files[0].error.category).not.toMatch(/storage/i);
    expect(result.files[0].error.recommendedAction).toMatch(/not a storage problem/);
  }, 60000);

  test('a failed upload keeps the downloaded original, and the next run reuses it', async () => {
    const video = driveFile('u', 'mov_h264_aac_1080p30', 'Keep.MOV');
    const cached = sourceCachePath(video);
    fs.rmSync(cached, { force: true });
    const downloads = [];
    drive.downloadFileToDisk.mockImplementation(async (tokens, file, dest) => {
      const reused = fs.existsSync(dest) && fs.statSync(dest).size === file.size;
      downloads.push(reused ? 'reused' : 'downloaded');
      if (!reused) fs.copyFileSync(localFiles[file.id], dest);
      return dest;
    });
    drive.uploadFileResumable.mockImplementationOnce(async () => {
      throw Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' });
    });
    const run = () => waitForJob(startVideoJob({
      tokens: {}, ownerSessionId: 's1', folderInfo: { folderId: 'src', folderName: 'S' }, videos: [video],
      outputFolder: { folderId: 'out', folderName: 'S — MP4 Converted', webViewLink: 'x' }
    }));

    const first = await run();
    expect(first.files[0]).toMatchObject({ status: 'failed', error: { stage: 'Upload' } });
    expect(fs.existsSync(cached)).toBe(true);

    const second = await run();
    expect(second.files[0].status).toBe('complete');
    expect(downloads).toEqual(['downloaded', 'reused']);
    expect(fs.existsSync(cached)).toBe(false); // removed once safely in Drive
  }, 120000);

  test('reprocessing into an existing folder skips already-converted videos and never reuses a taken name', async () => {
    const videos = [
      driveFile('a', 'mov_h264_aac_1080p30', 'Sunday_Service.MOV'),
      driveFile('g', 'mp4_h264_aac_720p25', 'Welcome.MOV')
    ];
    const jobId = startVideoJob({
      tokens: {},
      ownerSessionId: 's1',
      folderInfo: { folderId: 'src', folderName: 'Src' },
      videos,
      outputFolder: { folderId: 'out', folderName: 'Src — MP4 Converted', webViewLink: 'x' },
      existingOutputFiles: [
        { id: 'o1', name: 'Sunday_Service.mp4', appProperties: { [APP_PROPERTY_SOURCE]: 'a' } },
        { id: 'o2', name: 'Welcome.mp4' } // same name, but a different (manual) file
      ]
    });
    const result = await waitForJob(jobId);
    expect(result.files[0]).toMatchObject({ status: 'skipped', reason: 'Already converted in this output folder.' });
    expect(result.files[1]).toMatchObject({ status: 'complete', outputName: 'Welcome (2).mp4' });
    expect(uploads.map(u => u.name)).toEqual(['Welcome (2).mp4']);
  }, 120000);

  test('cancel stops the batch and cleans up', async () => {
    const videos = ['uhd_10bit_60', 'hdr_hevc_pq', 'webm_vp9_opus_720p'].map((fx, i) => driveFile(`c${i}`, fx, `${fx}.mov`));
    const jobId = startVideoJob({
      tokens: {}, ownerSessionId: 's1', folderInfo: { folderId: 'src', folderName: 'S' }, videos,
      outputFolder: { folderId: 'out', folderName: 'S — MP4 Converted', webViewLink: 'x' }
    });
    await new Promise(r => setTimeout(r, 300));
    expect(cancelVideoJob(jobId)).toBe(true);
    const result = await waitForJob(jobId);
    expect(result.cancelled).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(TEMP_ROOT, jobId))).toBe(false);
  }, 120000);
});
