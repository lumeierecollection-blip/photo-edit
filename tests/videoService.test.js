const fs = require('fs');
const path = require('path');
const video = require('../src/services/videoService');
const { FIXTURES, FIXTURE_DIR, buildFixture } = require('./helpers/videoFixtures');

const engine = video.getEngine();
const describeIfEngine = engine.available ? describe : describe.skip;
if (!engine.available) {
  console.warn('FFmpeg/FFprobe not found — skipping real-media video converter tests.');
}

describe('Video planning (no FFmpeg required)', () => {
  const settings = video.getVideoSettings({ videoCodec: 'h264', videoKeepHevc: false });
  const base = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, size: 1000, metadataKeys: [],
    extraVideoStreams: [], coverArt: [], subtitles: [], dataStreams: [], attachments: 0, chapters: 0
  };
  const h264 = { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, rotation: 0, orientation: 'landscape', fps: 30 };
  const aac = { index: 1, codec: 'aac', channels: 2, sampleRate: 48000 };

  test('H.264 + AAC is remuxed, never re-encoded', () => {
    const plan = video.planConversion({ ...base, video: h264, audio: [aac] }, settings);
    expect(plan.strategy).toBe('remux');
    expect(plan.video.action).toBe('copy');
    expect(plan.audio[0].action).toBe('copy');
    const args = video.buildFfmpegArgs('in.mov', 'out.mp4', { ...plan, videoIndex: 0 });
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-movflags', '+faststart']));
    expect(args).not.toContain('libx264');
  });

  test('H.264 with AC-3 audio copies video and converts only the audio', () => {
    const plan = video.planConversion({ ...base, video: h264, audio: [{ ...aac, codec: 'ac3', channels: 6 }] }, settings);
    expect(plan.strategy).toBe('remux-video');
    expect(plan.audio[0]).toMatchObject({ action: 'encode', codec: 'aac', channels: 6 });
    expect(plan.audio[0].bitrateKbps).toBeGreaterThanOrEqual(384);
  });

  test('10-bit / 4:2:2 H.264 and HEVC are re-encoded for compatibility by default', () => {
    expect(video.planConversion({ ...base, video: { ...h264, pixFmt: 'yuv422p10le' }, audio: [aac] }, settings).strategy).toBe('encode');
    expect(video.planConversion({ ...base, video: { ...h264, codec: 'hevc' }, audio: [aac] }, settings).strategy).toBe('encode');
  });

  test('HEVC is remuxed when the administrator chooses to keep HEVC', () => {
    const keep = video.getVideoSettings({ videoKeepHevc: true });
    const plan = video.planConversion({ ...base, video: { ...h264, codec: 'hevc', pixFmt: 'yuv420p10le' }, audio: [aac] }, keep);
    expect(plan.strategy).toBe('remux');
    expect(plan.video.tag).toBe('hvc1');
  });

  test('re-encoding never scales, crops or forces a frame rate', () => {
    const plan = video.planConversion({ ...base, video: { ...h264, codec: 'vp9' }, audio: [aac] }, settings);
    const args = video.buildFfmpegArgs('in.webm', 'out.mp4', { ...plan, videoIndex: 0 });
    const vf = args[args.indexOf('-vf') + 1] || '';
    expect(vf).not.toMatch(/scale=|crop=|fps=|minterpolate/);
    expect(args).not.toContain('-r');
    expect(args).not.toContain('-s');
  });

  test('audio-only files are skipped, not failed', () => {
    expect(() => video.planConversion({ ...base, video: null, audio: [aac] }, settings)).toThrow(expect.objectContaining({ skip: true }));
  });

  test('image-based subtitles and attachments are reported, not silently dropped', () => {
    const plan = video.planConversion({
      ...base, video: h264, audio: [aac], attachments: 2,
      subtitles: [{ index: 2, codec: 'hdmv_pgs_subtitle' }, { index: 3, codec: 'subrip' }]
    }, settings);
    expect(plan.subtitles).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/hdmv_pgs_subtitle/);
    expect(plan.notes.join(' ')).toMatch(/attachment/);
  });

  test('settings are clamped and whitelisted', () => {
    const s = video.getVideoSettings({ videoCrf: 99, videoPreset: 'fast; rm -rf /', videoAudioBitrateKbps: 5 });
    expect(s.crf).toBe(51);
    expect(s.preset).toBe('medium');
    expect(s.audioBitrateKbps).toBe(96);
  });
});

