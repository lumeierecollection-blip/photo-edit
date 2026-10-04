const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const {
  validateFolder, listVideosInFolder, findChildFolders, createFolder, getFolder, listFolderChildren
} = require('../services/driveService');
const { getEngine, getVideoSettings } = require('../services/videoService');
const { startVideoJob, cancelVideoJob, snapshot } = require('../services/videoJobService');
const { getJob } = require('../services/progressStore');

router.use(requireAuth);

function outputFolderNameFor(folderName) {
  return `${folderName}${getVideoSettings().outputFolderSuffix}`;
}

router.get('/engine', (req, res) => {
  const engine = getEngine();
  res.json({
    available: engine.available,
    ffmpegVersion: engine.ffmpeg ? engine.ffmpeg.version : null,
    ffprobeVersion: engine.ffprobe ? engine.ffprobe.version : null
  });
});

// Step 1: verify the folder and count the videos in it.
router.post('/scan', async (req, res) => {
  try {
    const { folderUrl, includeSubfolders } = req.body || {};
    if (!folderUrl) return res.status(400).json({ error: 'Folder URL is required.' });

    const folderInfo = await validateFolder(req.session.tokens, folderUrl);
    const { videos, ignoredCount } = await listVideosInFolder(req.session.tokens, folderInfo.folderId, Boolean(includeSubfolders));
    const outputFolderName = outputFolderNameFor(folderInfo.folderName);
    const existing = await findChildFolders(req.session.tokens, folderInfo.folderId, outputFolderName);

    res.json({
      folderId: folderInfo.folderId,
      folderName: folderInfo.folderName,
      videoCount: videos.length,
      ignoredCount,
      totalBytes: videos.reduce((sum, v) => sum + (v.size || 0), 0),
      videos: videos.map(v => ({ id: v.id, name: v.name, size: v.size })),
      outputFolderName,
      existingOutputFolders: existing.map(f => ({ id: f.id, name: f.name, link: f.webViewLink, createdTime: f.createdTime }))
    });
  } catch (err) {
    console.error('Video scan error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Step 2: create/choose the output folder and start converting.
// outputMode: 'new' (always a fresh folder) | 'existing' (reprocess into the
// existing folder; already-converted videos are skipped, nothing is overwritten).
router.post('/convert', async (req, res) => {
  const tokens = req.session.tokens;
  const { folderUrl, includeSubfolders, outputMode, outputFolderId, fileIds } = req.body || {};
  if (!folderUrl) return res.status(400).json({ error: 'Folder URL is required.' });

  const engine = getEngine({ refresh: !getEngine().available });
  if (!engine.available) {
    return res.status(503).json({ error: 'The video engine (FFmpeg) is not installed on the server. Ask your administrator to install it.' });
  }

  try {
    const folderInfo = await validateFolder(tokens, folderUrl);
    let { videos } = await listVideosInFolder(tokens, folderInfo.folderId, Boolean(includeSubfolders));

    // Retrying specific files: only accept ids that really are in this folder.
    if (Array.isArray(fileIds) && fileIds.length) {
      const wanted = new Set(fileIds.map(String));
      videos = videos.filter(v => wanted.has(v.id));
    }
    if (videos.length === 0) return res.status(400).json({ error: 'No videos found to convert.' });

    let outputFolder;
    let existingOutputFiles = [];
    if (outputFolderId) {
      const folder = await getFolder(tokens, String(outputFolderId));
      if (!(folder.parents || []).includes(folderInfo.folderId)) {
        return res.status(400).json({ error: 'That output folder does not belong to this source folder.' });
      }
      outputFolder = { folderId: folder.id, folderName: folder.name, webViewLink: folder.webViewLink };
    } else {
      const baseName = outputFolderNameFor(folderInfo.folderName);
      const existing = await findChildFolders(tokens, folderInfo.folderId, baseName);
      if (existing.length && outputMode !== 'new' && outputMode !== 'existing') {
        return res.status(409).json({
          needsChoice: true,
          error: `A folder named "${baseName}" already exists.`,
          existingOutputFolders: existing.map(f => ({ id: f.id, name: f.name, link: f.webViewLink }))
        });
      }
      if (existing.length && outputMode === 'existing') {
        const folder = existing.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))[0];
        outputFolder = { folderId: folder.id, folderName: folder.name, webViewLink: folder.webViewLink };
      } else {
        let name = baseName;
        for (let n = 2; existing.length && (await findChildFolders(tokens, folderInfo.folderId, name)).length; n++) {
          name = `${baseName} (${n})`;
        }
        outputFolder = await createFolder(tokens, folderInfo.folderId, name);
      }
    }
    if (outputFolderId || outputMode === 'existing') {
      existingOutputFiles = await listFolderChildren(tokens, outputFolder.folderId, '', 'id, name, appProperties');
    }

    const jobId = startVideoJob({
      tokens,
      ownerSessionId: req.sessionID,
      folderInfo,
      videos,
      outputFolder,
      existingOutputFiles
    });
    res.json({ success: true, jobId, totalVideos: videos.length, outputFolderName: outputFolder.folderName });
  } catch (err) {
    console.error('Video convert error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

function ownJob(req, res) {
  const job = getJob(req.params.jobId);
  if (!job || job.kind !== 'video' || job.ownerSessionId !== req.sessionID) {
    res.status(404).json({ error: 'Conversion job not found.' });
    return null;
  }
  return job;
}

router.get('/jobs/:jobId', (req, res) => {
  if (!ownJob(req, res)) return;
  res.json(snapshot(req.params.jobId));
});

router.post('/jobs/:jobId/cancel', (req, res) => {
  if (!ownJob(req, res)) return;
  res.json({ cancelled: cancelVideoJob(req.params.jobId) });
});

module.exports = router;
