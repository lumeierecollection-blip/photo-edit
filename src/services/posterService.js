// Church News poster finder. Reads a timestamped transcript and works out
// which announcements need a poster, using plain rules (no paid AI):
//
//   1. The transcript is split into sentences, each keeping its start time.
//   2. Sentences are grouped into announcements. A new announcement starts at
//      a transition ("Next", "Also", "Finally"...) or when a different event
//      is named; follow-on sentences ("Registration is R50...") stay attached.
//   3. An announcement becomes a poster suggestion when it names an event and
//      also gives a date, time, place or way to sign up. A thank-you or a
//      general remark without any of those is not a poster.
//   4. The details (title, when, where, who, cost, contact) are pulled out of
//      the announcement's own words, and repeats of the same event (e.g. a
//      recap at the end) are merged.
//
// Everything found is a suggestion: the page lets people edit the text.

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = `(?:${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?`;
const DAY_RE = '(?:[0-3]?\\d)(?:st|nd|rd|th)?';
const ORDINAL_WORDS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|twenty-ninth|thirtieth|thirty-first';

const DATE_PATTERNS = [
  // "Saturday the 18th of October", "Saturday, 18 October"
  new RegExp(`\\b(?:(?:${WEEKDAYS.join('|')}),?\\s+)?(?:the\\s+)?(?:${DAY_RE}|${ORDINAL_WORDS})\\s+(?:of\\s+)?${MONTH_RE}(?:\\s+\\d{4})?`, 'i'),
  // "October 18th", "Saturday, October 18"
  new RegExp(`\\b(?:(?:${WEEKDAYS.join('|')}),?\\s+)?${MONTH_RE}\\s+(?:the\\s+)?${DAY_RE}(?:,?\\s+\\d{4})?\\b`, 'i'),
  // 18/10, 18/10/2026
  /\b[0-3]?\d\/[01]?\d(?:\/\d{2,4})?\b/,
  // "this coming Sunday", "next Friday", "this weekend"
  new RegExp(`\\b(?:this\\s+coming|this|next|coming)\\s+(?:${WEEKDAYS.join('|')}|week(?:end)?|month)\\b`, 'i'),
  new RegExp(`\\b(?:on\\s+)?(?:${WEEKDAYS.join('|')})s?\\b`, 'i'),
  /\b(?:today|tonight|tomorrow(?:\s+(?:morning|afternoon|evening|night))?)\b/i
];

