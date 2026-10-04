import React from 'react';
import {Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {StudioPalette} from './StudioBackground';
import {NEWS_FONT} from './Graphics';

/**
 * Full-screen explainer cards that cover the presenter while a topic is
 * spoken. His voice carries on underneath, so nothing on screen has to line
 * up with his lips.
 */
export type BrollKind = 'image' | 'people' | 'closing' | 'month' | 'calendar' | 'date' | 'steps' | 'twocol' | 'contact' | 'notice';

/** Highlights these days of the month from `at` seconds into the video. */
export type CalendarMark = {days: number[]; at: number};

export type BrollCue = {
  kind: BrollKind;
  /** Seconds into the video. */
  start: number;
  end: number;
  /** image: the poster, as an http:// address. */
  src?: string;
  eyebrow?: string;
  title: string;
  /** The big thing on a date card: "TODAY", a time. */
  big?: string;
  sub?: string;
  sub2?: string;
  subIcon?: 'clock' | 'church' | 'people' | 'pin';
  sub2Icon?: 'clock' | 'church' | 'people' | 'pin';
  /** steps: the steps in order. */
  items?: string[];
  /** steps: seconds into the video when each step is spoken (lights it up). */
  stepTimes?: number[];
  columns?: {heading: string; detail: string}[];
  /** closing: big typography, each line landing at `at` seconds. */
  lines?: {text: string; at: number; size: 'm' | 'xl'}[];
  /** month: events outlined on the calendar, each appearing at `at` seconds. */
  events?: {label: string; date: string; days: number[]; at: number}[];
  /** month: a weekly event, shown as small dots under these weekdays (0 = Sunday). */
  recurring?: {label: string; date: string; weekdays: number[]; at: number};
  /** people: portrait cutouts (transparent PNG, http:// address), each landing at `at` seconds. */
  people?: {name: string; src: string; at: number}[];
  /** calendar: which month to draw. month is 1-12. */
  month?: {year: number; month: number};
  /** calendar: which days to highlight, and when. A later mark moves the highlight on. */
  marks?: CalendarMark[];
};

const EASE_FRAMES = 8;

/** 0 = no card, 1 = card fully in; eases in and out at the cue edges. */
export const brollProgress = (cues: BrollCue[], seconds: number, fps: number) => {
  const ease = EASE_FRAMES / fps;
  let best: {cue: BrollCue; p: number} | null = null;
  for (const cue of cues) {
    if (seconds < cue.start || seconds > cue.end) continue;
    // Next to another cue, stay "in" rather than easing out and back in.
    const prev = cues.find(c => c !== cue && Math.abs(c.end - cue.start) < 0.05);
    const next = cues.find(c => c !== cue && Math.abs(c.start - cue.end) < 0.05);
    const pIn = prev ? 1 : interpolate(seconds, [cue.start, cue.start + ease], [0, 1], {extrapolateRight: 'clamp'});
    const pOut = next ? 1 : interpolate(seconds, [cue.end - ease, cue.end], [1, 0], {extrapolateLeft: 'clamp'});
    const p = Math.min(pIn, pOut);
    if (!best || p >= best.p) best = {cue, p};
  }
  return best;
};

const BG = '#0e2246';
const INK = '#f4f6fb';
const MUTED = 'rgba(244,246,251,0.62)';
const LINE = 'rgba(244,246,251,0.22)';

// ---------------------------------------------------------------------------
// Motion helpers
// ---------------------------------------------------------------------------

type Ctx = {s: number; cal: number; palette: StudioPalette; fps: number; cueFrame: number; seconds: number; landscape: boolean};

/** Eases out and settles almost without overshoot: animated, not playful. */
const settle = (ctx: Ctx, delay: number) =>
  spring({frame: ctx.cueFrame - delay, fps: ctx.fps, config: {damping: 20, stiffness: 140, mass: 0.9}});

const rise = (ctx: Ctx, delay: number) => {
  const t = settle(ctx, delay);
  return {opacity: interpolate(t, [0, 0.35], [0, 1], {extrapolateRight: 'clamp'}), transform: `translateY(${(1 - t) * 34 * ctx.s}px)`};
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const Icon: React.FC<{name: 'clock' | 'phone-off' | 'church' | 'people' | 'pin'; size: number; color: string}> = ({name, size, color}) => {
  const common = {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  switch (name) {
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
    case 'phone-off':
      return <svg {...common}><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M10.5 18.5h3M3 3l18 18" /></svg>;
    case 'church':
      return <svg {...common}><path d="M12 2v5M9.5 4.5h5M5 21V11l7-4 7 4v10zM10 21v-5h4v5" /></svg>;
    case 'people':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.4" /><path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6M15.5 14.4c3 0 5.5 1.8 5.5 5" /></svg>;
    case 'pin':
      return <svg {...common}><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
  }
};

const Eyebrow: React.FC<{ctx: Ctx; text?: string; nowrap?: boolean}> = ({ctx, text, nowrap}) =>
  text ? (
    <div style={{...rise(ctx, 0), fontSize: 20 * ctx.s, letterSpacing: 4 * ctx.s, fontWeight: 700, color: ctx.palette.accent, textTransform: 'uppercase', whiteSpace: nowrap ? 'nowrap' : undefined}}>
      {text}
    </div>
  ) : null;

const Title: React.FC<{ctx: Ctx; text: string}> = ({ctx, text}) => (
  <div style={{...rise(ctx, 3), fontSize: 50 * ctx.s, lineHeight: 1.05, fontWeight: 800, color: INK}}>{text}</div>
);

const Big: React.FC<{ctx: Ctx; text?: string}> = ({ctx, text}) =>
  text ? (
    <div style={{...rise(ctx, 7), fontSize: (text.length > 8 ? 96 : 130) * ctx.s, lineHeight: 1, fontWeight: 900, color: INK, whiteSpace: 'nowrap'}}>
      {text}
    </div>
  ) : null;

const Sub: React.FC<{ctx: Ctx; text?: string; delay: number; icon?: Parameters<typeof Icon>[0]['name']}> = ({ctx, text, delay, icon}) =>
  text ? (
    <div style={{...rise(ctx, delay), display: 'flex', alignItems: 'center', gap: 12 * ctx.s, fontSize: 28 * ctx.s, fontWeight: 600, color: INK}}>
      {icon ? <Icon name={icon} size={30 * ctx.s} color={ctx.palette.accent} /> : null}
      {text}
    </div>
  ) : null;

// --- Calendar --------------------------------------------------------------

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const CELL_W = 76;
const CELL_H = 62;
const HEAD_H = 36;

type MonthEvents = {events?: BrollCue['events']; recurring?: BrollCue['recurring']};

const Calendar: React.FC<{ctx: Ctx; year: number; month: number; marks: CalendarMark[]; zoom?: number} & MonthEvents> = ({ctx, year, month, marks, events, recurring, zoom = 1}) => {
  const c = ctx.cal * zoom;
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = Math.ceil((firstWeekday + daysInMonth) / 7);
  const cellPos = (day: number) => {
    const slot = firstWeekday + day - 1;
    return {x: (slot % 7) * CELL_W * c, y: HEAD_H * c + Math.floor(slot / 7) * CELL_H * c};
  };

  // Which mark is current, and which was before it.
  let activeIdx = -1;
  marks.forEach((m, i) => {
    if (ctx.seconds >= m.at) activeIdx = i;
  });
  const active = activeIdx >= 0 ? marks[activeIdx] : null;
  const prior = activeIdx > 0 ? marks[activeIdx - 1] : null;
  const sinceFrame = active ? Math.round((ctx.seconds - active.at) * ctx.fps) : 0;
  // A steady eased glide, so the ring visibly travels down the column.
  const slideT = active
    ? interpolate(sinceFrame, [0, Math.round(ctx.fps * 0.7)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic)})
    : 0;

  const highlighted = new Set(active ? active.days : []);
  const gridIn = settle(ctx, 4);

  return (
    <div style={{width: 7 * CELL_W * c, flex: 'none', opacity: interpolate(gridIn, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'}), transform: `translateY(${(1 - gridIn) * 40 * ctx.s}px)`}}>
      <div style={{fontSize: 34 * c, fontWeight: 800, color: INK, marginBottom: 14 * c, letterSpacing: 1 * c}}>
        {MONTHS[month - 1]} {year}
      </div>
      <div style={{position: 'relative', height: HEAD_H * c + rows * CELL_H * c, borderTop: `${2 * c}px solid ${LINE}`}}>
        {WEEKDAYS.map((d, i) => (
          <div
            key={d}
            style={{position: 'absolute', left: i * CELL_W * c, top: 0, width: CELL_W * c, height: HEAD_H * c, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 * c, fontWeight: 700, letterSpacing: 2 * c, color: i === 0 ? ctx.palette.accent : MUTED}}
          >
            {d}
          </div>
        ))}
        {Array.from({length: daysInMonth}, (_, i) => i + 1).map(day => {
          const p = cellPos(day);
          const on = highlighted.has(day);
          return (
            <div
              key={day}
              style={{position: 'absolute', left: p.x, top: p.y, width: CELL_W * c, height: CELL_H * c, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 * c, fontWeight: on ? 900 : 600, color: on ? INK : 'rgba(244,246,251,0.7)', borderTop: `${1 * c}px solid ${LINE}`}}
            >
              {day}
            </div>
          );
        })}
        {/* Weekly event: small dots under its weekdays. */}
        {recurring
          ? Array.from({length: daysInMonth}, (_, i) => i + 1)
              .filter(day => recurring.weekdays.includes((firstWeekday + day - 1) % 7))
              .map(day => {
                const p = cellPos(day);
                const t = ctx.seconds < recurring.at ? 0 : spring({frame: Math.round((ctx.seconds - recurring.at) * ctx.fps), fps: ctx.fps, config: {damping: 20, stiffness: 140, mass: 0.9}});
                return <div key={`dot-${day}`} style={{position: 'absolute', left: p.x + CELL_W * c / 2 - 3.5 * c, top: p.y + CELL_H * c - 14 * c, width: 7 * c, height: 7 * c, borderRadius: '50%', background: ctx.palette.accent, opacity: t, transform: `scale(${t})`}} />;
              })
          : null}
        {/* Dated events: one outline each (a run of days in a row is one joined outline). */}
        {(events || []).flatMap((ev, ei) => {
          const days = [...ev.days].sort((a, b) => a - b);
          const runs: number[][] = [];
          days.forEach(d => {
            const last = runs[runs.length - 1];
            const sameRow = last && Math.floor((firstWeekday + last[last.length - 1] - 1) / 7) === Math.floor((firstWeekday + d - 1) / 7);
            if (last && last[last.length - 1] === d - 1 && sameRow) last.push(d);
            else runs.push([d]);
          });
          const t = ctx.seconds < ev.at ? 0 : spring({frame: Math.round((ctx.seconds - ev.at) * ctx.fps), fps: ctx.fps, config: {damping: 20, stiffness: 150, mass: 0.9}});
          return runs.map((run, ri) => {
            const a = cellPos(run[0]);
            const b = cellPos(run[run.length - 1]);
            return (
              <div
                key={`ev-${ei}-${ri}`}
                style={{position: 'absolute', left: a.x, top: a.y, width: b.x - a.x + CELL_W * c, height: CELL_H * c, boxSizing: 'border-box', border: `${3.5 * c}px solid ${ctx.palette.accent}`, borderRadius: 10 * c, background: 'rgba(90,163,232,0.14)', opacity: Math.min(1, t * 2), transform: `scale(${0.88 + 0.12 * t})`}}
              />
            );
          });
        })}
        {/* The highlight travels from where it was to where it is now. */}
        {active
          ? active.days.map((day, i) => {
              const to = cellPos(day);
              const fromDay = prior ? (prior.days[i] ?? prior.days[prior.days.length - 1]) : day;
              const from = cellPos(fromDay);
              const x = from.x + (to.x - from.x) * slideT;
              const y = from.y + (to.y - from.y) * slideT;
              const born = prior && prior.days[i] !== undefined ? 1 : spring({frame: sinceFrame - i * 3, fps: ctx.fps, config: {damping: 20, stiffness: 160, mass: 0.8}});
              return (
                <div
                  key={i}
                  style={{position: 'absolute', left: x, top: y, width: CELL_W * c, height: CELL_H * c, boxSizing: 'border-box', border: `${4 * c}px solid ${ctx.palette.accent}`, borderRadius: 10 * c, background: 'rgba(90,163,232,0.28)', transform: `scale(${0.6 + 0.4 * born})`, opacity: Math.min(1, born * 2)}}
                />
              );
            })
          : null}
      </div>
    </div>
  );
};

// --- Steps -----------------------------------------------------------------

const Steps: React.FC<{ctx: Ctx; items: string[]; times: number[]}> = ({ctx, items, times}) => {
  let current = -1;
  times.forEach((t, i) => {
    if (ctx.seconds >= t) current = i;
  });
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22 * ctx.s}}>
      {items.map((text, i) => {
        const t = settle(ctx, 8 + i * 5);
        const lit = i <= current;
        const isNow = i === current;
        const pop = lit ? spring({frame: Math.round((ctx.seconds - times[i]) * ctx.fps), fps: ctx.fps, config: {damping: 20, stiffness: 160, mass: 0.8}}) : 0;
        return (
          <div key={text} style={{display: 'flex', alignItems: 'center', gap: 22 * ctx.s, opacity: interpolate(t, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'}) * (lit || current < 0 ? 1 : 0.45), transform: `translateX(${(1 - t) * 50 * ctx.s}px)`}}>
            <div
              style={{width: 64 * ctx.s, height: 64 * ctx.s, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 * ctx.s, fontWeight: 900, background: isNow ? ctx.palette.accent : 'transparent', color: isNow ? BG : INK, border: `${3 * ctx.s}px solid ${lit ? ctx.palette.accent : LINE}`, transform: `scale(${isNow ? 0.85 + 0.15 * pop : 1})`}}
            >
              {i + 1}
            </div>
            <div style={{fontSize: 38 * ctx.s, fontWeight: isNow ? 800 : 600, color: INK}}>{text}</div>
          </div>
        );
      })}
    </div>
  );
};

// --- Two columns -----------------------------------------------------------

const TwoCol: React.FC<{ctx: Ctx; columns: {heading: string; detail: string}[]}> = ({ctx, columns}) => (
  <div style={{display: 'flex', gap: 24 * ctx.s}}>
    {columns.map((col, i) => {
      const t = settle(ctx, 8 + i * 6);
      return (
        <div key={col.heading} style={{flex: 1, opacity: interpolate(t, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'}), transform: `translateY(${(1 - t) * 40 * ctx.s}px)`, padding: `${22 * ctx.s}px 0`, borderTop: `${4 * ctx.s}px solid ${ctx.palette.accent}`}}>
          <div style={{fontSize: 22 * ctx.s, fontWeight: 700, color: MUTED, letterSpacing: 2 * ctx.s, textTransform: 'uppercase'}}>{col.heading}</div>
          <div style={{fontSize: 80 * ctx.s, fontWeight: 900, color: INK, marginTop: 8 * ctx.s, lineHeight: 1}}>{col.detail}</div>
        </div>
      );
    })}
  </div>
);

// --- Portraits -------------------------------------------------------------

const DISC = '#1d3a70';

/** One portrait cutout on a flat disc: the head rises above it, the body is cut by its edge. */
const Portrait: React.FC<{ctx: Ctx; name: string; src: string; at: number}> = ({ctx, name, src, at}) => {
  const since = Math.round((ctx.seconds - at) * ctx.fps);
  const t = since < 0 ? 0 : spring({frame: since, fps: ctx.fps, config: {damping: 20, stiffness: 150, mass: 0.9}});
  const w = (ctx.landscape ? 255 : 250) * ctx.s;
  const id = `clip-${name}`;
  return (
    <div style={{width: w, opacity: interpolate(t, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'}), transform: `translateY(${(1 - t) * 44 * ctx.s}px) scale(${0.94 + 0.06 * t})`}}>
      <svg viewBox="0 0 640 770" width={w} height={w * 770 / 640} style={{display: 'block', overflow: 'visible'}}>
        <defs>
          <clipPath id={id}>
            <circle cx="320" cy="450" r="300" />
            <rect x="0" y="0" width="640" height="450" />
          </clipPath>
        </defs>
        <circle cx="320" cy="450" r="300" fill={DISC} />
        <image href={src} x="0" y="50" width="640" height="720" clipPath={`url(#${id})`} preserveAspectRatio="xMidYMax meet" />
      </svg>
      <div style={{textAlign: 'center', fontSize: 38 * ctx.s, fontWeight: 800, color: INK, marginTop: 8 * ctx.s}}>{name}</div>
    </div>
  );
};

// --- Phone ban -------------------------------------------------------------

/** Ring and phone ease in together, then the slash swipes across in one quick pass. */
const PhoneBan: React.FC<{ctx: Ctx; size: number}> = ({ctx, size}) => {
  const f = ctx.cueFrame;
  const inT = spring({frame: f, fps: ctx.fps, config: {damping: 20, stiffness: 140, mass: 0.9}});
  const swipe = interpolate(f, [20, 30], [0, 200], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const accent = ctx.palette.accent;
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} style={{flex: 'none'}}>
      <defs>
        <clipPath id="ban-swipe">
          <rect x="0" y="0" width={swipe} height="200" />
        </clipPath>
      </defs>
      <g opacity={interpolate(inT, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'})} transform={`translate(0 ${(1 - inT) * 16})`}>
        <circle cx="100" cy="100" r="88" fill="none" stroke={accent} strokeWidth="9" />
        <rect x="70" y="46" width="60" height="108" rx="11" fill="none" stroke={INK} strokeWidth="7" />
        <path d="M91 138h18" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      </g>
      <path d="M44 44 L156 156" fill="none" stroke={accent} strokeWidth="11" strokeLinecap="round" clipPath="url(#ban-swipe)" />
    </svg>
  );
};

// --- Closing typography ----------------------------------------------------

/**
 * The sign-off as a scroll: each phrase rolls up into place from below an
 * invisible edge, and the lines already there move up to make room, so the
 * block stays centred as it grows. The key phrase is the biggest thing on screen.
 */
const Closing: React.FC<{ctx: Ctx; lines: NonNullable<BrollCue['lines']>}> = ({ctx, lines}) => {
  const heightOf = (size: 'm' | 'xl') => (size === 'xl' ? 140 : 76) * ctx.s;
  const gap = 8 * ctx.s;
  // 0 -> 1 as each line scrolls in; eased out so it glides to a stop.
  const progress = lines.map(line => interpolate(ctx.seconds, [line.at, line.at + 0.7], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)}));
  const total = lines.reduce((sum, line, i) => sum + progress[i] * (heightOf(line.size) + gap), 0);
  let consumed = 0;
  return (
    <div style={{position: 'relative', width: '100%', height: 520 * ctx.s}}>
      {lines.map((line, i) => {
        const h = heightOf(line.size);
        const top = -total / 2 + consumed;
        consumed += progress[i] * (h + gap);
        const xl = line.size === 'xl';
        return (
          <div key={line.text} style={{position: 'absolute', left: 0, right: 0, top: `calc(50% + ${top}px)`, height: h, overflow: 'hidden', textAlign: 'center'}}>
            <div
              style={{
                transform: `translateY(${(1 - progress[i]) * 105}%)`,
                fontSize: (xl ? 110 : 56) * ctx.s,
                lineHeight: `${h}px`,
                fontWeight: xl ? 900 : 700,
                letterSpacing: xl ? -1 * ctx.s : 0,
                color: xl ? INK : 'rgba(244,246,251,0.82)',
                whiteSpace: 'nowrap',
              }}
            >
              {line.text}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// --- Month overview legend -------------------------------------------------

const MonthLegend: React.FC<{ctx: Ctx; cue: BrollCue}> = ({ctx, cue}) => {
  const rows = [...(cue.events || []).map(e => ({date: e.date, label: e.label, at: e.at})), ...(cue.recurring ? [{date: cue.recurring.date, label: cue.recurring.label, at: cue.recurring.at}] : [])].sort((a, b) => a.at - b.at);
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 18 * ctx.s}}>
      <Eyebrow ctx={ctx} text={cue.eyebrow} />
      <Title ctx={ctx} text={cue.title} />
      <div style={{display: 'flex', flexDirection: 'column', gap: 14 * ctx.s, marginTop: 6 * ctx.s}}>
        {rows.map(r => {
          const since = Math.round((ctx.seconds - r.at) * ctx.fps);
          const t = since < 0 ? 0 : spring({frame: since, fps: ctx.fps, config: {damping: 20, stiffness: 140, mass: 0.9}});
          return (
            <div key={r.label + r.date} style={{display: 'flex', alignItems: 'baseline', gap: 14 * ctx.s, opacity: interpolate(t, [0, 0.4], [0, 1], {extrapolateRight: 'clamp'}), transform: `translateX(${(1 - t) * 30 * ctx.s}px)`}}>
              <div style={{width: 118 * ctx.s, flex: 'none', fontSize: 22 * ctx.s, fontWeight: 800, color: ctx.palette.accent, whiteSpace: 'nowrap'}}>{r.date}</div>
              <div style={{fontSize: 23 * ctx.s, fontWeight: 600, color: INK, whiteSpace: 'nowrap'}}>{r.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const TextStack: React.FC<{cue: BrollCue; ctx: Ctx}> = ({cue, ctx}) => {
  // The second line waits for the first highlight, so it lands as it's said.
  const firstMark = cue.marks && cue.marks.length ? cue.marks[0].at : null;
  const sub2Delay = firstMark === null ? 12 : Math.max(0, Math.round((firstMark - cue.start) * ctx.fps) - 6);
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 20 * ctx.s}}>
      <Eyebrow ctx={ctx} text={cue.eyebrow} />
      <Title ctx={ctx} text={cue.title} />
      <Sub ctx={ctx} text={cue.sub} delay={8} icon={cue.subIcon || 'clock'} />
      <Sub ctx={ctx} text={cue.sub2} delay={sub2Delay} icon={cue.sub2Icon || 'pin'} />
    </div>
  );
};

const CardBody: React.FC<{cue: BrollCue; ctx: Ctx}> = ({cue, ctx}) => {
  switch (cue.kind) {
    case 'calendar': {
      const month = cue.month || {year: new Date().getFullYear(), month: new Date().getMonth() + 1};
      return (
        <div style={{display: 'flex', flexDirection: ctx.landscape ? 'row' : 'column', alignItems: ctx.landscape ? 'center' : 'flex-start', justifyContent: 'space-between', gap: (ctx.landscape ? 40 : 36) * ctx.s}}>
          <TextStack cue={cue} ctx={ctx} />
          <Calendar ctx={ctx} year={month.year} month={month.month} marks={cue.marks || []} />
        </div>
      );
    }
    case 'closing':
      return <Closing ctx={ctx} lines={cue.lines || []} />;
    case 'month': {
      const month = cue.month || {year: new Date().getFullYear(), month: new Date().getMonth() + 1};
      return (
        <div style={{display: 'flex', flexDirection: ctx.landscape ? 'row' : 'column', alignItems: ctx.landscape ? 'center' : 'flex-start', justifyContent: 'space-between', gap: (ctx.landscape ? 36 : 30) * ctx.s}}>
          <MonthLegend ctx={ctx} cue={cue} />
          <Calendar ctx={ctx} year={month.year} month={month.month} marks={[]} events={cue.events} recurring={cue.recurring} zoom={0.9} />
        </div>
      );
    }
    case 'steps':
      return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 34 * ctx.s}}>
          <Eyebrow ctx={ctx} text={cue.eyebrow} />
          <Title ctx={ctx} text={cue.title} />
          <Steps ctx={ctx} items={cue.items || []} times={cue.stepTimes || []} />
        </div>
      );
    case 'twocol':
      return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 30 * ctx.s}}>
          <Eyebrow ctx={ctx} text={cue.eyebrow} />
          <Title ctx={ctx} text={cue.title} />
          <TwoCol ctx={ctx} columns={cue.columns || []} />
          <Sub ctx={ctx} text={cue.sub} delay={22} />
        </div>
      );
    case 'people':
      return (
        <div style={{display: 'flex', flexDirection: ctx.landscape ? 'row' : 'column', alignItems: 'center', justifyContent: 'space-between', gap: 36 * ctx.s}}>
          <div style={{display: 'flex', flexDirection: 'column', gap: 20 * ctx.s, flex: 'none', alignSelf: ctx.landscape ? 'center' : 'flex-start'}}>
            <Eyebrow ctx={ctx} text={cue.eyebrow} nowrap />
            <Title ctx={ctx} text={cue.title} />
          </div>
          <div style={{display: 'flex', gap: 28 * ctx.s, alignItems: 'flex-end'}}>
            {(cue.people || []).map(person => (
              <Portrait key={person.name} ctx={ctx} name={person.name} src={person.src} at={person.at} />
            ))}
          </div>
        </div>
      );
    case 'contact':
      return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 18 * ctx.s}}>
          <Eyebrow ctx={ctx} text={cue.eyebrow} />
          <Title ctx={ctx} text={cue.title} />
          <Big ctx={ctx} text={cue.big} />
          <Sub ctx={ctx} text={cue.sub} delay={14} icon="people" />
        </div>
      );
    case 'notice':
      return (
        <div style={{display: 'flex', flexDirection: ctx.landscape ? 'row' : 'column', alignItems: ctx.landscape ? 'center' : 'flex-start', gap: 56 * ctx.s}}>
          <PhoneBan ctx={ctx} size={(ctx.landscape ? 300 : 260) * ctx.s} />
          <div style={{display: 'flex', flexDirection: 'column', gap: 22 * ctx.s}}>
            <div style={{...rise(ctx, 26), fontSize: 64 * ctx.s, lineHeight: 1.05, fontWeight: 800, color: INK}}>{cue.title}</div>
            <Sub ctx={ctx} text={cue.sub} delay={32} icon="church" />
          </div>
        </div>
      );
    case 'date':
    default:
      return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 20 * ctx.s}}>
          <Eyebrow ctx={ctx} text={cue.eyebrow} />
          <Title ctx={ctx} text={cue.title} />
          <Big ctx={ctx} text={cue.big} />
          <Sub ctx={ctx} text={cue.sub} delay={14} icon={cue.subIcon || 'clock'} />
          <Sub ctx={ctx} text={cue.sub2} delay={18} icon={cue.sub2Icon || 'pin'} />
        </div>
      );
  }
};

/** The full-screen card. Drawn above everything else, presenter and overlays included. */
export const BrollLayer: React.FC<{cues: BrollCue[]; palette: StudioPalette; network: string}> = ({cues, palette, network}) => {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();
  const seconds = frame / fps;
  const active = brollProgress(cues, seconds, fps);
  if (!active || active.p <= 0) return null;

  const landscape = width >= height;
  const s = Math.min(width, height) / 720;

  if (active.cue.kind === 'image') {
    // A full-screen poster with a slow push-in so it reads as moving, not a still.
    const length = Math.max(1, (active.cue.end - active.cue.start) * fps);
    const since = Math.max(0, frame - Math.round(active.cue.start * fps));
    const push = interpolate(since, [0, length], [1, 1.045], {extrapolateRight: 'clamp', easing: Easing.out(Easing.quad)});
    return (
      <div style={{position: 'absolute', inset: 0, zIndex: 1000, opacity: Math.min(1, active.p * 4), overflow: 'hidden', background: BG}}>
        <Img
          src={active.cue.src || ''}
          style={{width: '100%', height: '100%', objectFit: landscape ? 'cover' : 'contain', transform: `scale(${push})`, transformOrigin: '50% 50%'}}
        />
      </div>
    );
  }

  const ctx: Ctx = {
    s: landscape ? s * 1.15 : s,
    cal: landscape ? s * 1.2 : s * 1.2,
    palette,
    fps,
    cueFrame: Math.max(0, frame - Math.round(active.cue.start * fps)),
    seconds,
    landscape,
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1000,
        // Opaque within a few frames so the presenter never shows through.
        opacity: Math.min(1, active.p * 4),
        overflow: 'hidden',
        fontFamily: NEWS_FONT,
        background: BG,
      }}
    >
      <div style={{position: 'absolute', left: 48 * s, top: 36 * s, fontSize: 20 * s, fontWeight: 800, letterSpacing: 5 * s, color: MUTED, textTransform: 'uppercase'}}>
        {network}
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          boxSizing: 'border-box',
          padding: landscape ? `${80 * s}px ${90 * s}px` : `${110 * s}px ${44 * s}px`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <CardBody cue={active.cue} ctx={ctx} />
      </div>
    </div>
  );
};
