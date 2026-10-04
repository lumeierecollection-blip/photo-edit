// Video Converter engine: inspects videos with FFprobe, decides per stream
// whether it can be copied into MP4 untouched (remux) or must be re-encoded,
// runs FFmpeg, and validates the result before anything is uploaded.
//
// FFmpeg/FFprobe are always launched with argument arrays (never a shell), and
// only ever see file paths the application generated itself.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { getSettings } = require('../config');

const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const STALL_TIMEOUT_MS = 15 * 60 * 1000; // no FFmpeg progress for this long = hung
const STDERR_TAIL_LINES = 25;

const COPYABLE_VIDEO_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
const COPYABLE_HEVC_PIX_FMTS = new Set(['yuv420p', 'yuvj420p', 'yuv420p10le']);
const COPYABLE_AUDIO_CODECS = new Set(['aac', 'mp3']);
const MP4_SAMPLE_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000]);
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'sami']);
const HDR_TRANSFERS = { smpte2084: 'HDR10 (PQ)', 'arib-std-b67': 'HLG' };
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

// ---------------------------------------------------------------------------
// Engine discovery
// ---------------------------------------------------------------------------

let engineCache = null;

function tryBinary(bin) {
  if (!bin) return null;
  try {
    const res = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (res.status === 0 && /version/i.test(res.stdout)) {
      return { path: bin, version: res.stdout.split('\n')[0].trim() };
    }
  } catch (_) { /* not usable */ }
  return null;
}

function optionalPackagePath(name) {
  try {
    const mod = require(name);
    return typeof mod === 'string' ? mod : mod && mod.path;
  } catch (_) {
    return null;
  }
}

