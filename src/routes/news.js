const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const requireAuth = require('../middleware/requireAuth');
const news = require('../services/newsProjectService');
const drive = require('../services/driveService');
const { getEngine } = require('../services/videoService');
const { getTranscriptionSettings, MODELS } = require('../services/transcriptionService');

const router = express.Router();
router.use(requireAuth);

const UPLOAD_TMP = path.join(news.NEWS_DIR, '.incoming');
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|avi|webm|wmv|mts|m2ts|3gp|flv|mpg|mpeg)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(UPLOAD_TMP, { recursive: true });
      cb(null, UPLOAD_TMP);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}.upload`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (VIDEO_EXT_RE.test(file.originalname) || /^video\//.test(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Please choose a video file (MP4, MOV, MKV, AVI, WEBM…).'), { status: 400 }));
  }
});

// The address the headless renderer uses to fetch this project's video and
// the church logo from this same server.
function mediaBase(req) {
  return `http://127.0.0.1:${req.socket.localPort}`;
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('News route error:', err);
      res.status(status).json({ error: err.message || 'Something went wrong.' });
    }
  };
}

router.get('/status', (req, res) => {
  const engine = getEngine();
  const settings = getTranscriptionSettings();
  const modelDir = path.join(__dirname, '../../uploads/models', ...MODELS[settings.model].split('/'));
  res.json({
    ffmpeg: engine.available,
    model: MODELS[settings.model],
    language: settings.language,
    modelDownloaded: fs.existsSync(path.join(modelDir, '.complete'))
  });
});

router.get('/projects', handle((req, res) => {
  res.json({ projects: news.listProjects() });
}));

router.post('/projects', (req, res) => {
  upload.single('video')(req, res, async err => {
    if (err) return res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No video file was received.' });
    try {
      const project = await news.createProjectFromUpload(req.file.path, req.file.originalname);
      res.json({ project });
    } catch (e) {
      fs.rm(req.file.path, { force: true }, () => {});
      res.status(e.status || 500).json({ error: e.message });
    }
  });
});

// ---------------------------------------------------------------------------
// Import a video from Google Drive. The download runs in the background (it can
// be several GB on a slow connection); the page polls for progress.
// ---------------------------------------------------------------------------

const driveImports = new Map();

