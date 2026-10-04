// Church News transcription: extracts the audio track with FFmpeg and runs
// OpenAI's Whisper speech-recognition model locally on this computer through
// Transformers.js (ONNX Runtime). Nothing is sent to an online service; the
// model is downloaded from Hugging Face once and cached under uploads/models.
//
// Audio is transcribed in blocks of about two minutes, each cut at the
// quietest moment near the block boundary so no word is split in half. That
// keeps memory flat for long recordings and gives real progress updates.

const fs = require('fs');
const path = require('path');
const { getSettings } = require('../config');
const { requireEngine, runProcess } = require('./videoService');

const SAMPLE_RATE = 16000; // Whisper expects 16 kHz mono
const BLOCK_SECONDS = 120;
const SPLIT_SEARCH_SECONDS = 6; // look this far either side of a boundary for a pause
const FRAME_SECONDS = 0.05; // loudness is measured in 50 ms frames
const MODELS_DIR = path.join(__dirname, '../../uploads/models');

const MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small'
};

const LANGUAGES = ['auto', 'english', 'afrikaans', 'zulu', 'xhosa', 'sotho', 'tswana', 'french', 'portuguese', 'swahili'];

function getTranscriptionSettings(overrides = {}) {
  const s = { ...getSettings(), ...overrides };
  const language = LANGUAGES.includes(s.newsLanguage) ? s.newsLanguage : 'english';
  return {
    model: MODELS[s.newsWhisperModel] ? s.newsWhisperModel : 'base',
    language,
    // Whisper can write speech in another language directly in English.
    translate: s.newsTranslateToEnglish === true && language !== 'english'
  };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function extractAudio(videoPath, rawPath, { signal } = {}) {
  const engine = requireEngine();
  const res = await runProcess(engine.ffmpeg.path, [
    '-hide_banner', '-nostdin', '-y', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', rawPath
  ], { signal, stallMs: 10 * 60 * 1000 });
  if (res.code !== 0 || !fs.existsSync(rawPath)) {
    const detail = String(res.stderr || '').trim().split(/\r?\n/).slice(-5).join('\n');
    if (/does not contain any stream|Output file #0 does not contain|matches no streams/i.test(res.stderr)) {
      throw new Error('This video has no sound track, so there is nothing to transcribe.');
    }
    throw new Error(`Could not read the audio from this video.\n${detail}`);
  }
  const buf = fs.readFileSync(rawPath);
  // Copy into a fresh, aligned buffer: Buffer slices may not be 4-byte aligned.
  const samples = new Float32Array(buf.length / 4);
  new Uint8Array(samples.buffer).set(buf.subarray(0, samples.length * 4));
  return samples;
}

/**
 * Chooses where to cut the audio into blocks: every ~BLOCK_SECONDS, moved to
 * the quietest 50 ms frame within SPLIT_SEARCH_SECONDS of the nominal cut.
 * Returns [start, end) sample ranges covering the whole recording.
 */
function planBlocks(samples, { sampleRate = SAMPLE_RATE, blockSeconds = BLOCK_SECONDS, searchSeconds = SPLIT_SEARCH_SECONDS } = {}) {
  const total = samples.length;
  const blockLen = Math.round(blockSeconds * sampleRate);
  const frameLen = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const search = Math.round(searchSeconds * sampleRate);
  const blocks = [];
  let start = 0;

  while (total - start > blockLen + search) {
    const nominal = start + blockLen;
    let bestAt = nominal;
    let bestEnergy = Infinity;
    for (let f = nominal - search; f + frameLen <= nominal + search; f += frameLen) {
      let energy = 0;
      for (let i = f; i < f + frameLen; i++) energy += samples[i] * samples[i];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestAt = f + Math.floor(frameLen / 2);
      }
    }
    blocks.push([start, bestAt]);
    start = bestAt;
  }
  if (start < total) blocks.push([start, total]);
  return blocks;
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

// The encoder (which listens) stays full precision for accuracy; the decoder
// (which writes the words) uses the 8-bit build, which is about 4x smaller and
// faster on an ordinary CPU for very little loss.
const DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q8' };
const MODEL_FILES = [
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json',
  'onnx/encoder_model.onnx', 'onnx/decoder_model_merged_quantized.onnx'
];
const DOWNLOAD_ATTEMPTS = 40;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' })); }, { once: true });
  });
}

async function remoteSizes(modelId, signal) {
  const sizes = {};
  for (const dir of ['', 'onnx']) {
    const url = `https://huggingface.co/api/models/${modelId}/tree/main${dir ? '/' + dir : ''}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${url}`);
    for (const f of await res.json()) sizes[f.path] = f.size;
  }
  return sizes;
}

/**
 * Downloads one file, resuming from a .part file after every dropped
 * connection (slow or unreliable internet is common; a 100 MB file should
 * never have to start over).
 */
