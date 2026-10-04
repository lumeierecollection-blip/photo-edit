// End-to-end test of the Church News routes with a real (generated) video.
// Whisper and the Remotion renderer are replaced with fast stand-ins; the
// transcription and poster logic have their own tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NEWS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'church-news-test-'));
process.env.CHURCH_NEWS_DIR = NEWS_DIR;

jest.mock('../src/services/transcriptionService', () => ({
  MODELS: { base: 'onnx-community/whisper-base' },
  getTranscriptionSettings: () => ({ model: 'base', language: 'english' }),
  transcribeVideo: jest.fn(async (videoPath, workDir, { onProgress }) => {
    onProgress({ stage: 'transcribing', fraction: 0.5, block: 1, blocks: 1 });
    return {
      text: 'x',
      durationSeconds: 3,
      model: 'onnx-community/whisper-base',
      language: 'english',
      segments: [
        { start: 0, end: 5, text: 'The Youth Conference is on Saturday 18 October at 9am in the main auditorium.' },
        { start: 5, end: 9, text: 'Register with Sister Thandi on 082 555 1234.' }
      ]
    };
  })
}));

jest.mock('../src/services/newsRenderService', () => ({
  renderPreviewFrame: jest.fn(async (props, out) => { require('fs').writeFileSync(out, 'jpg'); }),
  renderNewsVideo: jest.fn(async (props, out) => { require('fs').writeFileSync(out, 'mp4'); })
}));

const express = require('express');
const request = require('supertest');
const { getEngine } = require('../src/services/videoService');
const { transcribeVideo } = require('../src/services/transcriptionService');
const { renderNewsVideo } = require('../src/services/newsRenderService');
const newsRoutes = require('../src/routes/news');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { tokens: {} }; next(); });
  app.use('/api/news', newsRoutes);
  app.use('/news-media', newsRoutes.mediaRouter);
  return app;
}