function listFromHelp(bin, flag) {
  const res = spawnSync(bin, ['-hide_banner', flag], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return res.stdout || '';
}

// Order: explicit env var → system install on PATH → bundled npm package.
function getEngine({ refresh = false } = {}) {
  if (engineCache && !refresh) return engineCache;

  const ffmpeg = tryBinary(process.env.FFMPEG_PATH) || tryBinary('ffmpeg') || tryBinary(optionalPackagePath('ffmpeg-static'));
  const ffprobe = tryBinary(process.env.FFPROBE_PATH) || tryBinary('ffprobe') || tryBinary(optionalPackagePath('ffprobe-static'));

  const engine = { available: Boolean(ffmpeg && ffprobe), ffmpeg, ffprobe, encoders: {}, filters: {} };
  if (ffmpeg) {
    const encoders = listFromHelp(ffmpeg.path, '-encoders');
    const filters = listFromHelp(ffmpeg.path, '-filters');
    const has = (text, name) => new RegExp(`\\s${name}\\s`).test(text);
    engine.encoders = { libx264: has(encoders, 'libx264'), libx265: has(encoders, 'libx265'), aac: has(encoders, 'aac') };
    engine.filters = {
      zscale: has(filters, 'zscale'), tonemap: has(filters, 'tonemap'),
      bwdif: has(filters, 'bwdif'), yadif: has(filters, 'yadif'), pad: has(filters, 'pad')
    };
    if (!engine.encoders.libx264 || !engine.encoders.aac) engine.available = false;
  }
  engineCache = engine;
  return engine;
}

function requireEngine() {
  const engine = getEngine();
  if (!engine.available) {
    throw new Error('The video engine (FFmpeg with libx264/AAC and FFprobe) is not installed on the server.');
  }
  return engine;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function getVideoSettings(overrides = {}) {
  const s = { ...getSettings(), ...overrides };
  const cpus = os.cpus().length || 1;
  const memGb = os.totalmem() / 1024 ** 3;
  const autoEncodes = cpus >= 16 && memGb >= 16 ? 2 : 1;
  const autoFiles = memGb >= 4 ? 2 : 1;
  return {
    // A pasted link here would end up in every output folder's name.
    outputFolderSuffix: typeof s.videoOutputFolderSuffix === 'string' && s.videoOutputFolderSuffix.trim()
      && s.videoOutputFolderSuffix.length <= 60 && !/https?:\/\/|drive\.google\.com/i.test(s.videoOutputFolderSuffix)
      ? s.videoOutputFolderSuffix : ' — MP4 Converted',
    codec: s.videoCodec === 'hevc' ? 'hevc' : 'h264',
    crf: clampInt(s.videoCrf, 0, 51, 18),
    preset: PRESETS.includes(s.videoPreset) ? s.videoPreset : 'medium',
    audioBitrateKbps: clampInt(s.videoAudioBitrateKbps, 96, 512, 256),
    keepHevc: Boolean(s.videoKeepHevc),
    preserveMetadata: s.videoPreserveMetadata !== false,
    maxConcurrentFiles: clampInt(s.videoMaxConcurrentFiles, 0, 8, 0) || autoFiles,
    maxConcurrentEncodes: clampInt(s.videoMaxConcurrentEncodes, 0, 4, 0) || autoEncodes,
    retryCount: clampInt(s.videoRetryCount, 0, 10, 5),
    fullDecodeCheck: Boolean(s.videoFullDecodeCheck)
  };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runProcess(bin, args, { signal, timeoutMs, stallMs, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' }));

    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let killedReason = null;
    let stallTimer = null;

    const kill = reason => {
      if (killedReason) return;
      killedReason = reason;
      child.kill('SIGKILL');
    };
    const armStall = () => {
      if (!stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => kill('stalled'), stallMs);
    };
    const timeout = timeoutMs ? setTimeout(() => kill('timeout'), timeoutMs) : null;
    const onAbort = () => kill('aborted');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    armStall();

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      armStall();
      if (!onStdoutLine) {
        stdout += text;
        return;
      }
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      lines.forEach(onStdoutLine);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on('error', err => {
      cleanup();
      reject(err);
    });
    child.on('close', code => {
      cleanup();
      if (killedReason === 'aborted') {
        return reject(Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' }));
      }
      if (killedReason) {
        return reject(Object.assign(new Error(`Process ${killedReason === 'stalled' ? 'stopped responding' : 'timed out'}.`), { stderrTail: tail(stderr) }));
      }
      resolve({ code, stdout, stderr });
    });

    function cleanup() {
      clearTimeout(timeout);
      clearTimeout(stallTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  });
}

function tail(text, lines = STDERR_TAIL_LINES) {
  return String(text || '').trim().split(/\r?\n/).slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function probe(filePath, { signal } = {}) {
  const engine = requireEngine();
  const res = await runProcess(engine.ffprobe.path, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath
  ], { signal, timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code !== 0) {
    const err = new Error(`FFprobe could not read this file: ${tail(res.stderr, 3) || 'unknown error'}`);
    err.stderrTail = tail(res.stderr);
    throw err;
  }
  try {
    return JSON.parse(res.stdout);
  } catch (_) {
    throw new Error('FFprobe returned unreadable media information.');
  }
}

function parseRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return fps > 0 && fps < 1000 ? fps : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rotationOf(stream) {
  const matrix = (stream.side_data_list || []).find(d => d.rotation != null);
  let rotation = matrix ? Number(matrix.rotation) : Number((stream.tags || {}).rotate || 0);
  if (!Number.isFinite(rotation)) rotation = 0;
  return ((Math.round(rotation) % 360) + 360) % 360;
}

function orientationOf(width, height) {
  if (!width || !height) return 'unknown';
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

// Turns raw FFprobe output into the facts the planner and reports need.
function analyze(probeData) {
  const streams = probeData.streams || [];
  const format = probeData.format || {};
  const videoStreams = streams.filter(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const coverArt = streams.filter(s => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
  const v = videoStreams[0] || null;

  let video = null;
  if (v) {
    const rotation = rotationOf(v);
    const swap = rotation === 90 || rotation === 270;
    const width = v.width || null;
    const height = v.height || null;
    const displayWidth = swap ? height : width;
    const displayHeight = swap ? width : height;
    video = {
      index: v.index,
      codec: v.codec_name || 'unknown',
      profile: v.profile || null,
      pixFmt: v.pix_fmt || null,
      width,
      height,
      displayWidth,
      displayHeight,
      rotation,
      orientation: orientationOf(displayWidth, displayHeight),
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
      bitrate: toNumber(v.bit_rate),
      interlaced: ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
      colorTransfer: v.color_transfer || null,
      hdr: HDR_TRANSFERS[v.color_transfer]
        || ((v.side_data_list || []).some(d => /DOVI/i.test(d.side_data_type || '')) ? 'Dolby Vision' : null),
      tagString: v.codec_tag_string || null
    };
  }

  const audio = streams.filter(s => s.codec_type === 'audio').map(a => ({
    index: a.index,
    codec: a.codec_name || 'unknown',
    profile: a.profile || null,
    channels: a.channels || 0,
    channelLayout: a.channel_layout || null,
    sampleRate: toNumber(a.sample_rate),
    bitrate: toNumber(a.bit_rate),
    language: (a.tags || {}).language || null
  }));

  const subtitles = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
    index: s.index, codec: s.codec_name || 'unknown', language: (s.tags || {}).language || null
  }));

  return {
    container: format.format_name || 'unknown',
    containerLongName: format.format_long_name || null,
    duration: toNumber(format.duration) || (v && toNumber(v.duration)) || null,
    size: toNumber(format.size),
    bitrate: toNumber(format.bit_rate),
    majorBrand: (format.tags || {}).major_brand || null,
    metadataKeys: Object.keys(format.tags || {}),
    video,
    extraVideoStreams: videoStreams.slice(1).map(s => ({ index: s.index, codec: s.codec_name })),
    coverArt: coverArt.map(s => ({ index: s.index, codec: s.codec_name })),
    audio,
    subtitles,
    dataStreams: streams.filter(s => s.codec_type === 'data').map(s => ({ index: s.index, codec: s.codec_name || (s.tags || {}).handler_name || 'data' })),
    attachments: streams.filter(s => s.codec_type === 'attachment').length,
    chapters: (probeData.chapters || []).length
  };
}

// Short, human-readable description used in reports and the UI.
function summarize(info) {
  if (!info) return null;
  const v = info.video;
  return {
    duration: info.duration,
    resolution: v ? `${v.displayWidth} × ${v.displayHeight}` : null,
    fps: v && v.fps ? Math.round(v.fps * 100) / 100 : null,
    videoCodec: v ? v.codec : null,
    audioCodecs: info.audio.map(a => a.codec),
    audioTracks: info.audio.length,
    subtitles: info.subtitles.length,
    orientation: v ? v.orientation : null,
    rotation: v ? v.rotation : 0,
    pixFmt: v ? v.pixFmt : null,
    hdr: v ? v.hdr : null,
    size: info.size,
    container: info.container
  };
}

// ---------------------------------------------------------------------------
// Planning: remux when safe, re-encode only what is necessary.
// ---------------------------------------------------------------------------

function audioBitrateFor(channels, settings) {
  const perChannel = settings.audioBitrateKbps / 2;
  return Math.round(Math.min(640, Math.max(96, perChannel * Math.max(1, channels))));
}

function planConversion(info, settings, { safeMode = false } = {}) {
  if (!info.video) {
    if (!info.audio.length) {
      throw new Error('No readable video or audio streams were found; the file is corrupt, incomplete, or in an unsupported format.');
    }
    const err = new Error('This file contains no video stream (it is audio-only).');
    err.skip = true;
    throw err;
  }
  const engine = getEngine();
  const v = info.video;
  const notes = [];
  const warnings = [];

  // --- Video --------------------------------------------------------------
  const oddDims = (v.width % 2) || (v.height % 2);
  let videoPlan;
  const canCopyH264 = v.codec === 'h264' && COPYABLE_VIDEO_PIX_FMTS.has(v.pixFmt);
  const canCopyHevc = v.codec === 'hevc' && (settings.keepHevc || settings.codec === 'hevc') && COPYABLE_HEVC_PIX_FMTS.has(v.pixFmt);

  if (!safeMode && (canCopyH264 || canCopyHevc)) {
    videoPlan = { action: 'copy', codec: v.codec, tag: v.codec === 'hevc' ? 'hvc1' : 'avc1' };
  } else {
    const useHevc = settings.codec === 'hevc' && engine.encoders.libx265;
    const tenBit = useHevc && /10/.test(v.pixFmt || '');
    const filters = [];
    let reason;
    if (safeMode) reason = 'Re-encoded in compatibility mode after the direct copy did not produce a valid MP4';
    else if (v.codec === 'h264') reason = `H.264 with ${v.pixFmt || 'unknown'} pixels is not widely playable; converted to standard 8-bit 4:2:0`;
    else if (v.codec === 'hevc') reason = 'H.265/HEVC is not universally playable (e.g. many Windows PCs and browsers); converted to H.264';
    else reason = `${v.codec.toUpperCase()} video cannot be stored in a broadly compatible MP4; converted to ${useHevc ? 'H.265' : 'H.264'}`;

    if (v.interlaced) {
      const deint = engine.filters.bwdif ? 'bwdif' : (engine.filters.yadif ? 'yadif' : null);
      if (deint) {
        filters.push(`${deint}=mode=send_frame`);
        notes.push('Interlaced source was deinterlaced (same frame rate) for smooth playback on modern screens.');
      }
    }
    if (v.hdr && !tenBit) {
      if (engine.filters.zscale && engine.filters.tonemap) {
        filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
        notes.push(`${v.hdr} video was tone-mapped to standard dynamic range so colours look right on all devices.`);
      } else {
        warnings.push(`${v.hdr} source converted without tone-mapping (FFmpeg build lacks zscale); colours may look washed out.`);
      }
    }
    if (oddDims) {
      filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
      notes.push('Source has an odd pixel dimension; one pixel row/column of padding was added (required by H.264).');
    }
    filters.push(`format=${tenBit ? 'yuv420p10le' : 'yuv420p'}`);
    videoPlan = {
      action: 'encode',
      encoder: useHevc ? 'libx265' : 'libx264',
      tag: useHevc ? 'hvc1' : 'avc1',
      crf: settings.crf,
      preset: settings.preset,
      filters,
      reason
    };
  }

  if (info.extraVideoStreams.length) notes.push(`${info.extraVideoStreams.length} additional video stream(s) were not carried over; only the main video was kept.`);
  if (info.coverArt.length) notes.push('Embedded cover art was not carried over.');

  // --- Audio --------------------------------------------------------------
  const audioPlans = [];
  for (const a of info.audio) {
    if (!a.channels) {
      notes.push(`Audio stream #${a.index} (${a.codec}) has no channels and was skipped as unusable.`);
      continue;
    }
    const rateOk = a.sampleRate && MP4_SAMPLE_RATES.has(a.sampleRate);
    if (!safeMode && COPYABLE_AUDIO_CODECS.has(a.codec) && rateOk) {
      audioPlans.push({ index: a.index, action: 'copy', codec: a.codec, channels: a.channels });
    } else {
      const channels = safeMode && a.channels > 6 ? 2 : Math.min(a.channels, 8);
      audioPlans.push({
        index: a.index,
        action: 'encode',
        codec: 'aac',
        channels,
        bitrateKbps: audioBitrateFor(channels, settings),
        sampleRate: a.sampleRate && a.sampleRate > 96000 ? 48000 : (a.sampleRate && a.sampleRate < 8000 ? 48000 : null),
        from: a.codec,
        downmixed: channels !== a.channels
      });
      if (channels !== a.channels) warnings.push(`Audio stream #${a.index} was downmixed from ${a.channels} to ${channels} channels for compatibility.`);
    }
  }

  // --- Subtitles, data, attachments --------------------------------------
  const subtitlePlans = [];
  for (const s of info.subtitles) {
    if (!safeMode && TEXT_SUBTITLE_CODECS.has(s.codec)) {
      subtitlePlans.push({ index: s.index, action: 'mov_text', from: s.codec });
      if (s.codec === 'ass' || s.codec === 'ssa') notes.push(`Subtitle #${s.index} kept as MP4 text; ${s.codec.toUpperCase()} styling (fonts/positions) is not supported in MP4.`);
    } else {
      notes.push(`Subtitle stream #${s.index} (${s.codec}) could not be kept: ${safeMode ? 'compatibility mode' : 'image-based subtitles are not supported in MP4'}.`);
    }
  }
  if (info.dataStreams.length) notes.push(`${info.dataStreams.length} data stream(s) (e.g. timecode/telemetry: ${info.dataStreams.map(d => d.codec).join(', ')}) were not carried over.`);
  if (info.attachments) notes.push(`${info.attachments} attachment(s) (e.g. embedded fonts) cannot be stored in MP4 and were not carried over.`);
  if (info.chapters) notes.push(`${info.chapters} chapter marker(s) preserved.`);

  const everythingCopied = videoPlan.action === 'copy' && audioPlans.every(a => a.action === 'copy');
  const strategy = everythingCopied ? 'remux' : (videoPlan.action === 'copy' ? 'remux-video' : 'encode');

  return {
    strategy,
    safeMode,
    video: videoPlan,
    audio: audioPlans,
    subtitles: subtitlePlans,
    preserveMetadata: settings.preserveMetadata,
    notes,
    warnings,
    description: describePlan(strategy, videoPlan, audioPlans)
  };
}

function describePlan(strategy, videoPlan, audioPlans) {
  if (strategy === 'remux') return 'Remux: video and audio copied unchanged into MP4 (no quality loss).';
  const encodedAudio = audioPlans.filter(a => a.action === 'encode').map(a => a.from.toUpperCase());
  if (strategy === 'remux-video') {
    return `Video copied unchanged; audio (${[...new Set(encodedAudio)].join(', ')}) converted to AAC.`;
  }
  return `Re-encode: ${videoPlan.reason}.${encodedAudio.length ? ` Audio (${[...new Set(encodedAudio)].join(', ')}) converted to AAC.` : ''}`;
}

function buildFfmpegArgs(inputPath, outputPath, plan) {
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', inputPath];

  args.push('-map', `0:${plan.videoIndex != null ? plan.videoIndex : 'v:0'}`);
  plan.audio.forEach(a => args.push('-map', `0:${a.index}`));
  plan.subtitles.forEach(s => args.push('-map', `0:${s.index}`));

  if (plan.preserveMetadata) args.push('-map_metadata', '0');
  else args.push('-map_metadata', '-1');
  args.push('-map_chapters', '0');

  const v = plan.video;
  if (v.action === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', v.encoder, '-preset', v.preset, '-crf', String(v.crf));
    if (v.encoder === 'libx264') args.push('-profile:v', /10le/.test(v.filters.join(',')) ? 'high10' : 'high');
    if (v.filters.length) args.push('-vf', v.filters.join(','));
  }
  args.push('-tag:v', v.tag);

  plan.audio.forEach((a, i) => {
    if (a.action === 'copy') {
      args.push(`-c:a:${i}`, 'copy');
    } else {
      args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, `${a.bitrateKbps}k`, `-ac:a:${i}`, String(a.channels));
      if (a.sampleRate) args.push(`-ar:a:${i}`, String(a.sampleRate));
    }
  });
  if (plan.subtitles.length) args.push('-c:s', 'mov_text');

  args.push('-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4', outputPath);
  return args;
}

async function convert(inputPath, outputPath, info, plan, { signal, onProgress } = {}) {
  const engine = requireEngine();
  const args = buildFfmpegArgs(inputPath, outputPath, { ...plan, videoIndex: info.video.index });
  const duration = info.duration;
  let lastPercent = -1;

  const res = await runProcess(engine.ffmpeg.path, args, {
    signal,
    stallMs: STALL_TIMEOUT_MS,
    onStdoutLine: line => {
      const [key, value] = line.split('=');
      if ((key === 'out_time_us' || key === 'out_time_ms') && duration && onProgress) {
        const seconds = Number(value) / 1e6;
        if (Number.isFinite(seconds)) {
          const percent = Math.max(0, Math.min(99, Math.floor((seconds / duration) * 100)));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(percent);
          }
        }
      } else if (key === 'progress' && value === 'end' && onProgress) {
        onProgress(100);
      }
    }
  });

  if (res.code !== 0) {
    const err = new Error(`FFmpeg failed (exit code ${res.code}): ${tail(res.stderr, 2) || 'no details'}`);
    err.stderrTail = tail(res.stderr);
    throw err;
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

// Walks the top-level MP4 boxes to confirm the file is structurally complete:
// starts with ftyp, has moov before mdat (fast start), and nothing is cut off.
function inspectMp4Boxes(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    const boxes = [];
    let offset = 0;
    while (offset < size) {
      if (fs.readSync(fd, header, 0, 16, offset) < 8) return { ok: false, reason: 'Truncated box header', boxes };
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8) return { ok: false, reason: `Invalid box size for "${type}"`, boxes };
      boxes.push(type);
      offset += boxSize;
      if (boxes.length > 10000) break;
    }
    if (offset > size) return { ok: false, reason: 'File is truncated (last box extends past end of file)', boxes };
    if (boxes[0] !== 'ftyp') return { ok: false, reason: 'Missing MP4 file-type header', boxes };
    const moov = boxes.indexOf('moov');
    const mdat = boxes.indexOf('mdat');
    if (moov === -1) return { ok: false, reason: 'Missing MP4 index (moov)', boxes };
    return { ok: true, fastStart: mdat === -1 || moov < mdat, boxes };
  } finally {
    fs.closeSync(fd);
  }
}

async function decodeCheck(filePath, { start, length, signal }) {
  const engine = requireEngine();
  // Progress output keeps the stall watchdog fed during long full-file checks.
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  if (start) args.push('-ss', String(start));
  args.push('-i', filePath);
  if (length) args.push('-t', String(length));
  args.push('-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-');
  const res = await runProcess(engine.ffmpeg.path, args, { signal, stallMs: STALL_TIMEOUT_MS, onStdoutLine: () => {} });
  const errorLines = res.stderr.trim() ? res.stderr.trim().split(/\r?\n/).length : 0;
  return { ok: res.code === 0, errorLines, stderrTail: tail(res.stderr, 5) };
}

async function validateOutput(outputPath, sourceInfo, plan, { signal, fullDecode = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(outputPath)) return { ok: false, errors: ['Output file was not created.'], warnings };
  const size = fs.statSync(outputPath).size;
  if (size < 1024) return { ok: false, errors: ['Output file is empty or far too small.'], warnings };

  const boxes = inspectMp4Boxes(outputPath);
  if (!boxes.ok) return { ok: false, errors: [`MP4 structure invalid: ${boxes.reason}.`], warnings };
  if (!boxes.fastStart) warnings.push('Output is not optimised for fast start (index stored at end).');

  let outInfo;
  try {
    outInfo = analyze(await probe(outputPath, { signal }));
  } catch (err) {
    return { ok: false, errors: [`Output could not be read back: ${err.message}`], warnings };
  }

  if (!/mp4/.test(outInfo.container) || outInfo.majorBrand === 'qt  ') errors.push(`Output container is not MP4 (${outInfo.container}).`);

  const sv = sourceInfo.video;
  const ov = outInfo.video;
  if (!ov) {
    errors.push('Output has no video stream.');
  } else {
    const expectedCodec = plan.video.action === 'copy' ? sv.codec : (plan.video.encoder === 'libx265' ? 'hevc' : 'h264');
    if (ov.codec !== expectedCodec) errors.push(`Output video codec is ${ov.codec}, expected ${expectedCodec}.`);

    const padTolerance = plan.video.action === 'encode' ? 1 : 0;
    const wDiff = ov.displayWidth - sv.displayWidth;
    const hDiff = ov.displayHeight - sv.displayHeight;
    if (wDiff < 0 || hDiff < 0 || wDiff > padTolerance || hDiff > padTolerance) {
      errors.push(`Resolution changed: source ${sv.displayWidth}×${sv.displayHeight}, output ${ov.displayWidth}×${ov.displayHeight}.`);
    }
    if (ov.orientation !== sv.orientation) errors.push(`Orientation changed from ${sv.orientation} to ${ov.orientation}.`);

    if (!ov.fps) errors.push('Output frame rate could not be determined.');
    else if (sv.fps && Math.abs(ov.fps - sv.fps) / sv.fps > 0.05) {
      warnings.push(`Frame rate differs: source ${sv.fps.toFixed(3)} fps, output ${ov.fps.toFixed(3)} fps (normal for variable-frame-rate phone footage).`);
    }
  }

  if (outInfo.audio.length !== plan.audio.length) {
    errors.push(`Expected ${plan.audio.length} audio track(s) but output has ${outInfo.audio.length}.`);
  }
  if (sourceInfo.audio.some(a => a.channels > 0) && outInfo.audio.length === 0) errors.push('Source has audio but output is silent.');

  if (sourceInfo.duration && outInfo.duration) {
    const diff = Math.abs(outInfo.duration - sourceInfo.duration);
    if (diff > Math.max(2, sourceInfo.duration * 0.05)) {
      errors.push(`Duration changed: source ${sourceInfo.duration.toFixed(2)}s, output ${outInfo.duration.toFixed(2)}s.`);
    } else if (diff > Math.max(0.5, sourceInfo.duration * 0.01)) {
      warnings.push(`Duration differs slightly: source ${sourceInfo.duration.toFixed(2)}s, output ${outInfo.duration.toFixed(2)}s.`);
    }
  } else if (!outInfo.duration) {
    errors.push('Output duration could not be determined.');
  }

  // Decode check: the whole file if requested, otherwise its start and end
  // (catches corrupt streams and truncated files without re-reading hours of video).
  if (!errors.length) {
    const checks = fullDecode || !outInfo.duration || outInfo.duration <= 12
      ? [{ start: 0, length: 0 }]
      : [{ start: 0, length: 4 }, { start: Math.max(0, outInfo.duration - 5), length: 5 }];
    for (const check of checks) {
      const res = await decodeCheck(outputPath, { ...check, signal });
      if (!res.ok) errors.push(`Output could not be decoded: ${res.stderrTail || 'decoder error'}`);
      else if (res.errorLines > 20) errors.push(`Output has many decode errors: ${res.stderrTail}`);
      else if (res.errorLines > 0) warnings.push(`Minor decoder messages while checking output: ${res.stderrTail}`);
    }
  }

  // Tag names differ in case between containers (MKV "TITLE", MP4 "title");
  // container/encoder bookkeeping tags are expected to change.
  const ignoredTags = ['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'handler_name', 'duration'];
  const outputKeys = new Set(outInfo.metadataKeys.map(k => k.toLowerCase()));
  const missingMetadata = plan.preserveMetadata
    ? sourceInfo.metadataKeys.filter(k => !ignoredTags.includes(k.toLowerCase()) && !outputKeys.has(k.toLowerCase()))
    : [];

  return { ok: errors.length === 0, errors, warnings, outputInfo: outInfo, missingMetadata, fastStart: boxes.fastStart };
}

// Lists notable differences between source and output for the report.
function compareSummaries(source, output) {
  const flags = [];
  if (!source || !output) return flags;
  if (source.resolution !== output.resolution) flags.push(`Resolution ${source.resolution} → ${output.resolution}`);
  if (source.orientation !== output.orientation) flags.push(`Orientation ${source.orientation} → ${output.orientation}`);
  if (source.audioTracks !== output.audioTracks) flags.push(`Audio tracks ${source.audioTracks} → ${output.audioTracks}`);
  if (source.subtitles !== output.subtitles) flags.push(`Subtitle tracks ${source.subtitles} → ${output.subtitles}`);
  return flags;
}

module.exports = {
  getEngine,
  requireEngine,
  getVideoSettings,
  probe,
  analyze,
  summarize,
  planConversion,
  buildFfmpegArgs,
  convert,
  validateOutput,
  inspectMp4Boxes,
  compareSummaries,
  runProcess
};