async function downloadResumable(url, dest, expectedSize, { signal, onBytes }) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (expectedSize && have === expectedSize) break;
    if (expectedSize && have > expectedSize) fs.rmSync(part);
    try {
      const res = await fetch(url, { signal, headers: have ? { Range: `bytes=${have}-` } : {} });
      if (res.status === 416) { fs.rmSync(part, { force: true }); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const append = have > 0 && res.status === 206;
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      let written = append ? have : 0;
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          written += chunk.length;
          onBytes(written);
        }
      } finally {
        await new Promise(r => out.end(r));
      }
      if (!expectedSize || written === expectedSize) break;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      await sleep(Math.min(30000, 1000 * attempt), signal);
    }
  }
  const size = fs.existsSync(part) ? fs.statSync(part).size : -1;
  if (expectedSize && size !== expectedSize) {
    throw new Error(`Download kept failing for ${path.basename(dest)}${lastError ? ` (${lastError.message})` : ''}.`);
  }
  fs.renameSync(part, dest);
}

async function ensureModelDownloaded(modelKey, { signal, onStatus = () => {} } = {}) {
  const modelId = MODELS[modelKey];
  const modelDir = path.join(MODELS_DIR, ...modelId.split('/'));
  const marker = path.join(modelDir, '.complete');
  if (fs.existsSync(marker)) return;

  const sizes = await remoteSizes(modelId, signal);
  const files = MODEL_FILES.filter(f => sizes[f] !== undefined);
  const totalBytes = files.reduce((sum, f) => sum + sizes[f], 0);
  const done = {};
  const report = () => onStatus({
    stage: 'downloading-model',
    loadedBytes: Object.values(done).reduce((a, b) => a + b, 0),
    totalBytes
  });

  for (const file of files) {
    const dest = path.join(modelDir, ...file.split('/'));
    if (fs.existsSync(dest) && fs.statSync(dest).size === sizes[file]) {
      done[file] = sizes[file];
      continue;
    }
    await downloadResumable(`https://huggingface.co/${modelId}/resolve/main/${file}`, dest, sizes[file], {
      signal,
      onBytes: n => { done[file] = n; report(); }
    });
    done[file] = sizes[file];
    report();
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

const pipelines = new Map();

async function loadRecognizer(modelKey, { signal, onStatus } = {}) {
  if (pipelines.has(modelKey)) return pipelines.get(modelKey);
  try {
    await ensureModelDownloaded(modelKey, { signal, onStatus });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`Could not download the Whisper speech model (${MODELS[modelKey]}). This one-time download needs an internet connection; try again and it will continue where it stopped.\n${err.message}`);
  }

  const { pipeline, env } = await import('@huggingface/transformers');
  env.localModelPath = MODELS_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

  const promise = pipeline('automatic-speech-recognition', MODELS[modelKey], { dtype: DTYPE, device: 'cpu' });
  pipelines.set(modelKey, promise);
  try {
    return await promise;
  } catch (err) {
    pipelines.delete(modelKey);
    throw new Error(`Could not load the Whisper speech model (${MODELS[modelKey]}).\n${err.message}`);
  }
}

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Transcribes a video file. Returns { text, segments: [{ start, end, text }],
 * durationSeconds, model, language }. Times are in seconds.
 *
 * onProgress receives { stage, fraction, ... } updates:
 *   extracting-audio → downloading-model → transcribing (fraction 0..1)
 */
async function transcribeVideo(videoPath, workDir, { signal, onProgress = () => {}, overrides } = {}) {
  const settings = getTranscriptionSettings(overrides);
  const rawPath = path.join(workDir, 'audio.f32');

  onProgress({ stage: 'extracting-audio', fraction: 0 });
  let samples;
  try {
    samples = await extractAudio(videoPath, rawPath, { signal });
  } finally {
    fs.rm(rawPath, { force: true }, () => {});
  }
  const durationSeconds = samples.length / SAMPLE_RATE;
  if (durationSeconds < 1) throw new Error('The sound track is too short to transcribe.');

  const recognizer = await loadRecognizer(settings.model, {
    signal,
    onStatus: status => onProgress({ ...status, fraction: 0 })
  });
  const blocks = planBlocks(samples);
  const segments = [];
  const startedAt = Date.now();

  for (let b = 0; b < blocks.length; b++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' });
    const [from, to] = blocks[b];
    const offset = from / SAMPLE_RATE;
    const blockEnd = to / SAMPLE_RATE;
    onProgress({
      stage: 'transcribing',
      fraction: from / samples.length,
      block: b + 1,
      blocks: blocks.length,
      elapsedSeconds: (Date.now() - startedAt) / 1000
    });

    const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: settings.translate ? 'translate' : 'transcribe' };
    if (settings.language !== 'auto') options.language = settings.language;
    const out = await recognizer(samples.subarray(from, to), options);

    for (const chunk of out.chunks || [{ timestamp: [0, blockEnd - offset], text: out.text }]) {
      const text = tidy(chunk.text);
      if (!text) continue;
      const [s, e] = chunk.timestamp || [];
      const start = offset + (Number.isFinite(s) ? s : 0);
      const end = Math.min(blockEnd, offset + (Number.isFinite(e) ? e : blockEnd - offset));
      segments.push({ start: round2(start), end: round2(Math.max(start, end)), text });
    }
  }

  onProgress({ stage: 'transcribing', fraction: 1, blocks: blocks.length, block: blocks.length });
  return {
    text: segments.map(s => s.text).join(' '),
    segments,
    durationSeconds: round2(durationSeconds),
    model: MODELS[settings.model],
    language: settings.language,
    translatedToEnglish: settings.translate
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  transcribeVideo,
  planBlocks,
  getTranscriptionSettings,
  MODELS,
  LANGUAGES,
  SAMPLE_RATE
};
