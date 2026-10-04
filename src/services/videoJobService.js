// Runs a Video Converter batch: download → analyze → remux/convert → validate
// → upload, for each video, with bounded concurrency. One failed video never
// stops the batch, and the source files in Google Drive are only ever read.

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const drive = require('./driveService');
const video = require('./videoService');
const { addJobRecord } = require('./jobService');
const { createJob, getJob, updateJob, completeJob, failJob } = require('./progressStore');

const TEMP_ROOT = path.join(__dirname, '../../uploads/temp/video');
const CACHE_ROOT = path.join(__dirname, '../../uploads/temp/video-cache');
const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DISK_SAFETY_MARGIN = 512 * 1024 * 1024;
const APP_PROPERTY_SOURCE = 'cmtSourceFileId';

const controllers = new Map(); // jobId -> AbortController

// While any conversion runs, ask Windows not to sleep (a long unattended batch
// otherwise stalls when the PC idles). The helper exits by itself if this
// server dies, and Windows' normal sleep settings return when it stops.
let keepAwakeProcess = null;
function updateKeepAwake() {
  if (process.platform !== 'win32' || process.env.JEST_WORKER_ID) return;
  if (controllers.size > 0 && !keepAwakeProcess) {
    const script = [
      "$t = Add-Type -Name KeepAwake -Namespace CMT -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      '$null = $t::SetThreadExecutionState([uint32]"0x80000001")', // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`
    ].join('; ');
    keepAwakeProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    keepAwakeProcess.on('error', () => { keepAwakeProcess = null; });
    keepAwakeProcess.on('exit', () => { keepAwakeProcess = null; });
  } else if (controllers.size === 0 && keepAwakeProcess) {
    keepAwakeProcess.kill();
    keepAwakeProcess = null;
  }
}
const sourcesInUse = new Set(); // cached download paths owned by a running video

// ---------------------------------------------------------------------------
// Temp space
// ---------------------------------------------------------------------------

function ensureTempRoot() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
}

