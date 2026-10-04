// Generates small synthetic test videos with FFmpeg (test pattern + tone), so
// the converter can be exercised against real containers and codecs.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getEngine } = require('../../src/services/videoService');

const FIXTURE_DIR = path.join(__dirname, '../../uploads/temp/test-fixtures');

function ffmpeg(args) {
  const engine = getEngine();
  const res = spawnSync(engine.ffmpeg.path, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`Fixture generation failed: ${res.stderr}`);
}

function videoSrc(w, h, fps, seconds) {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`];
}

function audioSrc(seconds, channels = 2, rate = 48000) {
  const layout = { 1: 'mono', 2: 'stereo', 6: '5.1' }[channels] || 'stereo';
  return ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${seconds},aformat=channel_layouts=${layout}`];
}

// name -> { file, build(outPath) , expect }
const FIXTURES = {
  mov_h264_aac_1080p30: {
    file: 'Sunday_Service.MOV',
    build: out => ffmpeg([...videoSrc(1920, 1080, 30, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]),
    expect: { strategy: 'remux', resolution: '1920 × 1080', fps: 30, audioTracks: 1, orientation: 'landscape' }
  },
  mp4_h264_aac_720p25: {
    file: 'Already.mp4',
    build: out => ffmpeg([...videoSrc(1280, 720, 25, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]),
    expect: { strategy: 'remux', resolution: '1280 × 720', fps: 25, audioTracks: 1 }
  },
  m4v_h264_aac_24: {
    file: 'Trailer.m4v',
    build: out => ffmpeg([...videoSrc(1280, 720, 24, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'ipod', out]),
    expect: { strategy: 'remux', fps: 24, audioTracks: 1 }
  },
  mkv_multi_audio_subs: {
    file: 'Camera_003.MKV',
    build: out => {
      const srt = path.join(FIXTURE_DIR, 'subs.srt');
      fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\nWelcome to church\n');
      ffmpeg([...videoSrc(1920, 1080, 30, 2), ...audioSrc(2), ...audioSrc(2, 6), '-i', srt,
        '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:s', 'srt',
        '-metadata:s:a:1', 'language=spa', '-metadata', 'title=Camera 3', '-shortest', out]);
    },
    expect: { strategy: 'remux-video', audioTracks: 2, subtitles: 1 }
  },
  mts_h264_ac3_50: {
    file: 'CLIP0001.MTS',
    build: out => ffmpeg([...videoSrc(1920, 1080, 50, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', '-f', 'mpegts', out]),
    expect: { strategy: 'remux-video', fps: 50, audioTracks: 1 }
  },
  m2ts_h264_aac_60: {
    file: 'STREAM.m2ts',
    build: out => ffmpeg([...videoSrc(1280, 720, 60, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mpegts', '-mpegts_m2ts_mode', '1', out]),
    expect: { strategy: 'remux', fps: 60, audioTracks: 1 }
  },
  avi_mpeg4_mp3: {
    file: 'Old_Tape.AVI',
    build: out => ffmpeg([...videoSrc(720, 576, 25, 2), ...audioSrc(2), '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '720 × 576', fps: 25, audioTracks: 1 }
  },
  webm_vp9_opus_720p: {
    file: 'Interview_Final.WEBM',
    build: out => ffmpeg([...videoSrc(1280, 720, 30, 2), ...audioSrc(2), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '1280 × 720', fps: 30, audioTracks: 1 }
  },
  threegp_mpeg4_aac: {
    file: 'phone.3gp',
    build: out => ffmpeg([...videoSrc(352, 288, 15, 2), ...audioSrc(2, 1, 16000), '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-f', '3gp', out]),
    expect: { strategy: 'encode', resolution: '352 × 288', audioTracks: 1 }
  },
  wmv: {
    file: 'Announcements.wmv',
    build: out => ffmpeg([...videoSrc(640, 480, 30, 2), ...audioSrc(2, 2, 44100), '-c:v', 'wmv2', '-c:a', 'wmav2', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '640 × 480', audioTracks: 1 }
  },
  flv: {
    file: 'stream.flv',
    build: out => ffmpeg([...videoSrc(640, 360, 30, 2), ...audioSrc(2, 2, 44100), '-c:v', 'flv1', '-c:a', 'libmp3lame', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '640 × 360', audioTracks: 1 }
  },
  ogv_theora_vorbis: {
    file: 'choir.ogv',
    build: out => ffmpeg([...videoSrc(640, 360, 25, 2), ...audioSrc(2), '-c:v', 'libtheora', '-c:a', 'libvorbis', '-shortest', out]),
    expect: { strategy: 'encode', fps: 25, audioTracks: 1 }
  },
  mpg_mpeg2_interlaced: {
    file: 'dvd_rip.mpg',
    build: out => ffmpeg([...videoSrc(720, 576, 25, 2), ...audioSrc(2), '-c:v', 'mpeg2video', '-vf', 'setfield=tff', '-flags', '+ilme+ildct', '-b:v', '5M', '-c:a', 'mp2', '-shortest', '-f', 'mpeg', out]),
    expect: { strategy: 'encode', fps: 25, resolution: '720 × 576' }
  },
  portrait_phone_rotated: {
    // Stored 1920x1080 with a 90° display matrix, like iPhone portrait footage.
    file: 'IMG_0420.MOV',
    build: out => {
      const tmp = path.join(FIXTURE_DIR, 'rot_tmp.mov');
      ffmpeg([...videoSrc(1920, 1080, 30, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
      ffmpeg(['-display_rotation:v:0', '90', '-i', tmp, '-c', 'copy', out]);
      fs.rmSync(tmp, { force: true });
    },
    expect: { strategy: 'remux', resolution: '1080 × 1920', orientation: 'portrait', audioTracks: 1 }
  },
  portrait_rotated_needs_encode: {
    file: 'IMG_0421.mov',
    build: out => {
      const tmp = path.join(FIXTURE_DIR, 'rot_tmp2.mov');
      ffmpeg([...videoSrc(1280, 720, 30, 2), ...audioSrc(2), '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', tmp]);
      ffmpeg(['-display_rotation:v:0', '-90', '-i', tmp, '-c', 'copy', out]);
      fs.rmSync(tmp, { force: true });
    },
    expect: { strategy: 'encode', resolution: '720 × 1280', orientation: 'portrait', audioTracks: 1 }
  },
  portrait_native_1080x1920: {
    file: 'Reel.mp4',
    build: out => ffmpeg([...videoSrc(1080, 1920, 30, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]),
    expect: { strategy: 'remux', resolution: '1080 × 1920', orientation: 'portrait' }
  },
  square_24: {
    file: 'square.mkv',
    build: out => ffmpeg([...videoSrc(1080, 1080, 24, 2), ...audioSrc(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'flac', '-shortest', out]),
    expect: { strategy: 'remux-video', resolution: '1080 × 1080', orientation: 'square', fps: 24 }
  },
  uhd_10bit_60: {
    file: 'Worship_4K.mov',
    build: out => ffmpeg([...videoSrc(3840, 2160, 60, 1), ...audioSrc(1), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '3840 × 2160', fps: 60 }
  },
  hdr_hevc_pq: {
    file: 'HDR_Clip.MOV',
    build: out => ffmpeg([...videoSrc(1920, 1080, 30, 1), ...audioSrc(1), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', out]),
    expect: { strategy: 'encode', resolution: '1920 × 1080', hdrSource: 'HDR10 (PQ)' }
  },
  no_audio: {
    file: 'Silent_Broll.mkv',
    build: out => ffmpeg([...videoSrc(1280, 720, 30, 2), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]),
    expect: { strategy: 'remux', audioTracks: 0 }
  },
  odd_dimensions: {
    file: 'odd.avi',
    build: out => ffmpeg([...videoSrc(641, 361, 30, 2), '-c:v', 'ffv1', out]),
    expect: { strategy: 'encode', resolutionAllowPad: true }
  },
  very_short: {
    file: 'blip.mov',
    build: out => ffmpeg([...videoSrc(1280, 720, 30, 0.2), ...audioSrc(0.2), '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', out]),
    expect: { strategy: 'encode' }
  },
  audio_only: {
    file: 'sermon_audio.mp4',
    build: out => ffmpeg([...audioSrc(2), '-c:a', 'aac', out]),
    expect: { skip: true }
  },
  corrupt: {
    file: 'Camera_021.AVI',
    build: out => fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00AVI LIST'), require('crypto').randomBytes(200000)])),
    expect: { unreadable: true }
  }
};

function buildFixture(name) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const fx = FIXTURES[name];
  const out = path.join(FIXTURE_DIR, `${name}${path.extname(fx.file)}`);
  if (!fs.existsSync(out)) fx.build(out);
  return out;
}

module.exports = { FIXTURES, FIXTURE_DIR, buildFixture, ffmpeg };