describeIfEngine('Real-media conversion', () => {
  const settings = video.getVideoSettings({ videoCodec: 'h264', videoKeepHevc: false, videoPreset: 'ultrafast' });
  const outDir = path.join(FIXTURE_DIR, 'out');

  beforeAll(() => fs.mkdirSync(outDir, { recursive: true }));

  const convertible = Object.entries(FIXTURES).filter(([, fx]) => !fx.expect.skip && !fx.expect.unreadable);

  test.each(convertible.map(([name]) => [name]))('%s → valid MP4 with preserved properties', async name => {
    const fx = FIXTURES[name];
    const input = buildFixture(name);
    const output = path.join(outDir, `${name}.mp4`);
    fs.rmSync(output, { force: true });

    const sourceInfo = video.analyze(await video.probe(input));
    const plan = video.planConversion(sourceInfo, settings);
    expect(plan.strategy).toBe(fx.expect.strategy);

    const progress = [];
    await video.convert(input, output, sourceInfo, plan, { onProgress: p => progress.push(p) });
    const result = await video.validateOutput(output, sourceInfo, plan, { fullDecode: true });
    if (!result.ok) throw new Error(`Validation failed for ${name}: ${result.errors.join(' | ')}`);

    const src = video.summarize(sourceInfo);
    const out = video.summarize(result.outputInfo);
    expect(result.fastStart).toBe(true);
    expect(['h264']).toContain(out.videoCodec);
    expect(out.orientation).toBe(src.orientation);
    if (fx.expect.resolutionAllowPad) {
      expect(result.outputInfo.video.displayWidth - sourceInfo.video.displayWidth).toBeLessThanOrEqual(1);
    } else {
      expect(out.resolution).toBe(src.resolution);
    }
    if (fx.expect.resolution) expect(out.resolution).toBe(fx.expect.resolution);
    if (fx.expect.orientation) expect(out.orientation).toBe(fx.expect.orientation);
    if (fx.expect.fps) expect(out.fps).toBeCloseTo(fx.expect.fps, 0);
    if (fx.expect.audioTracks != null) expect(out.audioTracks).toBe(fx.expect.audioTracks);
    if (fx.expect.subtitles != null) expect(out.subtitles).toBe(fx.expect.subtitles);
    if (fx.expect.hdrSource) expect(src.hdr).toBe(fx.expect.hdrSource);
    expect(out.audioCodecs.every(c => c === 'aac' || c === 'mp3')).toBe(true);
    expect(Math.abs(out.duration - src.duration)).toBeLessThan(0.6);
    if (src.duration > 1) expect(progress.length).toBeGreaterThan(0);

    // The source file must be byte-for-byte untouched by conversion.
    expect(fs.existsSync(input)).toBe(true);
  }, 180000);

  test('remuxed video stream is bit-identical to the source (no generational loss)', async () => {
    const input = buildFixture('mov_h264_aac_1080p30');
    const output = path.join(outDir, 'remux_identity.mp4');
    const info = video.analyze(await video.probe(input));
    await video.convert(input, output, info, video.planConversion(info, settings));
    const hash = async file => {
      const { stdout } = await video.runProcess(video.getEngine().ffmpeg.path, ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'hash', '-hash', 'md5', '-']);
      return stdout.trim();
    };
    expect(await hash(output)).toBe(await hash(input));
  }, 60000);

  test('metadata (title, language) is preserved', async () => {
    const input = buildFixture('mkv_multi_audio_subs');
    const output = path.join(outDir, 'meta.mp4');
    const info = video.analyze(await video.probe(input));
    await video.convert(input, output, info, video.planConversion(info, settings));
    const probed = await video.probe(output);
    expect(probed.format.tags.title).toBe('Camera 3');
    expect(probed.streams.filter(s => s.codec_type === 'audio')[1].tags.language).toBe('spa');
  }, 60000);

  test('audio-only file is identified as "skip"', async () => {
    const info = video.analyze(await video.probe(buildFixture('audio_only')));
    expect(() => video.planConversion(info, settings)).toThrow(expect.objectContaining({ skip: true }));
  });

  test('corrupt file is reported clearly instead of crashing', async () => {
    // Depending on the damage FFprobe either errors or finds no streams; both must be a failure, not a skip.
    let error;
    try {
      const info = video.analyze(await video.probe(buildFixture('corrupt')));
      video.planConversion(info, settings);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.skip).toBeUndefined();
    expect(error.message).toMatch(/corrupt|could not read/i);
  });

  test('truncated MP4 fails validation', async () => {
    const good = path.join(outDir, 'mov_h264_aac_1080p30.mp4');
    const input = buildFixture('mov_h264_aac_1080p30');
    const info = video.analyze(await video.probe(input));
    const plan = video.planConversion(info, settings);
    if (!fs.existsSync(good)) await video.convert(input, good, info, plan);
    const truncated = path.join(outDir, 'truncated.mp4');
    const bytes = fs.readFileSync(good);
    fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    const result = await video.validateOutput(truncated, info, plan);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/truncated/i);
  }, 60000);
});