const TIME_PATTERNS = [
  /\b(?:[01]?\d|2[0-3])(?::|h)[0-5]\d\s*(?:am|pm|a\.m\.?|p\.m\.?)?/i,
  /\b(?:1[0-2]|0?[1-9])\s*(?:am|pm|a\.m\.?|p\.m\.?)/i,
  /\b(?:at\s+)?(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+o'?clock)?\s+in\s+the\s+(?:morning|afternoon|evening)\b/i,
  /\b(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+o'?clock\b/i,
  /\b(?:at\s+)?(?:noon|midday|midnight)\b/i,
  /\b(?:after|before)\s+the\s+(?:main\s+|first\s+|second\s+|morning\s+|evening\s+)?service\b/i
];

// Words that name something a poster is made for. The number is how strongly
// the word signals an event on its own.
const EVENT_WORDS = {
  conference: 3, convention: 3, summit: 3, crusade: 3, revival: 3, camp: 3, retreat: 3,
  concert: 3, festival: 3, bazaar: 3, fundraiser: 3, 'fun day': 3, 'family day': 3, gala: 3,
  seminar: 3, workshop: 3, 'bible study': 3, baptism: 3, baptisms: 3, wedding: 3, funeral: 3,
  memorial: 3, 'dedication': 3, outreach: 3, breakfast: 2, lunch: 2, dinner: 2, braai: 2,
  picnic: 2, launch: 2, celebration: 2, anniversary: 2, graduation: 2, service: 1, meeting: 2,
  gathering: 2, fellowship: 2, rehearsal: 2, practice: 1, class: 2, classes: 2, course: 2,
  training: 2, drive: 2, market: 2, sale: 2, tournament: 2, match: 1, vigil: 3, 'all-night prayer': 3,
  'prayer night': 3, 'night of prayer': 3, 'prayer meeting': 3, fast: 1, fasting: 2, communion: 2,
  'kids church': 2, 'sunday school': 2, 'youth group': 2, 'cell group': 2, 'home group': 2,
  registration: 1, auditions: 2, 'open day': 3, 'thanksgiving': 2, 'christmas': 1, 'easter': 1
};

// Words that may sit in front of an event word and belong in its title.
const TITLE_MODIFIERS = new Set([
  'youth', 'young', 'adults', "women's", 'womens', 'women', "ladies'", 'ladies', "men's", 'mens', 'men',
  "children's", 'childrens', 'kids', 'family', 'families', 'marriage', 'couples', 'couples\'', 'singles',
  'worship', 'praise', 'prayer', 'leadership', 'leaders', 'annual', 'special', 'baptism', 'holy', 'communion',
  'easter', 'christmas', 'thanksgiving', 'revival', 'gospel', 'music', 'choir', 'sports', 'fun', 'charity',
  'food', 'blood', 'clothing', 'building', 'mission', 'missions', 'evangelism', 'healing', 'deliverance',
  'night', 'all-night', 'morning', 'evening', 'sunrise', 'watch', 'bible', 'discipleship', 'membership',
  'new', 'members', "members'", 'volunteers', 'volunteer', 'ushers', 'teens', 'teen', 'senior', 'seniors',
  'grand', 'open', 'combined', 'joint', 'mid-week', 'midweek', 'sunday', 'friday', 'saturday', 'pastors',
  'pastor\'s', 'pastoral', 'appreciation', 'dedication', 'baby', 'fundraising', 'golf', 'soccer', 'netball'
]);

const TRANSITION_RE = /^(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|next|also|then|another|lastly|finally|in addition|furthermore|moreover|and finally|on another note|moving on|we also|there will also|don't forget|do not forget|remember|a reminder|reminder|please note|notice)\b/i;
const SIGN_OFF_RE = /\b(?:god\s+bless|be\s+blessed|stay\s+blessed|have\s+a\s+(?:wonderful|blessed|great|good|lovely)\s+(?:week|day|evening|weekend|sunday)|see\s+you\s+(?:next|on|soon)|thank\s+you\s+for\s+(?:watching|listening|joining)|that'?s\s+all\s+(?:for|from))\b/i;
const CTA_RE = /\b(?:register|registration|sign\s*up|rsvp|book(?:ing)?|tickets?|enrol|enroll|apply|submit|bring|invite|contact|call|whatsapp|speak to|see|email)\b/i;
const PHONE_RE = /(?:\+27|\b0)\s?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/;
const COST_RE = /\b(?:R\s?\d[\d\s,.]*|\d[\d,.]*\s?rand|(?:[a-z]+[\s-])?(?:hundred|thousand|fifty|twenty|thirty|forty|sixty|seventy|eighty|ninety|ten|fifteen)\s+rand|free(?:\s+of\s+charge)?|no\s+charge|at\s+no\s+cost)\b/i;
const PERSON_TITLE_RE = /\b(?:(?:pastor|reverend|rev\.?|bishop|apostle|prophet|evangelist|elder|deacon|deaconess|brother|sister|mr\.?|mrs\.?|ms\.?|dr\.?|mama|baba|mom|mum|aunty|auntie|uncle)\s+(?:[A-Z][a-z'-]+)(?:\s+[A-Z][a-z'-]+)?)/;
// The lead words match in any case ("Register with…" opens a sentence); the
// name after them must be capitalised, so it is matched separately.
const CONTACT_LEAD_RE = /\b(?:contact|speak\s+to|talk\s+to|see|call|whatsapp|register\s+with|sign\s+up\s+with|get\s+in\s+touch\s+with|reach\s+out\s+to|give\s+your\s+name\s+to)\s+/gi;
const CAPITALISED_NAME_RE = /^(?:[A-Z][\w'-]*\s?){1,3}/;
const VENUE_WORDS = 'hall|auditorium|sanctuary|chapel|church|centre|center|venue|room|campus|grounds|park|school|stadium|hotel|lodge|farm|resort|offices?|building|marquee|tent|foyer|parking\\s+lot|car\\s+park|field|library|house|home';
const VENUE_RE = new RegExp(`\\b(?:at|in|inside|venue\\s+is|held\\s+at|takes\\s+place\\s+at)\\s+((?:the\\s+)?(?:[A-Za-z'-]+\\s+){0,4}?(?:${VENUE_WORDS})(?:\\s+(?:${VENUE_WORDS}))?)\\b`, 'i');
const NOT_A_PLACE_RE = /^(?:the\s+)?(?:morning|afternoon|evening|night|service|week|weekend|month)\b/i;
const AUDIENCE_RE = /\b(?:all\s+(?:the\s+)?(?:young\s+people|youth|teens?|teenagers|women|ladies|men|children|kids|parents|couples|members|leaders|volunteers|families|singles|seniors|church\s+members)(?:\s+(?:between|aged|from)\s+(?:the\s+ages\s+of\s+)?\d{1,2}\s*(?:-|to|and)\s*\d{1,2})?|everyone(?:\s+is\s+welcome)?|open\s+to\s+(?:all|everyone|the\s+public)|(?:young\s+people|children|kids|teens|youth)\s+(?:aged|between|from)\s+[\w\s-]{2,30}?(?=[,.]|$)|(?:ages?|aged|between)\s+\d{1,2}\s*(?:-|to|and)\s*\d{1,2})/i;

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** Splits timestamped segments into sentences that keep a start time. */
function toSentences(segments) {
  const parts = [];
  let buffer = '';
  let bufferStart = null;
  const flush = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text) parts.push({ start: bufferStart, text });
    buffer = '';
    bufferStart = null;
  };

  for (const seg of segments || []) {
    const pieces = String(seg.text || '').split(/(?<=[.!?])\s+(?=["'“‘(]?[A-Z0-9])/);
    const span = Math.max(0, (seg.end ?? seg.start) - seg.start);
    const totalLen = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let consumed = 0;
    pieces.forEach((piece, i) => {
      const at = seg.start + span * (consumed / totalLen);
      consumed += piece.length;
      if (bufferStart === null) bufferStart = at;
      buffer += ` ${piece}`;
      const endsSentence = /[.!?]["'”’)]?$/.test(piece.trim());
      if (endsSentence && (i < pieces.length - 1 || true)) flush();
    });
  }
  flush();
  return parts.map(p => ({ start: Math.round((p.start || 0) * 100) / 100, text: p.text }));
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function firstMatch(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

function allDateMatches(text) {
  // The most specific patterns come first; once one matches, weaker patterns
  // that only repeat part of it (e.g. the weekday) are ignored.
  const found = [];
  for (const re of DATE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const value = m[0].trim();
      if (!found.some(f => f.toLowerCase().includes(value.toLowerCase()))) found.push(value);
    }
  }
  return found;
}

function eventWordsIn(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const [word, weight] of Object.entries(EVENT_WORDS)) {
    const re = new RegExp(`\\b${word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    const m = lower.match(re);
    if (m) found.push({ word, weight, index: m.index });
  }
  // Prefer the longest, then heaviest, match at each position ("prayer
  // meeting" over "meeting").
  found.sort((a, b) => b.word.length - a.word.length || b.weight - a.weight);
  const kept = [];
  for (const f of found) {
    if (!kept.some(k => f.index >= k.index && f.index < k.index + k.word.length)) kept.push(f);
  }
  return kept.sort((a, b) => a.index - b.index);
}

function analyzeSentence(sentence) {
  const text = sentence.text;
  const events = eventWordsIn(text);
  return {
    ...sentence,
    events,
    eventScore: events.reduce((n, e) => n + e.weight, 0),
    dates: allDateMatches(text),
    time: firstMatch(TIME_PATTERNS, text),
    venue: extractVenue(text),
    phone: (text.match(PHONE_RE) || [null])[0],
    cost: (text.match(COST_RE) || [null])[0],
    person: extractContactPerson(text),
    audience: (text.match(AUDIENCE_RE) || [null])[0],
    cta: CTA_RE.test(text),
    signOff: SIGN_OFF_RE.test(text) && events.length === 0,
    transition: TRANSITION_RE.test(text.replace(/^[^A-Za-z]+/, ''))
  };
}

function extractVenue(text) {
  const m = text.match(VENUE_RE);
  if (!m) return null;
  // "at 7 in the morning in the church hall": keep only the part after the
  // last "in"/"at", and never treat a time of day as a place.
  const venue = m[1].trim().split(/\s+(?:in|at)\s+/i).pop();
  if (NOT_A_PLACE_RE.test(venue)) return null;
  return venue.replace(/^the\s+/i, 'the ');
}

function extractContactPerson(text) {
  for (const lead of text.matchAll(CONTACT_LEAD_RE)) {
    const rest = text.slice(lead.index + lead[0].length);
    const named = rest.match(CAPITALISED_NAME_RE);
    if (!named) continue;
    const titled = rest.match(PERSON_TITLE_RE);
    const name = (titled && titled.index === 0 ? titled[0] : named[0]).trim().replace(/\s+(?:on|at|or|and)$/i, '');
    if (!/^(?:the|our|your|us|me|him|her|them|I)$/i.test(name)) return name;
  }
  const titled = text.match(PERSON_TITLE_RE);
  return titled && CTA_RE.test(text) ? titled[0].trim() : null;
}

// ---------------------------------------------------------------------------
// Grouping into announcements
// ---------------------------------------------------------------------------

const MAX_GAP_SECONDS = 40;

function groupAnnouncements(sentences) {
  const groups = [];
  let current = null;

  for (const s of sentences) {
    const namesNewEvent = s.eventScore >= 2 && current && current.events.length > 0
      && !s.events.some(e => current.events.some(c => c.word === e.word));
    const startNew = !current
      || s.transition
      || s.signOff
      || current.signOff
      || namesNewEvent
      || (s.start - current.lastStart > MAX_GAP_SECONDS)
      || (current.events.length === 0 && s.eventScore >= 2);

    if (startNew) {
      current = { sentences: [], events: [], lastStart: s.start, signOff: s.signOff };
      groups.push(current);
    }
    current.sentences.push(s);
    current.lastStart = s.start;
    for (const e of s.events) {
      if (!current.events.some(c => c.word === e.word)) current.events.push(e);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Poster details
// ---------------------------------------------------------------------------

function titleCase(words) {
  const small = new Set(['of', 'and', 'the', 'for', 'in', 'on', 'at', 'a', 'to']);
  return words
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Builds a title from the main event word plus the words in front of it that
 * describe it: "our Women's Prayer Breakfast" → "Women's Prayer Breakfast".
 */
function buildTitle(sentence, event) {
  const text = sentence.text;
  const lower = text.toLowerCase();
  const at = lower.indexOf(event.word);
  if (at < 0) return titleCase(event.word.split(' '));

  const before = text.slice(0, at).trim().split(/\s+/).filter(Boolean);
  const eventWords = text.slice(at, at + event.word.length).split(/\s+/);
  const lead = [];
  for (let i = before.length - 1; i >= 0 && lead.length < 4; i--) {
    const raw = before[i];
    if (/[.,;:!?]$/.test(raw)) break;
    const clean = raw.replace(/[^\w'-]/g, '');
    const isName = /^[A-Z][a-z'-]+$/.test(clean) && i > 0 && !/^(?:The|Our|This|That|A|An|Next|First|Also|Finally|And|We|Please)$/.test(clean);
    if (TITLE_MODIFIERS.has(clean.toLowerCase()) || isName) lead.unshift(clean);
    else break;
  }
  // "baptism service": a following event word is part of the name.
  const after = text.slice(at + event.word.length).match(/^\s+([A-Za-z'-]+)/);
  if (after && EVENT_WORDS[after[1].toLowerCase()] && !/^(?:registration|practice|match|fast)$/i.test(after[1])) {
    eventWords.push(after[1]);
  }
  return titleCase([...lead, ...eventWords]);
}

function pickMainEvent(group) {
  // The heaviest event word wins; ties go to the first one mentioned.
  let best = null;
  for (const s of group.sentences) {
    for (const e of s.events) {
      if (!best || e.weight > best.event.weight) best = { event: e, sentence: s };
    }
  }
  return best;
}

function firstOf(group, key) {
  for (const s of group.sentences) {
    const v = s[key];
    if (Array.isArray(v) ? v.length : v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function tidyValue(v) {
  if (!v) return null;
  return v.replace(/\s+/g, ' ').replace(/[,.;:]+$/, '').trim();
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** "at 7 in the morning" → "7am". Anything else is kept as it was said. */
function normalizeTime(time) {
  let t = tidyValue(time);
  if (!t) return null;
  t = t.replace(/^at\s+/i, '');
  const spoken = t.match(/^(\w+)(?:\s+o'?clock)?\s+in\s+the\s+(morning|afternoon|evening)$/i);
  if (spoken) {
    const n = NUMBER_WORDS[spoken[1].toLowerCase()] || Number(spoken[1]);
    if (n) return `${n}${spoken[2].toLowerCase() === 'morning' ? 'am' : 'pm'}`;
  }
  return t.replace(/\s*a\.?m\.?$/i, 'am').replace(/\s*p\.?m\.?$/i, 'pm');
}

/** "50 Rand" → "R50". Anything else ("free of charge") is kept as said. */
function normalizeCost(cost) {
  const c = tidyValue(cost);
  if (!c) return null;
  const m = c.match(/^(\d[\d,.]*)\s?rand$/i);
  return m ? `R${m[1]}` : c.replace(/^R\s+/, 'R');
}

// Dates people must pin down before a poster is printed.
const RELATIVE_DATE_RE = /^(?:(?:this\s+coming|this|next|coming)\s+\w+|on\s+\w+|\w+days?|today|tonight|tomorrow.*)$/i;

function describeWhen(date, time) {
  const d = tidyValue(date);
  const t = normalizeTime(time);
  if (d && t) return `${d} · ${t}`;
  return d || t || null;
}

function toSuggestion(group) {
  const main = pickMainEvent(group);
  if (!main) return null;

  const date = firstOf(group, 'dates');
  const time = firstOf(group, 'time');
  const venue = firstOf(group, 'venue');
  const phone = firstOf(group, 'phone');
  const person = firstOf(group, 'person');
  const cost = firstOf(group, 'cost');
  const audience = firstOf(group, 'audience');
  const cta = group.sentences.some(s => s.cta);

  const detailCount = [date, time, venue, phone || person, cost, cta ? 1 : null].filter(Boolean).length;
  const strong = main.event.weight >= 2;
  // A single weak word like "service" needs more supporting detail.
  if (detailCount === 0 || (!strong && detailCount < 2)) return null;

  const confidence = (date && (time || venue)) || detailCount >= 3 ? 'high' : 'medium';
  const checks = [];
  if (!date) checks.push('No date was mentioned: add the date before printing.');
  else if (RELATIVE_DATE_RE.test(tidyValue(date))) checks.push(`The date was said as "${tidyValue(date)}": write the exact date on the poster.`);
  if (!time) checks.push('No time was mentioned.');
  if (!venue) checks.push('No venue was mentioned.');
  const title = buildTitle(main.sentence, main.event);
  const contact = [tidyValue(person), tidyValue(phone)].filter(Boolean).join(' · ') || null;

  const posterLines = [
    describeWhen(date, time),
    tidyValue(venue) ? titleCase(tidyValue(venue).replace(/^the\s+/i, '').split(' ')) : null,
    tidyValue(audience) ? sentenceCase(tidyValue(audience)) : null,
    normalizeCost(cost) ? `Cost: ${normalizeCost(cost)}` : null,
    contact ? `Contact: ${contact}` : null
  ].filter(Boolean);

  return {
    title,
    when: describeWhen(date, time),
    date: tidyValue(date),
    time: normalizeTime(time),
    venue: tidyValue(venue),
    audience: tidyValue(audience),
    cost: normalizeCost(cost),
    contact,
    confidence,
    checks,
    posterText: { headline: title.toUpperCase(), lines: posterLines },
    quote: group.sentences.map(s => s.text).join(' '),
    start: group.sentences[0].start
  };
}

function sentenceCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z]/g, '');
}

/** Merges repeats of the same event, keeping the first mention's position. */
function mergeDuplicates(suggestions) {
  const byTitle = new Map();
  const out = [];
  for (const s of suggestions) {
    const key = normalizeTitle(s.title);
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, s);
      out.push(s);
      continue;
    }
    for (const field of ['date', 'time', 'venue', 'audience', 'cost', 'contact']) {
      if (!existing[field] && s[field]) existing[field] = s[field];
    }
    existing.when = describeWhen(existing.date, existing.time);
    existing.checks = existing.checks.filter(c =>
      !(c.startsWith('No date') && existing.date) && !(c.startsWith('No time') && existing.time) && !(c.startsWith('No venue') && existing.venue));
    existing.quote += ` … ${s.quote}`;
    existing.mentions = (existing.mentions || 1) + 1;
    if (s.confidence === 'high') existing.confidence = 'high';
  }
  return out;
}

/**
 * Returns { posters: [...], otherAnnouncements: [...] } for a transcript's
 * segments. otherAnnouncements are event-like mentions that did not carry
 * enough detail for a poster, so people can decide for themselves.
 */
function suggestPosters(segments) {
  const sentences = toSentences(segments).map(analyzeSentence);
  const groups = groupAnnouncements(sentences);
  const posters = [];
  const otherAnnouncements = [];

  for (const group of groups) {
    const suggestion = toSuggestion(group);
    if (suggestion) posters.push(suggestion);
    else if (group.events.length) {
      otherAnnouncements.push({ quote: group.sentences.map(s => s.text).join(' '), start: group.sentences[0].start });
    }
  }

  const merged = mergeDuplicates(posters).map((p, i) => ({ id: `p${i + 1}`, ...p }));
  return { posters: merged, otherAnnouncements };
}

const OPENING_HEADLINE = 'This week\'s church news';

/**
 * Suggests the news studio's headlines from the (possibly edited) posters:
 *   mainHeadlines: the big bar, one per announcement, each from the moment it
 *     is first spoken, after an opening headline at the start.
 *   tickerHeadlines: the smaller moving bar, one line per poster.
 * Each main headline carries the words it came from, so people can check it
 * against the video before rendering.
 */
function suggestHeadlines(posters) {
  const list = (posters || []).filter(p => p && p.posterText && p.posterText.headline);
  const byTime = [...list].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));

  const mainHeadlines = [];
  const firstStart = byTime.length && Number.isFinite(byTime[0].start) ? byTime[0].start : Infinity;
  if (firstStart > 8) mainHeadlines.push({ text: OPENING_HEADLINE, start: 0, quote: null });
  for (const p of byTime) {
    const when = p.posterText.lines && p.posterText.lines[0];
    const date = p.date || (when && when.split(' · ')[0]);
    // The title reads better ("Youth Conference"), but an edited headline
    // wins, since it is what the church actually wants to say.
    const edited = String(p.title || '').toUpperCase() !== p.posterText.headline.toUpperCase();
    mainHeadlines.push({
      text: [edited || !p.title ? p.posterText.headline : p.title, date].filter(Boolean).join(' · ').slice(0, 90),
      start: Number.isFinite(p.start) ? Math.max(0, Math.round(p.start)) : 0,
      quote: p.quote || null
    });
  }
  if (!mainHeadlines.length) mainHeadlines.push({ text: OPENING_HEADLINE, start: 0, quote: null });

  const tickerHeadlines = list.map(p => {
    const [first] = p.posterText.lines || [];
    return [p.posterText.headline, first].filter(Boolean).join(' · ').slice(0, 160);
  });
  return { mainHeadlines, tickerHeadlines };
}

module.exports = {
  suggestPosters,
  suggestHeadlines,
  toSentences,
  analyzeSentence,
  groupAnnouncements,
  buildTitle
};