// Jobs live in memory, so anything left in the temp folder at startup belongs
// to a run that was interrupted (crash/restart) and can be removed.
function sweepStaleTempFiles() {
  try {
    if (fs.existsSync(TEMP_ROOT)) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch (err) {
    console.error('Could not clear stale video temp files:', err.message);
  }
  pruneSourceCache();
}

function freeDiskBytes() {
  try {
    const stats = fs.statfsSync(TEMP_ROOT);
    return stats.bavail * stats.bsize;
  } catch (_) {
    return Infinity;
  }
}

// Source + converted copy + fast-start rewrite, plus headroom.
function diskNeededFor(file) {
  return file.size ? Math.ceil(file.size * 2.3) + 200 * 1024 * 1024 : 1024 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Small concurrency primitives
// ---------------------------------------------------------------------------

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return {
    async acquire() {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise(resolve => waiting.push(resolve));
      active++;
    },
    release() {
      active--;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

let reservedDiskBytes = 0;
let activeReservations = 0;

async function reserveDisk(bytes, signal) {
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' });
    if (bytes + reservedDiskBytes + DISK_SAFETY_MARGIN <= freeDiskBytes()) break;
    if (activeReservations === 0) {
      const err = new Error(`Not enough free disk space on the server to process this video (needs about ${formatBytes(bytes)}).`);
      err.category = 'Insufficient server disk space';
      throw err;
    }
    await new Promise(r => setTimeout(r, 3000)); // wait for other videos to finish and free space
  }
  reservedDiskBytes += bytes;
  activeReservations++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedDiskBytes -= bytes;
    activeReservations--;
  };
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

// "Sunday_Service.MOV" -> "Sunday_Service.mp4"; clashes become "Name (2).mp4".
function outputNameFor(sourceName, usedNames) {
  const ext = path.extname(sourceName);
  const base = (ext ? sourceName.slice(0, -ext.length) : sourceName) || 'video';
  let candidate = `${base}.mp4`;
  let n = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} (${n}).mp4`;
    n++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const RECOMMENDED_ACTIONS = {
  download: 'Check that the video still exists in Google Drive and that you can open it, then retry.',
  analysis: 'The file may be corrupt, incomplete, or not really a video. Try playing it on a computer; if it plays, retry.',
  conversion: 'The video stream appears to be damaged or uses an unsupported format. Try re-exporting it from the camera or editing software.',
  validation: 'The converted file did not pass quality checks, so it was not uploaded. Retry; if it fails again, re-export the original.',
  upload: 'Check your internet connection and Google Drive storage space, then retry.',
  disk: 'Free up space on the server (or process fewer/smaller videos at once), then retry.'
};

function classify(stage, err) {
  if (err.category) return { category: err.category, action: RECOMMENDED_ACTIONS.disk };
  const status = err.response ? err.response.status : (typeof err.code === 'number' ? err.code : null);
  if (stage === 'download' || stage === 'upload') {
    if (status === 404) return { category: 'File not found in Google Drive', action: RECOMMENDED_ACTIONS[stage] };
    if (status === 401 || status === 403) {
      // Google uses "quota" for two unrelated limits; only one is about storage.
      const details = `${err.message} ${JSON.stringify((err.response && err.response.data) || err.errors || '')}`;
      if (/downloadQuotaExceeded|download quota/i.test(details)) {
        return {
          category: 'Google Drive daily download limit reached for this file',
          action: 'This is not a storage problem. Google temporarily limits how often one file can be downloaded. Wait up to 24 hours, then retry; parts already downloaded are kept.'
        };
      }
      if (/storageQuotaExceeded/i.test(details)) {
        return {
          category: 'Google Drive storage full',
          action: 'Free up space in the signed-in Google account (Drive, Gmail and Photos share it) and empty the Drive Trash, then retry.'
        };
      }
      return {
        category: 'Google Drive permission denied',
        action: 'Sign out and sign in again, and make sure your account can access this folder.'
      };
    }
    return { category: 'Network / Google Drive error', action: RECOMMENDED_ACTIONS[stage] };
  }
  if (stage === 'analysis') return { category: 'Unreadable or unsupported file', action: RECOMMENDED_ACTIONS.analysis };
  if (stage === 'conversion') return { category: 'Unsupported/corrupt video stream', action: RECOMMENDED_ACTIONS.conversion };
  if (stage === 'validation') return { category: 'Converted file failed validation', action: RECOMMENDED_ACTIONS.validation };
  return { category: 'Unexpected error', action: 'Retry the video. If it keeps failing, contact the administrator with this report.' };
}

// ---------------------------------------------------------------------------
// Per-video pipeline
// ---------------------------------------------------------------------------

async function processVideo(ctx, fileState) {
  const { tokens, outputFolder, settings, signal, encodeSlots, jobDir } = ctx;
  const source = fileState.source;
  const workDir = path.join(jobDir, `v${fileState.index}`);
  // The downloaded original lives in a cache outside the job folder, so a
  // retry (even in a later run) resumes or reuses it instead of downloading
  // the whole file again — repeat downloads trip Google's per-file limit.
  const inputPath = sourceCachePath(source);
  const outputPath = path.join(workDir, 'output.mp4');
  let keepCachedSource = false;
  const set = updates => Object.assign(fileState, updates);
  const log = message => fileState.log.push(`${new Date().toISOString()} ${message}`);
  let stage = 'download';
  let releaseDisk = null;

  // Two jobs must never write the same cached download at once.
  if (sourcesInUse.has(inputPath)) {
    set({ status: 'skipped', reason: 'This video is already being converted by another job right now.' });
    return;
  }
  sourcesInUse.add(inputPath);

  try {
    if (source.size === 0) {
      set({ status: 'skipped', reason: 'The file is empty (0 bytes).' });
      return;
    }

    releaseDisk = await reserveDisk(diskNeededFor(source), signal);
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(CACHE_ROOT, { recursive: true });

    // 1. Download (read-only access to the original).
    set({ status: 'downloading', progress: 0 });
    const alreadyHave = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
    log(alreadyHave
      ? `Resuming download: ${formatBytes(alreadyHave)} of ${formatBytes(source.size)} already on this computer`
      : `Downloading ${formatBytes(source.size)} from Google Drive`);
    await drive.downloadFileToDisk(tokens, source, inputPath, {
      retries: settings.retryCount,
      signal,
      maxQuotaWaits: 24, // hourly for a day: Google's per-file limit resets within 24h
      onProgress: (done, total) => set({ status: 'downloading', reason: null, progress: total ? Math.floor((done / total) * 100) : 0 }),
      onRetry: (attempt, err) => log(`Download interrupted (${err.message}); retry ${attempt}`),
      onQuotaWait: (attempt, nextTry) => {
        const at = nextTry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        set({ status: 'waiting-for-limit', reason: `Google's daily download limit for this file was reached. Trying again automatically at ${at} (attempt ${attempt} of 24).` });
        log(`Google download limit reached; waiting until ${at}`);
      }
    });

    // 2. Analyze.
    stage = 'analysis';
    set({ status: 'analyzing', progress: 0 });
    const sourceInfo = video.analyze(await video.probe(inputPath, { signal }));
    set({ sourceSummary: video.summarize(sourceInfo) });

    let plan;
    try {
      plan = video.planConversion(sourceInfo, settings);
    } catch (err) {
      if (err.skip) {
        set({ status: 'skipped', reason: err.message });
        log(`Skipped: ${err.message}`);
        return;
      }
      throw err;
    }
    log(`Plan: ${plan.description}`);

    // 3. Convert, then 4. validate. If a direct copy (remux) does not yield a
    // valid MP4, fall back once to a full compatibility re-encode.
    let validation;
    for (;;) {
      stage = 'conversion';
      set({ status: plan.strategy === 'encode' ? 'converting' : 'remuxing', progress: 0, strategy: plan.strategy, planDescription: plan.description });
      const needsEncodeSlot = plan.video.action === 'encode';
      if (needsEncodeSlot) {
        set({ status: 'queued-for-conversion' });
        await encodeSlots.acquire();
        set({ status: 'converting' });
      }
      let conversionError = null;
      try {
        fs.rmSync(outputPath, { force: true });
        await video.convert(inputPath, outputPath, sourceInfo, plan, { signal, onProgress: p => set({ progress: p }) });
      } catch (err) {
        conversionError = err;
      } finally {
        if (needsEncodeSlot) encodeSlots.release();
      }

      if (!conversionError) {
        stage = 'validation';
        set({ status: 'validating', progress: 0 });
        validation = await video.validateOutput(outputPath, sourceInfo, plan, { signal, fullDecode: settings.fullDecodeCheck });
        if (validation.ok) break;
      }

      if (conversionError && conversionError.name === 'AbortError') throw conversionError;
      const problem = conversionError ? conversionError.message : validation.errors.join(' ');
      if (!plan.safeMode && plan.strategy !== 'encode') {
        log(`Direct copy did not produce a valid MP4 (${problem}); retrying with full re-encode`);
        plan = video.planConversion(sourceInfo, settings, { safeMode: true });
        continue;
      }
      if (conversionError) throw conversionError;
      const err = new Error(`Converted file failed validation: ${validation.errors.join(' ')}`);
      throw err;
    }

    const outputSummary = video.summarize(validation.outputInfo);
    const differences = video.compareSummaries(fileState.sourceSummary, outputSummary);
    const notes = [...plan.notes];
    if (validation.missingMetadata.length) notes.push(`Metadata not carried over (not supported in MP4): ${validation.missingMetadata.join(', ')}.`);
    set({
      outputSummary,
      notes,
      warnings: [...plan.warnings, ...validation.warnings, ...differences.map(d => `Changed: ${d}`)]
    });
    log(`Validated output (${formatBytes(outputSummary.size)})`);

    // 5. Upload into the NEW output folder. The original stays cached until
    // the upload succeeds, so a failed upload never forces a re-download.
    stage = 'upload';
    set({ status: 'uploading', progress: 0 });
    const uploaded = await drive.uploadFileResumable(tokens, outputFolder.folderId, outputPath, fileState.outputName, {
      mimeType: 'video/mp4',
      appProperties: { [APP_PROPERTY_SOURCE]: source.id },
      retries: settings.retryCount,
      signal,
      onProgress: (done, total) => set({ progress: total ? Math.floor((done / total) * 100) : 0 }),
      onRetry: (attempt, err) => log(`Upload interrupted (${err.message}); retry ${attempt}`)
    });

    set({
      status: 'complete',
      progress: 100,
      flagged: fileState.warnings.length > 0,
      outputFileId: uploaded.id,
      outputLink: uploaded.webViewLink
    });
    log('Uploaded and verified in Google Drive');
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) {
      keepCachedSource = true; // a later run can pick up where this stopped
      set({ status: 'cancelled', progress: 0 });
      return;
    }
    // Network/Drive problems are worth retrying with the copy we already
    // have; a file that is corrupt or unconvertible is not.
    keepCachedSource = stage === 'download' || stage === 'upload';
    const { category, action } = classify(stage, err);
    set({
      status: 'failed',
      error: {
        stage: { download: 'Download', analysis: 'Analysis', conversion: 'Conversion', validation: 'Validation', upload: 'Upload' }[stage] || stage,
        category,
        message: err.message,
        technical: err.stderrTail || null,
        recommendedAction: action
      }
    });
    log(`Failed at ${stage}: ${err.message}`);
  } finally {
    if (releaseDisk) releaseDisk();
    // Converted output is always removed. The original is kept only for a
    // pending retry of a network failure, and expires after CACHE_MAX_AGE_MS.
    fs.rmSync(workDir, { recursive: true, force: true });
    if (!keepCachedSource) fs.rmSync(inputPath, { force: true });
    sourcesInUse.delete(inputPath);
  }
}