async function waitForJob(app, id) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/news/projects/${id}`);
    if (res.body.job && res.body.job.done) return res.body;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Job did not finish.');
}

const engine = getEngine();
const maybe = engine.available ? describe : describe.skip;

maybe('Church News routes', () => {
  const app = makeApp();
  let videoPath;

  beforeAll(() => {
    videoPath = path.join(NEWS_DIR, 'Sunday News.mp4');
    const res = spawnSync(engine.ffmpeg.path, ['-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x00b140:s=320x568:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath]);
    if (res.status !== 0) throw new Error(String(res.stderr));
  });

  afterAll(() => fs.rmSync(NEWS_DIR, { recursive: true, force: true }));

  test('upload → transcript → posters → studio → render → delete', async () => {
    const created = await request(app).post('/api/news/projects').attach('video', videoPath);
    expect(created.status).toBe(200);
    const { id, name, durationSeconds, hasAudio } = created.body.project;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(name).toBe('Sunday News');
    expect(durationSeconds).toBeGreaterThan(2);
    expect(hasAudio).toBe(true);

    // Transcription starts by itself, and posters are found when it finishes.
    const details = await waitForJob(app, id);
    expect(transcribeVideo).toHaveBeenCalledTimes(1);
    expect(details.job).toMatchObject({ type: 'transcribe', stage: 'complete', error: null });
    expect(details.transcript.segments).toHaveLength(2);
    expect(details.posters.posters.map(p => p.title)).toEqual(['Youth Conference']);
    expect(details.posters.posters[0].contact).toBe('Sister Thandi · 082 555 1234');

    // The studio starts portrait (the clip is tall), with headlines ready to check.
    expect(details.studio.format).toBe('portrait');
    expect(details.studio.headlinesSuggested).toBe(true);
    expect(details.studio.mainHeadlines).toEqual([
      { text: 'Youth Conference · Saturday 18 October', start: 0, quote: expect.stringMatching(/^The Youth Conference/), confirmed: false }
    ]);
    expect(details.studio.tickerHeadlines).toEqual(['YOUTH CONFERENCE · Saturday 18 October · 9am']);

    // Edits are saved, and odd input is cleaned up.
    const edited = [{ ...details.posters.posters[0], posterText: { headline: 'YOUTH CONFERENCE 2026', lines: ['Saturday 18 October · 9am', ' ', 'Main Auditorium'] }, done: true, confidence: 'bogus' }];
    const saved = await request(app).put(`/api/news/projects/${id}/posters`).send({ posters: edited });
    expect(saved.status).toBe(200);
    expect(saved.body.posters[0]).toMatchObject({ confidence: 'manual', done: true, posterText: { headline: 'YOUTH CONFERENCE 2026', lines: ['Saturday 18 October · 9am', 'Main Auditorium'] } });

    const txt = await request(app).get(`/api/news/projects/${id}/export/transcript.txt`);
    expect(txt.status).toBe(200);
    expect(txt.text).toContain('[00:00] The Youth Conference');
    const srt = await request(app).get(`/api/news/projects/${id}/export/transcript.srt`);
    expect(srt.text).toContain('00:00:05,000 --> 00:00:09,000');
    const posterList = await request(app).get(`/api/news/projects/${id}/export/posters.txt`);
    expect(posterList.text).toContain('POSTER 1: YOUTH CONFERENCE 2026');

    // Studio settings are clamped to safe ranges.
    const studio = await request(app).put(`/api/news/projects/${id}/studio`).send({ name: 'Pastor John', keyThreshold: 9999, anchorZoom: -4, tickerHeadlines: ['A', '', 'B'] });
    expect(studio.body.studio).toMatchObject({ name: 'Pastor John', keyThreshold: 200, anchorZoom: 0.3, tickerHeadlines: ['A', 'B'] });

    // Headlines are sorted by time, blanks dropped, and the format checked.
    const headlines = await request(app).put(`/api/news/projects/${id}/studio`).send({
      format: 'landscape',
      nameMode: 'start',
      mainHeadlines: [
        { text: 'Baptism Service', start: 40, confirmed: true },
        { text: '   ', start: 5 },
        { text: 'Welcome', start: -3, confirmed: 'yes' }
      ]
    });
    expect(headlines.body.studio).toMatchObject({
      format: 'landscape',
      nameMode: 'start',
      name: 'Pastor John',
      mainHeadlines: [
        { text: 'Welcome', start: 0, quote: null, confirmed: true },
        { text: 'Baptism Service', start: 40, quote: null, confirmed: true }
      ]
    });
    expect((await request(app).put(`/api/news/projects/${id}/studio`).send({ format: 'square' })).body.studio.format).toBe('landscape');

    const suggested = await request(app).post(`/api/news/projects/${id}/headlines/suggest`);
    expect(suggested.body.mainHeadlines[0].text).toBe('YOUTH CONFERENCE 2026 · Saturday 18 October');

    const render = await request(app).post(`/api/news/projects/${id}/render`).send({ role: 'Youth Pastor, Soshanguve Branch' });
    expect(render.status).toBe(200);
    const afterRender = await waitForJob(app, id);
    expect(afterRender.job).toMatchObject({ type: 'render', stage: 'complete' });
    expect(afterRender.hasVideo).toBe(true);
    const props = renderNewsVideo.mock.calls[0][0];
    expect(props).toMatchObject({
      format: 'landscape',
      nameMode: 'start',
      name: 'Pastor John',
      role: 'Youth Pastor, Soshanguve Branch',
      tickerHeadlines: ['A', 'B'],
      mainHeadlines: [{ text: 'Welcome', start: 0 }, { text: 'Baptism Service', start: 40 }]
    });
    expect(props.chromaKey.threshold).toBe(200);
    expect(props.videoSrc).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/news-media/${id}/source\\.mp4$`));

    // The renderer's media route serves the project video to this computer.
    const media = await request(app).get(`/news-media/${id}/source.mp4`);
    expect(media.status).toBe(200);
    expect((await request(app).get(`/news-media/${id}/project.json`)).status).toBe(404);
    expect((await request(app).get('/news-media/not-an-id/source.mp4')).status).toBe(404);

    const download = await request(app).get(`/api/news/projects/${id}/news.mp4?download=1`);
    expect(download.headers['content-disposition']).toMatch(/Sunday News - News\.mp4/);

    const del = await request(app).delete(`/api/news/projects/${id}`);
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(NEWS_DIR, id))).toBe(false);
    expect((await request(app).get(`/api/news/projects/${id}`)).status).toBe(404);
  });

  test('a second job on a busy project is refused', async () => {
    let release;
    transcribeVideo.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const created = await request(app).post('/api/news/projects').attach('video', videoPath);
    const { id } = created.body.project;
    const again = await request(app).post(`/api/news/projects/${id}/transcribe`);
    expect(again.status).toBe(409);

    const cancel = await request(app).post(`/api/news/projects/${id}/cancel`);
    expect(cancel.body.cancelled).toBe(true);
    release({ segments: [], text: '', durationSeconds: 3 });
    const details = await waitForJob(app, id);
    expect(details.job.stage).toBe('cancelled');
  });

  test('non-video uploads and bad ids are rejected', async () => {
    const notVideo = await request(app).post('/api/news/projects').attach('video', Buffer.from('hello'), 'notes.txt');
    expect(notVideo.status).toBe(400);
    const fakeVideo = await request(app).post('/api/news/projects').attach('video', Buffer.from('not really a video'), 'fake.mp4');
    expect(fakeVideo.status).toBe(400);
    expect(fs.readdirSync(NEWS_DIR).filter(n => /^[0-9a-f]{32}$/.test(n)).every(n => fs.existsSync(path.join(NEWS_DIR, n, 'project.json')))).toBe(true);
    expect((await request(app).get('/api/news/projects/..%2F..%2Fsecrets')).status).toBe(404);
  });
});
