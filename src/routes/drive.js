const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { validateFolder, listPhotosInFolder, downloadFile, downloadFileToDisk, createOutputFolder, uploadFile, listFolderChildren } = require('../services/driveService');
const { applyWatermark, generatePreview } = require('../services/imageService');
const { isRawFileName } = require('../services/rawPreview');
const { getSettings } = require('../config');
const { addJobRecord } = require('../services/jobService');
const { createJob, getJob, updateJob, completeJob, failJob } = require('../services/progressStore');
const requireAuth = require('../middleware/requireAuth');


router.post('/validate', requireAuth, async (req, res) => {
  try {
    const { folderUrl, includeSubfolders } = req.body;
    if (!folderUrl) {
      return res.status(400).json({ error: 'Folder URL is required.' });
    }

    const folderInfo = await validateFolder(req.session.tokens, folderUrl);
    const { photos, ignoredCount } = await listPhotosInFolder(
      req.session.tokens,
      folderInfo.folderId,
      Boolean(includeSubfolders)
    );

    res.json({
      folderId: folderInfo.folderId,
      folderName: folderInfo.folderName,
      photoCount: photos.length,
      ignoredCount: ignoredCount,
      photos: photos.slice(0, 10) // Send sample for preview
    });
  } catch (err) {
    console.error('Validation error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/preview', requireAuth, async (req, res) => {
  const tempDir = path.join(__dirname, '../../uploads/temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `preview_in_${Date.now()}.jpg`);
  const outputPath = path.join(tempDir, `preview_out_${Date.now()}.jpg`);

  try {
    const { fileId } = req.body;
    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required for preview.' });
    }

    // Download first photo
    await downloadFile(req.session.tokens, fileId, inputPath);

    // Apply watermark
    await generatePreview(inputPath, outputPath);

    // Send watermarked image as response
    res.sendFile(outputPath, () => {
      // Cleanup temp files after sending
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  } catch (err) {
    console.error('Preview error:', err.message);
    if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    res.status(500).json({ error: `Failed to generate preview: ${err.message}` });
  }
});

router.post('/process', requireAuth, async (req, res) => {
  const { folderUrl, includeSubfolders } = req.body;
  if (!folderUrl) {
    return res.status(400).json({ error: 'Folder URL is required.' });
  }

  const settings = getSettings();
  const tokens = req.session.tokens;
  const tempDir = path.join(__dirname, '../../uploads/temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let folderInfo, photos, ignoredCount;
  try {
    folderInfo = await validateFolder(tokens, folderUrl);
    ({ photos, ignoredCount } = await listPhotosInFolder(
      tokens,
      folderInfo.folderId,
      Boolean(includeSubfolders)
    ));

    if (photos.length === 0) {
      return res.status(400).json({ error: 'No supported photographs found in the folder.' });
    }
  } catch (err) {
    console.error('Validation error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // Hand back a job id immediately so the client can poll for live progress
  // instead of blocking on the whole batch inside a single request.
  const jobId = createJob(photos.length);
  updateJob(jobId, { paused: false, cancelled: false, pausedAt: null, pausedMs: 0 });
  const control = { controller: new AbortController(), resume: null };
  controls.set(jobId, control);
  res.json({ success: true, jobId, totalPhotos: photos.length });

  (async () => {
    try {
      const outputFolderName = `${folderInfo.folderName}${settings.outputFolderSuffix || ' — Watermarked'}`;
      const outputFolder = await createOutputFolder(tokens, folderInfo.folderId, outputFolderName);

      let successful = 0;
      let failed = 0;
      let skipped = 0;
      const errors = [];

      // Running a folder again (e.g. to retry failed photos) must not upload
      // the photos that already worked a second time.
      let alreadyDone = new Set();
      if (outputFolder.exists) {
        try {
          alreadyDone = new Set((await listFolderChildren(tokens, outputFolder.folderId, '', 'id, name')).map(f => f.name));
        } catch (err) {
          console.error('Could not list the existing output folder:', err.message);
        }
      }

      for (let i = 0; i < photos.length; i++) {
        await waitWhilePaused(jobId);
        if (getJob(jobId).cancelled) break;
        // A pause pressed between photos aborted nothing; start clean.
        if (control.controller.signal.aborted) control.controller = new AbortController();

        const photo = photos[i];
        updateJob(jobId, { currentFile: photo.name });
        // Camera RAW files (.CR2 etc.) come out as JPEGs: IMG_8464.CR2 → IMG_8464.jpg
        const outputName = isRawFileName(photo.name) ? photo.name.replace(/\.[^.]+$/, '.jpg') : photo.name;
        if (alreadyDone.has(outputName)) {
          skipped++;
          updateJob(jobId, { processed: i + 1, successful, failed, skipped });
          continue;
        }
        const localInput = path.join(tempDir, `in_${Date.now()}_${photo.name}`);
        const localOutput = path.join(tempDir, `out_${Date.now()}_${outputName}`);
        const { signal } = control.controller;
        let interrupted = false;

        try {
          // Resumes after dropped connections and checks the file against Drive's MD5.
          await downloadFileToDisk(tokens, photo, localInput, { signal });
          await applyWatermark(localInput, localOutput, settings);
          await uploadFile(tokens, outputFolder.folderId, localOutput, outputName, { signal });

          successful++;
        } catch (err) {
          if (err.name === 'AbortError' || signal.aborted) {
            // Paused or cancelled part-way: not a failure. A paused photo is
            // done again from the start when the batch resumes.
            interrupted = true;
            control.controller = new AbortController();
            if (!getJob(jobId).cancelled) i--;
          } else {
            failed++;
            errors.push({
              filename: photo.name,
              problem: err.message,
              suggestedAction: 'Check file format or network connection and retry.'
            });
          }
        } finally {
          if (fs.existsSync(localInput)) fs.unlink(localInput, () => {});
          if (fs.existsSync(localOutput)) fs.unlink(localOutput, () => {});
          if (!interrupted) updateJob(jobId, { processed: i + 1, successful, failed });
        }
      }

      const cancelled = Boolean(getJob(jobId).cancelled);
      const duration = Math.round((Date.now() - getJob(jobId).startTime) / 1000);

      const jobRecord = addJobRecord({
        sourceFolderName: folderInfo.folderName,
        outputFolderName: outputFolder.folderName,
        outputFolderLink: outputFolder.webViewLink,
        totalPhotos: photos.length,
        successful,
        failed,
        ignoredCount,
        duration,
        errors,
        cancelled
      });

      completeJob(jobId, {
        jobId: jobRecord.id,
        totalPhotos: photos.length,
        successful,
        failed,
        skipped,
        cancelled,
        ignoredCount,
        outputFolderName: outputFolder.folderName,
        outputFolderLink: outputFolder.webViewLink,
        errors
      });
    } catch (err) {
      console.error('Batch processing error:', err);
      failJob(jobId, `Batch processing failed: ${err.message}`);
    } finally {
      updateJob(jobId, { paused: false, pausedAt: null });
      controls.delete(jobId);
    }
  })();
});

// ---------------------------------------------------------------------------
// Pause / resume / cancel. Pausing stops the current transfer straight away
// (that photo is redone on resume); cancelling stops the batch and keeps the
// photos already finished in the output folder.
// ---------------------------------------------------------------------------

const controls = new Map(); // jobId -> { controller, resume }

function waitWhilePaused(jobId) {
  const job = getJob(jobId);
  if (!job || !job.paused || job.cancelled) return Promise.resolve();
  return new Promise(resolve => { controls.get(jobId).resume = resolve; });
}

function wake(control) {
  if (control.resume) {
    const resume = control.resume;
    control.resume = null;
    resume();
  }
}

function controllableJob(req, res) {
  const job = getJob(req.params.jobId);
  const control = controls.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return null;
  }
  if (job.done || !control) {
    res.status(409).json({ error: 'This job has already finished.' });
    return null;
  }
  return { job, control };
}

router.post('/process/:jobId/pause', requireAuth, (req, res) => {
  const found = controllableJob(req, res);
  if (!found) return;
  const { job, control } = found;
  if (!job.paused) {
    updateJob(job.jobId, { paused: true, pausedAt: Date.now() });
    control.controller.abort();
  }
  res.json({ paused: true });
});

router.post('/process/:jobId/resume', requireAuth, (req, res) => {
  const found = controllableJob(req, res);
  if (!found) return;
  const { job, control } = found;
  if (job.paused) {
    updateJob(job.jobId, { paused: false, pausedAt: null, pausedMs: job.pausedMs + (Date.now() - job.pausedAt) });
    wake(control);
  }
  res.json({ paused: false });
});

router.post('/process/:jobId/cancel', requireAuth, (req, res) => {
  const found = controllableJob(req, res);
  if (!found) return;
  const { job, control } = found;
  updateJob(job.jobId, { cancelled: true });
  control.controller.abort();
  wake(control);
  res.json({ cancelled: true });
});

router.get('/process/:jobId/status', requireAuth, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  // Time spent paused doesn't count towards the speed estimate.
  const pausedMs = (job.pausedMs || 0) + (job.paused && job.pausedAt ? Date.now() - job.pausedAt : 0);
  const elapsedMs = Date.now() - job.startTime - pausedMs;
  let etaMs = null;
  if (!job.done && !job.paused && job.processed > 0) {
    const avgPerPhoto = elapsedMs / job.processed;
    etaMs = Math.round(avgPerPhoto * (job.total - job.processed));
  }

  res.json({
    total: job.total,
    processed: job.processed,
    successful: job.successful,
    failed: job.failed,
    currentFile: job.currentFile,
    paused: Boolean(job.paused),
    cancelled: Boolean(job.cancelled),
    elapsedMs,
    etaMs,
    done: job.done,
    error: job.error,
    result: job.result
  });
});

module.exports = router;