function sourceCachePath(source) {
  const id = String(source.id).replace(/[^A-Za-z0-9_-]/g, '');
  const version = String(source.md5Checksum || source.size || 'unknown').replace(/[^A-Za-z0-9]/g, '');
  return path.join(CACHE_ROOT, `${id}-${version}${safeExt(source.name)}`);
}

// Drop cached originals nobody came back for.
function pruneSourceCache() {
  try {
    if (!fs.existsSync(CACHE_ROOT)) return;
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    for (const name of fs.readdirSync(CACHE_ROOT)) {
      const file = path.join(CACHE_ROOT, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    console.error('Could not prune the video download cache:', err.message);
  }
}

function safeExt(name) {
  const ext = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.bin';
}

// ---------------------------------------------------------------------------
// Job orchestration
// ---------------------------------------------------------------------------

// Each stage owns a slice of a video's progress so the overall bar only moves forward.
const STAGE_SLICES = {
  'waiting-for-limit': [0, 0],
  downloading: [0, 0.3],
  analyzing: [0.3, 0],
  'queued-for-conversion': [0.3, 0],
  remuxing: [0.3, 0.5],
  converting: [0.3, 0.5],
  validating: [0.8, 0.1],
  uploading: [0.9, 0.1]
};

function fileFraction(f) {
  const [start, span] = STAGE_SLICES[f.status] || [0, 0];
  return Math.min(0.99, start + span * ((f.progress || 0) / 100));
}

function snapshot(jobId) {
  const job = getJob(jobId);
  if (!job || job.kind !== 'video') return null;
  const files = job.files.map(f => ({
    index: f.index,
    sourceId: f.source.id,
    name: f.source.name,
    size: f.source.size,
    outputName: f.outputName,
    status: f.status,
    progress: f.progress,
    strategy: f.strategy,
    planDescription: f.planDescription,
    reason: f.reason,
    flagged: f.flagged,
    sourceSummary: f.sourceSummary,
    outputSummary: f.outputSummary,
    notes: f.notes,
    warnings: f.warnings,
    error: f.error,
    outputLink: f.outputLink
  }));
  const count = status => files.filter(f => f.status === status).length;
  const finished = files.filter(f => ['complete', 'failed', 'skipped', 'cancelled'].includes(f.status)).length;
  const inFlight = files.filter(f => !['waiting', 'complete', 'failed', 'skipped', 'cancelled'].includes(f.status));
  const current = inFlight[0] || null;
  const overall = files.length
    ? Math.floor(((finished + inFlight.reduce((sum, f) => sum + fileFraction(f), 0)) / files.length) * 100)
    : 100;

  return {
    jobId,
    kind: 'video',
    total: files.length,
    processed: finished,
    successful: count('complete'),
    failed: count('failed'),
    skipped: count('skipped'),
    cancelled: count('cancelled'),
    flagged: files.filter(f => f.status === 'complete' && f.flagged).length,
    overallPercent: Math.min(100, overall),
    current: current ? { name: current.name, status: current.status, progress: current.progress } : null,
    active: inFlight.map(f => ({ name: f.name, status: f.status, progress: f.progress })),
    sourceFolderId: job.sourceFolderId,
    sourceFolderName: job.sourceFolderName,
    outputFolderId: job.outputFolder.folderId,
    outputFolderName: job.outputFolder.folderName,
    outputFolderLink: job.outputFolder.webViewLink,
    elapsedMs: Date.now() - job.startTime,
    cancelling: Boolean(job.cancelling),
    done: job.done,
    error: job.error,
    files
  };
}

/**
 * Starts a background conversion job and returns its id immediately.
 * @param {object} opts
 * @param {object} opts.tokens           Google OAuth tokens (from the session)
 * @param {string} opts.ownerSessionId   only this session may watch/cancel it
 * @param {object} opts.folderInfo       { folderId, folderName } of the source
 * @param {Array}  opts.videos           Drive files from listVideosInFolder
 * @param {object} opts.outputFolder     { folderId, folderName, webViewLink }
 * @param {Array}  opts.existingOutputFiles  files already in the output folder
 */
function startVideoJob({ tokens, ownerSessionId, folderInfo, videos, outputFolder, existingOutputFiles = [] }) {
  const settings = video.getVideoSettings();
  const usedNames = new Set(existingOutputFiles.map(f => f.name.toLowerCase()));
  const alreadyConverted = new Set(
    existingOutputFiles.map(f => f.appProperties && f.appProperties[APP_PROPERTY_SOURCE]).filter(Boolean)
  );

  const files = videos.map((source, index) => {
    const done = alreadyConverted.has(source.id);
    return {
      index,
      source,
      outputName: done ? null : outputNameFor(source.name, usedNames),
      status: done ? 'skipped' : 'waiting',
      reason: done ? 'Already converted in this output folder.' : null,
      progress: 0,
      notes: [],
      warnings: [],
      log: []
    };
  });

  const jobId = createJob(files.length);
  const controller = new AbortController();
  controllers.set(jobId, controller);
  updateKeepAwake();
  updateJob(jobId, {
    kind: 'video',
    ownerSessionId,
    sourceFolderId: folderInfo.folderId,
    sourceFolderName: folderInfo.folderName,
    outputFolder,
    files
  });

  const jobDir = path.join(TEMP_ROOT, jobId);
  const ctx = {
    tokens,
    outputFolder,
    settings,
    signal: controller.signal,
    encodeSlots: createSemaphore(settings.maxConcurrentEncodes),
    jobDir
  };

  (async () => {
    try {
      ensureTempRoot();
      fs.mkdirSync(jobDir, { recursive: true });
      const queue = files.filter(f => f.status === 'waiting');
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (controller.signal.aborted) {
            next.status = 'cancelled';
            continue;
          }
          await processVideo(ctx, next);
          updateJob(jobId, progressCounts(files));
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, settings.maxConcurrentFiles) }, worker));

      const result = snapshot(jobId);
      const record = addJobRecord({
        type: 'video',
        sourceFolderName: folderInfo.folderName,
        outputFolderName: outputFolder.folderName,
        outputFolderLink: outputFolder.webViewLink,
        totalVideos: result.total,
        successful: result.successful,
        failed: result.failed,
        skipped: result.skipped,
        cancelled: result.cancelled,
        flagged: result.flagged,
        duration: Math.round(result.elapsedMs / 1000),
        errors: result.files.filter(f => f.status === 'failed').map(f => ({ filename: f.name, ...f.error })),
        files: result.files.map(f => ({ name: f.name, outputName: f.outputName, status: f.status, strategy: f.strategy, warnings: f.warnings }))
      });
      completeJob(jobId, { historyId: record && record.id });
    } catch (err) {
      console.error('Video batch error:', err);
      failJob(jobId, `Video conversion stopped unexpectedly: ${err.message}`);
    } finally {
      controllers.delete(jobId);
      updateKeepAwake();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  })();

  return jobId;
}

function progressCounts(files) {
  return {
    processed: files.filter(f => ['complete', 'failed', 'skipped', 'cancelled'].includes(f.status)).length,
    successful: files.filter(f => f.status === 'complete').length,
    failed: files.filter(f => f.status === 'failed').length
  };
}

function cancelVideoJob(jobId) {
  const controller = controllers.get(jobId);
  if (!controller) return false;
  updateJob(jobId, { cancelling: true });
  controller.abort();
  return true;
}

// Stop FFmpeg children and remove temp files if the server is shut down mid-job.
function installShutdownHandlers() {
  const shutdown = sig => {
    for (const controller of controllers.values()) controller.abort();
    setTimeout(() => {
      sweepStaleTempFiles();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }, 500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  startVideoJob,
  cancelVideoJob,
  snapshot,
  outputNameFor,
  sweepStaleTempFiles,
  installShutdownHandlers,
  APP_PROPERTY_SOURCE,
  TEMP_ROOT,
  CACHE_ROOT,
  sourceCachePath
};
