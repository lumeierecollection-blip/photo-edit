const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { validateFolder, listPhotosInFolder, downloadFile, createOutputFolder, uploadFile } = require('../services/driveService');
const { applyWatermark, generatePreview } = require('../services/imageService');
const { getSettings } = require('../config');
const { addJobRecord } = require('../services/jobService');
const { createJob, getJob, updateJob, completeJob, failJob } = require('../services/progressStore');

// Middleware to check authentication
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated with Google Drive.' });
  }
  next();
}

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
  res.json({ success: true, jobId, totalPhotos: photos.length });

  (async () => {
    try {
      const outputFolderName = `${folderInfo.folderName}${settings.outputFolderSuffix || ' — Watermarked'}`;
      const outputFolder = await createOutputFolder(tokens, folderInfo.folderId, outputFolderName);

      let successful = 0;
      let failed = 0;
      const errors = [];

      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        updateJob(jobId, { currentFile: photo.name });
        const localInput = path.join(tempDir, `in_${Date.now()}_${photo.name}`);
        const localOutput = path.join(tempDir, `out_${Date.now()}_${photo.name}`);

        try {
          await downloadFile(tokens, photo.id, localInput);
          await applyWatermark(localInput, localOutput, settings);
          await uploadFile(tokens, outputFolder.folderId, localOutput, photo.name);

          successful++;
        } catch (err) {
          failed++;
          errors.push({
            filename: photo.name,
            problem: err.message,
            suggestedAction: 'Check file format or network connection and retry.'
          });
        } finally {
          if (fs.existsSync(localInput)) fs.unlink(localInput, () => {});
          if (fs.existsSync(localOutput)) fs.unlink(localOutput, () => {});
          updateJob(jobId, { processed: i + 1, successful, failed });
        }
      }

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
        errors
      });

      completeJob(jobId, {
        jobId: jobRecord.id,
        totalPhotos: photos.length,
        successful,
        failed,
        ignoredCount,
        outputFolderName: outputFolder.folderName,
        outputFolderLink: outputFolder.webViewLink,
        errors
      });
    } catch (err) {
      console.error('Batch processing error:', err);
      failJob(jobId, `Batch processing failed: ${err.message}`);
    }
  })();
});

router.get('/process/:jobId/status', requireAuth, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const elapsedMs = Date.now() - job.startTime;
  let etaMs = null;
  if (!job.done && job.processed > 0) {
    const avgPerPhoto = elapsedMs / job.processed;
    etaMs = Math.round(avgPerPhoto * (job.total - job.processed));
  }

  res.json({
    total: job.total,
    processed: job.processed,
    successful: job.successful,
    failed: job.failed,
    currentFile: job.currentFile,
    elapsedMs,
    etaMs,
    done: job.done,
    error: job.error,
    result: job.result
  });
});

module.exports = router;