router.post('/drive/list', handle(async (req, res) => {
  const folderUrl = String((req.body && req.body.folderUrl) || '').trim();
  if (!folderUrl) return res.status(400).json({ error: 'Paste a Google Drive folder link.' });
  let folder;
  try {
    folder = await drive.validateFolder(req.session.tokens, folderUrl);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { videos } = await drive.listVideosInFolder(req.session.tokens, folder.folderId, Boolean(req.body.includeSubfolders));
  res.json({ folderName: folder.folderName, videos });
}));

router.post('/drive/import', handle((req, res) => {
  const { fileId, name, size, md5Checksum } = req.body || {};
  if (!fileId || typeof fileId !== 'string') return res.status(400).json({ error: 'No video was chosen.' });
  const tokens = req.session.tokens;
  const originalName = String(name || 'drive-video.mp4');
  const importId = require('crypto').randomBytes(8).toString('hex');
  fs.mkdirSync(UPLOAD_TMP, { recursive: true });
  const tempPath = path.join(UPLOAD_TMP, `${importId}.drive`);
  const controller = new AbortController();
  const state = { stage: 'downloading', received: 0, total: size != null ? Number(size) : null, projectId: null, error: null, controller };
  driveImports.set(importId, state);

  (async () => {
    try {
      await drive.downloadFileToDisk(tokens, { id: fileId, size: state.total, md5Checksum: md5Checksum || null }, tempPath, {
        signal: controller.signal,
        onProgress: (received, total) => { state.received = received; if (total != null) state.total = total; }
      });
      state.stage = 'checking';
      const project = await news.createProjectFromUpload(tempPath, originalName);
      state.projectId = project.id;
      state.stage = 'done';
    } catch (err) {
      fs.rm(tempPath, { force: true }, () => {});
      state.stage = controller.signal.aborted ? 'cancelled' : 'error';
      state.error = controller.signal.aborted ? 'Cancelled.' : err.message;
    }
    setTimeout(() => driveImports.delete(importId), 60 * 60 * 1000).unref();
  })();

  res.json({ importId });
}));

router.get('/drive/import/:importId', handle((req, res) => {
  const s = driveImports.get(req.params.importId);
  if (!s) return res.status(404).json({ error: 'Unknown import.' });
  res.json({ stage: s.stage, received: s.received, total: s.total, projectId: s.projectId, error: s.error });
}));

router.post('/drive/import/:importId/cancel', handle((req, res) => {
  const s = driveImports.get(req.params.importId);
  if (s && s.stage === 'downloading') s.controller.abort();
  res.json({ cancelled: Boolean(s) });
}));

// Weekly background pictures from a Drive folder (replaces the previous ones).
const bgImports = new Map();

router.post('/projects/:id/background/drive', handle((req, res) => {
  const project = news.loadProject(req.params.id);
  const folderUrl = String((req.body && req.body.folderUrl) || '').trim();
  if (!folderUrl) return res.status(400).json({ error: 'Paste a Google Drive folder link.' });
  const state = { stage: 'working', done: 0, total: 0, name: '', error: null };
  bgImports.set(project.id, state);
  news.importBackgroundFromDrive(project.id, req.session.tokens, folderUrl, {
    onProgress: (done, total, name) => Object.assign(state, { done, total, name })
  }).then(() => { state.stage = 'done'; })
    .catch(err => { state.stage = 'error'; state.error = err.message; });
  res.json({ started: true });
}));

router.get('/projects/:id/background', handle((req, res) => {
  const project = news.loadProject(req.params.id);
  res.json({ import: bgImports.get(project.id) || null, background: project.background || null });
}));

router.get('/projects/:id', handle((req, res) => {
  res.json(news.getProjectDetails(req.params.id));
}));

router.patch('/projects/:id', handle((req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  res.json(news.updateProject(req.params.id, { name }));
}));

router.delete('/projects/:id', handle((req, res) => {
  news.loadProject(req.params.id);
  news.deleteProject(req.params.id);
  res.json({ success: true });
}));

router.post('/projects/:id/transcribe', handle((req, res) => {
  res.json({ job: news.startJob(req.params.id, 'transcribe') });
}));

router.post('/projects/:id/cancel', handle((req, res) => {
  res.json({ cancelled: news.cancelJob(req.params.id) });
}));

router.put('/projects/:id/posters', handle((req, res) => {
  res.json(news.savePosters(req.params.id, req.body && req.body.posters));
}));

router.post('/projects/:id/posters/detect', handle((req, res) => {
  res.json(news.detectPosters(req.params.id));
}));

router.post('/projects/:id/headlines/suggest', handle((req, res) => {
  res.json(news.suggestProjectHeadlines(req.params.id));
}));

router.put('/projects/:id/studio', handle((req, res) => {
  res.json({ studio: news.saveStudio(req.params.id, req.body || {}) });
}));

router.post('/projects/:id/preview', handle((req, res) => {
  if (req.body && Object.keys(req.body).length) news.saveStudio(req.params.id, req.body);
  res.json({ job: news.startJob(req.params.id, 'preview', { mediaBase: mediaBase(req) }) });
}));

router.post('/projects/:id/render', handle((req, res) => {
  if (req.body && Object.keys(req.body).length) news.saveStudio(req.params.id, req.body);
  res.json({ job: news.startJob(req.params.id, 'render', { mediaBase: mediaBase(req) }) });
}));

function safeDownloadName(project, suffix) {
  return `${project.name.replace(/[^\w\s-]+/g, '').trim() || 'church-news'}${suffix}`;
}

router.get('/projects/:id/source', handle((req, res) => {
  const project = news.loadProject(req.params.id);
  res.sendFile(news.filePath(project.id, project.videoFile));
}));

router.get('/projects/:id/preview.jpg', handle((req, res) => {
  const file = news.filePath(req.params.id, 'preview.jpg');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No preview yet.' });
  res.set('Cache-Control', 'no-store').sendFile(file);
}));

router.get('/projects/:id/news.mp4', handle((req, res) => {
  const project = news.loadProject(req.params.id);
  const file = news.filePath(project.id, 'news.mp4');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'The news video has not been rendered yet.' });
  if (req.query.download) res.attachment(safeDownloadName(project, ' - News.mp4'));
  res.sendFile(file);
}));

const TEXT_EXPORTS = {
  'transcript.txt': { make: news.transcriptAsText, suffix: ' - Transcript.txt', type: 'text/plain' },
  'transcript.srt': { make: news.transcriptAsSrt, suffix: ' - Subtitles.srt', type: 'application/x-subrip' },
  'posters.txt': { make: news.postersAsText, suffix: ' - Posters.txt', type: 'text/plain' }
};

router.get('/projects/:id/export/:file', handle((req, res) => {
  const spec = TEXT_EXPORTS[req.params.file];
  if (!spec) return res.status(404).json({ error: 'Unknown export.' });
  const project = news.loadProject(req.params.id);
  const body = spec.make(project.id);
  if (body === null) return res.status(404).json({ error: 'Nothing to export yet.' });
  res.attachment(safeDownloadName(project, spec.suffix)).type(spec.type).send(`﻿${body}`);
}));

// ---------------------------------------------------------------------------
// Media for the renderer. The headless browser has no sign-in cookie, so this
// is outside requireAuth; it only answers requests from this computer, and a
// project's files are only reachable with its random 128-bit id.
// ---------------------------------------------------------------------------

const mediaRouter = express.Router();

function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).end();
}

mediaRouter.use(localOnly);

mediaRouter.get('/logo.png', (req, res) => {
  const logo = require('../config').getLogoPath();
  if (!fs.existsSync(logo)) return res.status(404).end();
  res.sendFile(logo);
});

mediaRouter.get('/:id/bg/:file', (req, res) => {
  try {
    if (!/^\d{2}\.jpg$/.test(req.params.file)) return res.status(404).end();
    news.loadProject(req.params.id);
    res.sendFile(news.filePath(req.params.id, path.join('bg', req.params.file)));
  } catch (_) {
    res.status(404).end();
  }
});

mediaRouter.get('/:id/:file', (req, res) => {
  try {
    const project = news.loadProject(req.params.id);
    if (req.params.file !== project.videoFile) return res.status(404).end();
    res.sendFile(news.filePath(project.id, project.videoFile));
  } catch (_) {
    res.status(404).end();
  }
});

module.exports = router;
module.exports.mediaRouter = mediaRouter;
