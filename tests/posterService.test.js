const { suggestPosters, suggestHeadlines, toSentences } = require('../src/services/posterService');

// Whisper-style segments: a sentence can run across two segments.
const NEWS_SEGMENTS = [
  { start: 0, end: 3.84, text: 'Good evening Church Family, and welcome to this week\'s Church News.' },
  { start: 3.84, end: 11.36, text: 'First, the Youth Conference will take place on Saturday 18 October at 9am in the main auditorium.' },
  { start: 12.24, end: 15.44, text: 'All young people between 13 and 25 are welcome.' },
  { start: 16.32, end: 23.92, text: 'Registration is 50 Rand, and you can register with Sister Thandi on 082-555-1234.' },
  { start: 23.92, end: 30.16, text: 'Next, our Women\'s Prayer Breakfast is happening next Sunday at 7 in the morning in the church' },
  { start: 30.16, end: 31.68, text: 'hall.' },
  { start: 31.68, end: 33.64, text: 'Please bring a friend.' },
  { start: 33.64, end: 37.6, text: 'We also want to thank everyone who supported the building fund.' },
  { start: 37.6, end: 44.44, text: 'Finally, a reminder that there will be a baptism service on 2 November after the main service.' },
  { start: 44.44, end: 48.84, text: 'If you would like to be baptised, speak to Pastor John.' },
  { start: 48.84, end: 51.38, text: 'God bless you, and have a wonderful week.' }
];

describe('posterService', () => {
  test('joins sentences split across segments and keeps their start time', () => {
    const sentences = toSentences(NEWS_SEGMENTS);
    const breakfast = sentences.find(s => s.text.includes('Prayer Breakfast'));
    expect(breakfast.text).toMatch(/in the church hall\.$/);
    expect(breakfast.start).toBeCloseTo(23.92, 1);
  });

  test('finds one poster per announcement, with its details', () => {
    const { posters } = suggestPosters(NEWS_SEGMENTS);
    expect(posters.map(p => p.title)).toEqual(['Youth Conference', "Women's Prayer Breakfast", 'Baptism Service']);

    const [youth, breakfast, baptism] = posters;
    expect(youth).toMatchObject({
      date: 'Saturday 18 October',
      time: '9am',
      venue: 'the main auditorium',
      audience: 'All young people between 13 and 25',
      cost: 'R50',
      contact: 'Sister Thandi · 082-555-1234',
      confidence: 'high',
      checks: []
    });
    expect(youth.posterText.headline).toBe('YOUTH CONFERENCE');
    expect(youth.start).toBeCloseTo(3.84, 1);

    expect(breakfast).toMatchObject({ date: 'next Sunday', time: '7am', venue: 'the church hall' });
    expect(breakfast.checks.join(' ')).toMatch(/exact date/);

    expect(baptism).toMatchObject({ date: '2 November', time: 'after the main service', contact: 'Pastor John' });
    expect(baptism.checks).toContain('No venue was mentioned.');
    expect(baptism.quote).not.toMatch(/God bless/);
  });

  test('a thank-you with no date, time or place is not a poster', () => {
    const { posters } = suggestPosters(NEWS_SEGMENTS);
    expect(posters.some(p => /building/i.test(p.title))).toBe(false);
  });

  test('merges a recap of the same event into the first mention', () => {
    const segments = [
      { start: 0, end: 6, text: 'The Men\'s Breakfast is on Saturday the 4th of October at 8am.' },
      { start: 6, end: 12, text: 'Also, choir practice moves to Thursday at 6pm.' },
      { start: 12, end: 20, text: 'Once again, the Men\'s Breakfast will be held at the Fellowship Hall.' }
    ];
    const { posters } = suggestPosters(segments);
    const breakfasts = posters.filter(p => p.title === "Men's Breakfast");
    expect(breakfasts).toHaveLength(1);
    expect(breakfasts[0]).toMatchObject({ date: 'Saturday the 4th of October', time: '8am', venue: 'the Fellowship Hall', mentions: 2 });
    expect(breakfasts[0].checks).toEqual([]);
  });

  test('event words without any details are listed separately, not as posters', () => {
    const segments = [
      { start: 0, end: 5, text: 'We had a wonderful conference last year.' },
      { start: 5, end: 9, text: 'The youth camp registration opens on 1 December; contact Brother Sipho on 072 111 2222.' }
    ];
    const { posters, otherAnnouncements } = suggestPosters(segments);
    expect(posters.map(p => p.title)).toEqual(['Youth Camp']);
    expect(posters[0].contact).toBe('Brother Sipho · 072 111 2222');
    expect(otherAnnouncements).toHaveLength(1);
    expect(otherAnnouncements[0].quote).toMatch(/conference last year/);
  });

  test('suggests timed main headlines and moving-bar lines from the posters', () => {
    const { posters } = suggestPosters(NEWS_SEGMENTS);
    const { mainHeadlines, tickerHeadlines } = suggestHeadlines(posters);
    expect(mainHeadlines.map(h => [h.text, h.start])).toEqual([
      ['Youth Conference · Saturday 18 October', 4],
      ["Women's Prayer Breakfast · next Sunday", 24],
      ['Baptism Service · 2 November', 38]
    ]);
    expect(mainHeadlines[0].quote).toMatch(/^First, the Youth Conference/);
    expect(tickerHeadlines[0]).toBe('YOUTH CONFERENCE · Saturday 18 October · 9am');
  });

  test('adds an opening headline when the first announcement comes later', () => {
    const { mainHeadlines } = suggestHeadlines([{ title: 'Choir Concert', start: 40, posterText: { headline: 'CHOIR CONCERT', lines: [] } }]);
    expect(mainHeadlines.map(h => [h.text, h.start])).toEqual([["This week's church news", 0], ['Choir Concert', 40]]);
    expect(suggestHeadlines([]).mainHeadlines).toEqual([{ text: "This week's church news", start: 0, quote: null }]);
  });

  test('empty or missing transcripts give no posters', () => {
    expect(suggestPosters([])).toEqual({ posters: [], otherAnnouncements: [] });
    expect(suggestPosters(undefined)).toEqual({ posters: [], otherAnnouncements: [] });
  });
});
