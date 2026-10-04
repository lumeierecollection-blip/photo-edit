// Church News projects: one folder per uploaded video under uploads/news/,
// holding the video, its transcript, the poster suggestions, the studio
// settings and the rendered broadcast. Long work (transcribing, rendering)
// runs as background jobs whose progress is saved with the project, so a page
// refresh or a closed tab never loses it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../config');
const { requireEngine, runProcess } = require('./videoService');
const { transcribeVideo } = require('./transcriptionService');
const { suggestPosters, suggestHeadlines } = require('./posterService');
const { renderNewsVideo, renderPreviewFrame } = require('./newsRenderService');

const NEWS_DIR = process.env.CHURCH_NEWS_DIR || path.join(__dirname, '../../uploads/news');
const ID_RE = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function projectDir(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Project not found.'), { status: 404 });
  return path.join(NEWS_DIR, id);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadProject(id) {
  const dir = projectDir(id);
  const project = readJson(path.join(dir, 'project.json'));
  if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
  return project;
}

function saveProject(project) {
  writeJson(path.join(projectDir(project.id), 'project.json'), project);
  return project;
}

function updateProject(id, updates) {
  const project = loadProject(id);
  Object.assign(project, updates, { updatedAt: new Date().toISOString() });
  return saveProject(project);
}

function filePath(id, name) {
  return path.join(projectDir(id), name);
}

function listProjects() {
  if (!fs.existsSync(NEWS_DIR)) return [];
  return fs.readdirSync(NEWS_DIR)
    .filter(name => ID_RE.test(name))
    .map(id => readJson(path.join(NEWS_DIR, id, 'project.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getProjectDetails(id) {
  const project = loadProject(id);
  return {
    ...project,
    job: publicJob(id) || project.lastJob || null,
    transcript: readJson(filePath(id, 'transcript.json')),
    posters: readJson(filePath(id, 'posters.json')),
    hasPreview: fs.existsSync(filePath(id, 'preview.jpg')),
    hasVideo: fs.existsSync(filePath(id, 'news.mp4'))
  };
}

// ---------------------------------------------------------------------------
// Creating a project from an uploaded file
// ---------------------------------------------------------------------------

async function probeVideo(file) {
  const engine = requireEngine();
  const res = await runProcess(engine.ffprobe.path, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ], { timeoutMs: 2 * 60 * 1000 });
  if (res.code !== 0) throw new Error('This file could not be read as a video.');
  const data = JSON.parse(res.stdout || '{}');
  const streams = data.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = Number(data.format && data.format.duration);
  if (!video) throw new Error('This file has no video picture in it.');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not work out how long this video is.');
  return { durationSeconds: Math.round(duration * 100) / 100, width: video.width, height: video.height, hasAudio: Boolean(audio) };
}

function cleanName(name) {
  return String(name || 'Church News').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 120) || 'Church News';
}

/** Moves an uploaded temp file into a new project and starts transcribing it. */
async function createProjectFromUpload(tempPath, originalName) {
  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(NEWS_DIR, id);
  const ext = (path.extname(originalName || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.mp4'])[0];
  const videoFile = `source${ext}`;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, videoFile);
  try {
    fs.renameSync(tempPath, dest);
  } catch (_) {
    fs.copyFileSync(tempPath, dest);
    fs.rmSync(tempPath, { force: true });
  }

  let info;
  try {
    info = await probeVideo(dest);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw Object.assign(err, { status: 400 });
  }

  const now = new Date().toISOString();
  const project = saveProject({
    id,
    name: cleanName(originalName),
    originalName: String(originalName || '').slice(0, 255),
    videoFile,
    ...info,
    createdAt: now,
    updatedAt: now,
    studio: { ...defaultStudio(), format: info.width > info.height ? 'landscape' : 'portrait' },
    lastJob: null
  });

  if (info.hasAudio) startJob(id, 'transcribe');
  return project;
}

function deleteProject(id) {
  cancelJob(id);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Weekly background pictures (downloaded from a Google Drive folder)
// ---------------------------------------------------------------------------

const MAX_BACKGROUND_IMAGES = 40;
const POSTER_NAME_RE = /^poster/i;

// Replaces the project's background pictures with the ones in a Drive folder.
// Each picture is shrunk to 1280px so rendering stays light on a small PC.
// Files whose name starts with "poster" go on the poster screen; the rest
// scroll past on the photo screen.
async function importBackgroundFromDrive(id, tokens, folderUrl, { onProgress, signal } = {}) {
  const drive = require('./driveService');
  const sharp = require('sharp');
  loadProject(id);
  const folder = await drive.validateFolder(tokens, folderUrl);
  const children = await drive.listFolderChildren(tokens, folder.folderId, " and mimeType contains 'image/'", 'id, name, mimeType, size, md5Checksum');
  const images = children
    .filter(f => /^image\/(jpeg|png|webp)$/.test(f.mimeType))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, MAX_BACKGROUND_IMAGES);
  if (!images.length) throw Object.assign(new Error(`No JPG, PNG or WEBP pictures were found in "${folder.folderName}".`), { status: 400 });

  const dir = filePath(id, 'bg');
  const tmpDir = filePath(id, 'bg.new');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const saved = [];
  try {
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (onProgress) onProgress(i, images.length, img.name);
      const raw = path.join(tmpDir, `raw-${i}`);
      await drive.downloadFileToDisk(tokens, { id: img.id, size: img.size != null ? Number(img.size) : null, md5Checksum: img.md5Checksum || null }, raw, { signal });
      const file = `${String(i + 1).padStart(2, '0')}.jpg`;
      await sharp(raw, { failOn: 'none' }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(tmpDir, file));
      fs.rmSync(raw, { force: true });
      saved.push({ file, name: img.name, kind: POSTER_NAME_RE.test(img.name) ? 'poster' : 'photo' });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmpDir, dir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
  updateProject(id, { background: { folderName: folder.folderName, images: saved, importedAt: new Date().toISOString() } });
  return loadProject(id).background;
}

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

function detectPosters(id) {
  const transcript = readJson(filePath(id, 'transcript.json'));
  if (!transcript) throw Object.assign(new Error('Transcribe the video first.'), { status: 400 });
  const result = suggestPosters(transcript.segments);
  const posters = { ...result, detectedAt: new Date().toISOString(), edited: false };
  writeJson(filePath(id, 'posters.json'), posters);
  return posters;
}

const POSTER_TEXT_LIMIT = 2000;

function sanitizePoster(p, i) {
  const text = v => (typeof v === 'string' ? v.slice(0, POSTER_TEXT_LIMIT) : null);
  const lines = Array.isArray(p.posterText && p.posterText.lines) ? p.posterText.lines : [];
  const title = text(p.title) || 'Untitled poster';
  return {
    id: /^[\w-]{1,20}$/.test(p.id) ? p.id : `p${i + 1}`,
    title,
    when: text(p.when),
    venue: text(p.venue),
    audience: text(p.audience),
    cost: text(p.cost),
    contact: text(p.contact),
    confidence: ['high', 'medium', 'manual'].includes(p.confidence) ? p.confidence : 'manual',
    checks: Array.isArray(p.checks) ? p.checks.map(text).filter(Boolean).slice(0, 10) : [],
    posterText: {
      headline: text(p.posterText && p.posterText.headline) || title.toUpperCase(),
      lines: lines.map(text).filter(l => l && l.trim()).slice(0, 20)
    },
    notes: text(p.notes),
    quote: text(p.quote),
    start: Number.isFinite(p.start) ? p.start : null,
    done: Boolean(p.done)
  };
}

function savePosters(id, posters) {
  loadProject(id);
  const existing = readJson(filePath(id, 'posters.json'), { otherAnnouncements: [] });
  const list = (Array.isArray(posters) ? posters : []).slice(0, 100).map(sanitizePoster);
  const saved = { ...existing, posters: list, edited: true, savedAt: new Date().toISOString() };
  writeJson(filePath(id, 'posters.json'), saved);
  return saved;
}

// ---------------------------------------------------------------------------
// Transcript exports
// ---------------------------------------------------------------------------

function clock(seconds, { srt = false } = {}) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return srt ? `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}` : `${h ? `${h}:` : ''}${pad(m)}:${pad(s)}`;
}

function transcriptAsText(id) {
  const t = readJson(filePath(id, 'transcript.json'));
  if (!t) return null;
  return t.segments.map(s => `[${clock(s.start)}] ${s.text}`).join('\r\n') + '\r\n';
}

function transcriptAsSrt(id) {
  const t = readJson(filePath(id, 'transcript.json'));
  if (!t) return null;
  return t.segments.map((s, i) => `${i + 1}\r\n${clock(s.start, { srt: true })} --> ${clock(s.end, { srt: true })}\r\n${s.text}\r\n`).join('\r\n');
}

function postersAsText(id) {
  const p = readJson(filePath(id, 'posters.json'));
  if (!p) return null;
  const blocks = p.posters.map((poster, i) => [
    `POSTER ${i + 1}: ${poster.posterText.headline}`,
    ...poster.posterText.lines.map(l => `  ${l}`),
    ...(poster.checks || []).map(c => `  ! ${c}`),
    poster.quote ? `  Said at ${clock(poster.start || 0)}: "${poster.quote}"` : null
  ].filter(Boolean).join('\r\n'));
  return `${blocks.join('\r\n\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Studio settings
// ---------------------------------------------------------------------------

function defaultStudio() {
  const s = getSettings();
  return {
    format: 'portrait',
    network: s.newsNetworkName || 'Church News',
    useLogo: true,
    headline: 'Church News',
    mainHeadlines: [],
    headlinesSuggested: false,
    name: '',
    role: '',
    nameMode: 'always',
    tickerLabel: 'Church News',
    tickerHeadlines: [],
    keyThreshold: 60,
    anchorZoom: 1,
    anchorOffsetX: 0,
    anchorOffsetY: 0,
    showLive: false,
    clock: ''
  };
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeHeadlines(list) {
  return list
    .filter(h => h && typeof h.text === 'string' && h.text.trim())
    .slice(0, 50)
    .map(h => ({
      text: h.text.trim().slice(0, 90),
      start: clampNumber(h.start, 0, 24 * 3600, 0),
      quote: typeof h.quote === 'string' ? h.quote.slice(0, 600) : null,
      confirmed: Boolean(h.confirmed)
    }))
    .sort((a, b) => a.start - b.start);
}

function sanitizeStudio(input = {}, base = defaultStudio()) {
  const str = (v, max, fallback) => (typeof v === 'string' ? v.slice(0, max) : fallback);
  return {
    format: ['portrait', 'landscape'].includes(input.format) ? input.format : (base.format || 'portrait'),
    network: str(input.network, 60, base.network),
    useLogo: input.useLogo === undefined ? base.useLogo : Boolean(input.useLogo),
    headline: str(input.headline, 40, base.headline),
    mainHeadlines: Array.isArray(input.mainHeadlines)
      ? sanitizeHeadlines(input.mainHeadlines)
      : (base.mainHeadlines || []),
    headlinesSuggested: input.headlinesSuggested === undefined ? Boolean(base.headlinesSuggested) : Boolean(input.headlinesSuggested),
    name: str(input.name, 60, base.name),
    role: str(input.role, 80, base.role),
    nameMode: ['always', 'start'].includes(input.nameMode) ? input.nameMode : (base.nameMode || 'always'),
    tickerLabel: str(input.tickerLabel, 30, base.tickerLabel),
    tickerHeadlines: Array.isArray(input.tickerHeadlines)
      ? input.tickerHeadlines.map(h => String(h).slice(0, 160).trim()).filter(Boolean).slice(0, 30)
      : base.tickerHeadlines,
    keyThreshold: clampNumber(input.keyThreshold, 10, 200, base.keyThreshold),
    anchorZoom: clampNumber(input.anchorZoom, 0.3, 3, base.anchorZoom),
    anchorOffsetX: clampNumber(input.anchorOffsetX, -1, 1, base.anchorOffsetX),
    anchorOffsetY: clampNumber(input.anchorOffsetY, -1, 1, base.anchorOffsetY),
    showLive: input.showLive === undefined ? base.showLive : Boolean(input.showLive),
    clock: str(input.clock, 12, base.clock)
  };
}

/** Headline suggestions from the project's current (possibly edited) posters. */
function suggestProjectHeadlines(id) {
  loadProject(id);
  const posters = readJson(filePath(id, 'posters.json'));
  return suggestHeadlines(posters ? posters.posters : []);
}

/**
 * After a transcription, pre-fill the studio's headlines so they are ready to
 * check, but never overwrite headlines someone has already typed or confirmed.
 */
function prefillHeadlines(id) {
  const project = loadProject(id);
  const studio = project.studio || defaultStudio();
  if (studio.mainHeadlines && studio.mainHeadlines.length) return;
  const suggested = suggestProjectHeadlines(id);
  updateProject(id, {
    studio: sanitizeStudio({
      ...studio,
      mainHeadlines: suggested.mainHeadlines,
      tickerHeadlines: studio.tickerHeadlines && studio.tickerHeadlines.length ? studio.tickerHeadlines : suggested.tickerHeadlines,
      headlinesSuggested: true
    }, studio)
  });
}

function saveStudio(id, input) {
  const project = loadProject(id);
  const studio = sanitizeStudio(input, project.studio || defaultStudio());
  updateProject(id, { studio });
  return studio;
}

/** Turns a project's studio settings into the NewsBroadcast composition props. */
function studioProps(project, mediaBase) {
  const studio = project.studio || defaultStudio();
  const posters = readJson(filePath(project.id, 'posters.json'));
  let ticker = studio.tickerHeadlines;
  if (!ticker.length && posters && posters.posters.length) {
    ticker = posters.posters.map(p => [p.title, p.when].filter(Boolean).join(' · '));
  }
  if (!ticker.length) ticker = ['Welcome to this week\'s church news'];
  const logoExists = fs.existsSync(require('../config').getLogoPath());
  const mainHeadlines = (studio.mainHeadlines && studio.mainHeadlines.length
    ? studio.mainHeadlines
    : suggestHeadlines(posters ? posters.posters : []).mainHeadlines
  ).map(h => ({ text: h.text, start: h.start }));

  const bgImages = (project.background && project.background.images) || [];
  const bgUrl = img => `${mediaBase}/news-media/${project.id}/bg/${img.file}`;
  const posterStarts = ((posters && posters.posters) || []).map(p => (Number.isFinite(p.start) ? p.start : 0)).sort((a, b) => a - b);
  const posterImages = bgImages.filter(i => i.kind === 'poster');

  return {
    format: studio.format || 'portrait',
    photos: bgImages.filter(i => i.kind === 'photo').map(bgUrl),
    // Poster pictures are matched in order to the announcements found in the
    // speech; the first one is also shown before the first announcement.
    posterScreen: posterImages.map((img, i) => ({ src: bgUrl(img), start: i === 0 ? 0 : (posterStarts[i] ?? posterStarts[posterStarts.length - 1] ?? 0) })),
    mainHeadlines,
    nameMode: studio.nameMode || 'always',
    videoSrc: `${mediaBase}/news-media/${project.id}/${project.videoFile}`,
    durationInSeconds: project.durationSeconds,
    chromaKey: { threshold: studio.keyThreshold, softness: 28, spillSuppression: 0.9, minBrightness: 24, edgeBlur: 1.5 },
    anchorZoom: studio.anchorZoom,
    anchorOffsetX: studio.anchorOffsetX,
    anchorOffsetY: studio.anchorOffsetY,
    palette: { deep: '#050b1a', mid: '#12294f', glow: '#2f6fb8', accent: '#5aa3e8' },
    network: studio.network || 'Church News',
    logoSrc: studio.useLogo && logoExists ? `${mediaBase}/news-media/logo.png?v=${Date.now()}` : undefined,
    showLive: studio.showLive,
    clock: studio.clock,
    headline: studio.headline || 'Church News',
    name: studio.name || ' ',
    role: studio.role || ' ',
    tickerLabel: studio.tickerLabel || 'Church News',
    tickerHeadlines: ticker,
    tickerSpeed: 90,
    lowerThirdStart: 20
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// Two lanes so a quick preview never waits behind a long transcription, while
// never running two heavy jobs of the same kind at once on a small computer.
const LANES = { transcribe: 'speech', preview: 'studio', render: 'studio' };
const jobs = new Map(); // projectId -> job
const laneQueues = { speech: [], studio: [] };
const laneBusy = { speech: false, studio: false };

function publicJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { controller, ...rest } = job;
  return rest;
}

function persistJob(job) {
  try {
    updateProject(job.projectId, { lastJob: publicJob(job.projectId) });
  } catch (_) { /* project deleted */ }
}

function startJob(id, type, options = {}) {
  loadProject(id);
  const current = jobs.get(id);
  if (current && !current.done) {
    throw Object.assign(new Error('This project is already busy. Wait for it to finish or cancel it first.'), { status: 409 });
  }
  const job = {
    projectId: id,
    type,
    options,
    stage: 'queued',
    fraction: 0,
    detail: null,
    error: null,
    done: false,
    cancelled: false,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    controller: new AbortController()
  };
  jobs.set(id, job);
  persistJob(job);
  const lane = LANES[type];
  laneQueues[lane].push(job);
  pump(lane);
  return publicJob(id);
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.cancelled = true;
  job.controller.abort();
  for (const lane of Object.keys(laneQueues)) {
    const i = laneQueues[lane].indexOf(job);
    if (i >= 0) {
      laneQueues[lane].splice(i, 1);
      finish(job, { error: 'Cancelled.' });
    }
  }
  return true;
}

function finish(job, { error = null } = {}) {
  job.done = true;
  job.error = error;
  job.finishedAt = new Date().toISOString();
  if (!error) job.fraction = 1;
  job.stage = error ? (job.cancelled ? 'cancelled' : 'failed') : 'complete';
  persistJob(job);
}

async function pump(lane) {
  if (laneBusy[lane]) return;
  const job = laneQueues[lane].shift();
  if (!job) return;
  laneBusy[lane] = true;
  job.startedAt = new Date().toISOString();
  job.stage = 'starting';
  let lastSave = 0;
  const onProgress = p => {
    Object.assign(job, { stage: p.stage || job.stage, fraction: Number.isFinite(p.fraction) ? p.fraction : job.fraction, detail: p });
    if (Date.now() - lastSave > 3000) {
      lastSave = Date.now();
      persistJob(job);
    }
  };

  try {
    await RUNNERS[job.type](job, onProgress);
    finish(job, { error: job.cancelled ? 'Cancelled.' : null });
  } catch (err) {
    if (job.cancelled || err.name === 'AbortError') finish(job, { error: 'Cancelled.' });
    else {
      console.error(`News ${job.type} failed for ${job.projectId}:`, err.message);
      finish(job, { error: err.message || String(err) });
    }
  } finally {
    laneBusy[lane] = false;
    pump(lane);
  }
}

const RUNNERS = {
  async transcribe(job, onProgress) {
    const id = job.projectId;
    const project = loadProject(id);
    const transcript = await transcribeVideo(filePath(id, project.videoFile), projectDir(id), {
      signal: job.controller.signal,
      onProgress
    });
    if (job.cancelled) return;
    writeJson(filePath(id, 'transcript.json'), { ...transcript, createdAt: new Date().toISOString() });
    onProgress({ stage: 'finding-posters', fraction: 1 });
    detectPosters(id);
    prefillHeadlines(id);
  },

  async preview(job, onProgress) {
    const id = job.projectId;
    const project = loadProject(id);
    const out = filePath(id, 'preview.jpg');
    const tmp = filePath(id, 'preview.tmp.jpg');
    await renderPreviewFrame(studioProps(project, job.options.mediaBase), tmp, {
      atSeconds: Math.min(project.durationSeconds / 2, 3),
      onProgress
    });
    fs.renameSync(tmp, out);
  },

  async render(job, onProgress) {
    const id = job.projectId;
    const project = loadProject(id);
    await renderNewsVideo(studioProps(project, job.options.mediaBase), filePath(id, 'news.mp4'), {
      signal: job.controller.signal,
      onProgress
    });
  }
};

/** Jobs that were running when the server stopped are marked as interrupted. */
function markInterruptedJobs() {
  for (const project of listProjects()) {
    if (project.lastJob && !project.lastJob.done) {
      project.lastJob = { ...project.lastJob, done: true, stage: 'failed', error: 'The app was closed or restarted while this was running. Start it again.' };
      try { saveProject(project); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  NEWS_DIR,
  listProjects,
  loadProject,
  getProjectDetails,
  createProjectFromUpload,
  importBackgroundFromDrive,
  deleteProject,
  updateProject,
  filePath,
  detectPosters,
  savePosters,
  saveStudio,
  sanitizeStudio,
  suggestProjectHeadlines,
  studioProps,
  startJob,
  cancelJob,
  transcriptAsText,
  transcriptAsSrt,
  postersAsText,
  markInterruptedJobs
};
