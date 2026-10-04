const { planBlocks, getTranscriptionSettings } = require('../src/services/transcriptionService');

describe('transcriptionService.planBlocks', () => {
  const rate = 100; // a tiny sample rate keeps the arrays small

  function tone(seconds, quietAt = []) {
    const samples = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i) * 0.5;
    for (const [from, to] of quietAt) samples.fill(0, Math.round(from * rate), Math.round(to * rate));
    return samples;
  }

  test('short audio is a single block', () => {
    expect(planBlocks(tone(30), { sampleRate: rate, blockSeconds: 120, searchSeconds: 6 })).toEqual([[0, 3000]]);
  });

  test('cuts at the quiet moment near each boundary and covers every sample', () => {
    const samples = tone(300, [[117, 118], [238, 239]]);
    const blocks = planBlocks(samples, { sampleRate: rate, blockSeconds: 120, searchSeconds: 6 });
    expect(blocks).toHaveLength(3);
    expect(blocks[0][0]).toBe(0);
    expect(blocks[blocks.length - 1][1]).toBe(samples.length);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i][0]).toBe(blocks[i - 1][1]);
    expect(blocks[0][1] / rate).toBeGreaterThanOrEqual(117);
    expect(blocks[0][1] / rate).toBeLessThanOrEqual(118);
    expect(blocks[1][1] / rate).toBeGreaterThanOrEqual(238);
    expect(blocks[1][1] / rate).toBeLessThanOrEqual(239);
  });
});

describe('transcriptionService.getTranscriptionSettings', () => {
  test('falls back to safe values', () => {
    expect(getTranscriptionSettings({ newsWhisperModel: 'huge', newsLanguage: 'klingon' })).toEqual({ model: 'base', language: 'english', translate: false });
    expect(getTranscriptionSettings({ newsWhisperModel: 'small', newsLanguage: 'zulu' })).toEqual({ model: 'small', language: 'zulu', translate: false });
    expect(getTranscriptionSettings({ newsLanguage: 'zulu', newsTranslateToEnglish: true }).translate).toBe(true);
    expect(getTranscriptionSettings({ newsLanguage: 'english', newsTranslateToEnglish: true }).translate).toBe(false);
  });
});
