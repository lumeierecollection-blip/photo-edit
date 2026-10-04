import React from 'react';
import {AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {CROSS_ASPECT, CROSS_DATA_URI} from './crossMark';
import {NEWS_FONT} from './Graphics';

const RED = '#d81f2a';
const INK = '#f4f6fb';

/** Where the logo sting hands over to the presenter card, in seconds. */
const HANDOVER = 3.75;
/** How long the closing wipe takes to clear after the intro's last second. */
export const INTRO_WIPE_OUT = 0.3;
const WIPE_IN = 0.35;

/**
 * A red bar that sweeps across and covers the whole frame at `at`, then
 * sweeps off, so a cut underneath it is never seen.
 */
const Wipe: React.FC<{at: number; sweepOut?: number}> = ({at, sweepOut = 0.3}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const t = frame / fps;
  const x = t < at
    ? interpolate(t, [at - WIPE_IN, at], [-1.15, 0], {extrapolateLeft: 'clamp', easing: Easing.out(Easing.cubic)})
    : interpolate(t, [at, at + sweepOut], [0, 1.15], {extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic)});
  if (t < at - WIPE_IN || t > at + sweepOut) return null;
  return (
    <AbsoluteFill style={{transform: `translateX(${x * width}px) skewX(-12deg)`, background: `linear-gradient(90deg, #7d0f19 0%, ${RED} 40%, #f0414c 100%)`, boxShadow: '0 0 60px rgba(216,31,42,0.6)'}} />
  );
};

/** A photo or video the church picked for the opening montage. */
export type IntroMedia = {type: 'photo' | 'video'; src: string};

const CROSSFADE = 0.4;

const MontageItem: React.FC<{item: IntroMedia; slotFrames: number; index: number}> = ({item, slotFrames, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // Each picture fades up over the previous one while it slowly pushes in.
  const fadeIn = index === 0 ? 1 : interpolate(frame, [0, CROSSFADE * fps], [0, 1], {extrapolateRight: 'clamp'});
  const push = interpolate(frame, [0, slotFrames + CROSSFADE * fps], [1.04, 1.16], {extrapolateRight: 'clamp'});
  const drift = (index % 2 === 0 ? -1 : 1) * interpolate(frame, [0, slotFrames], [0, 26], {extrapolateRight: 'clamp'});
  const style: React.CSSProperties = {width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${push}) translateX(${drift}px)`};
  return (
    <AbsoluteFill style={{opacity: fadeIn}}>
      {item.type === 'video' ? <OffthreadVideo src={item.src} volume={0} style={style} /> : <Img src={item.src} style={style} />}
    </AbsoluteFill>
  );
};

/**
 * The photos and videos the church chose for the opening, cross-fading one
 * after another behind the logo. Dimmed and softened so the logo stays the
 * hero and any footage reads as atmosphere.
 */
const IntroMontage: React.FC<{media: IntroMedia[]; until: number}> = ({media, until}) => {
  const {fps} = useVideoConfig();
  const slot = until / media.length;
  const slotFrames = Math.round(slot * fps);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{filter: 'blur(2.5px) saturate(0.9)'}}>
        {media.map((item, i) => (
          <Sequence key={i} from={Math.round(i * slot * fps)} durationInFrames={slotFrames + Math.round(CROSSFADE * fps)} layout="none">
            <MontageItem item={item} slotFrames={slotFrames} index={i} />
          </Sequence>
        ))}
      </AbsoluteFill>
      <AbsoluteFill style={{background: 'radial-gradient(90% 80% at 50% 50%, rgba(3,8,20,0.62) 0%, rgba(0,0,0,0.86) 100%)'}} />
    </AbsoluteFill>
  );
};

/** A slow diagonal sheen across the dark background, as in a news sting. */
const Sheen: React.FC<{from: number; to: number}> = ({from, to}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const t = frame / fps;
  const x = interpolate(t, [from, to], [-0.4, 1.4], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)});
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div style={{position: 'absolute', top: '-20%', bottom: '-20%', width: width * 0.28, left: x * width, transform: 'skewX(-18deg)', background: 'linear-gradient(90deg, transparent, rgba(120,170,255,0.16), transparent)'}} />
    </AbsoluteFill>
  );
};

const LogoSting: React.FC<{network: string; s: number; landscape: boolean}> = ({network, s, landscape}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const pop = spring({frame: frame - Math.round(0.35 * fps), fps, config: {damping: 16, stiffness: 90, mass: 1}});
  const glow = interpolate(Math.sin(frame / 14), [-1, 1], [0.6, 1]);
  const textIn = interpolate(t, [1.1, 1.8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const rule = interpolate(t, [1.5, 2.3], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  // The whole lock-up eases forward and fades a beat before the wipe.
  const leave = interpolate(t, [HANDOVER - 0.5, HANDOVER - 0.05], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const crossH = (landscape ? 250 : 200) * s;
  const [first, ...rest] = network.toUpperCase().split(' ');
  const title = rest.join(' ') || first;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: 1 - leave, transform: `scale(${1 + leave * 0.06})`}}>
      <div style={{display: 'flex', flexDirection: landscape ? 'row' : 'column', alignItems: 'center', gap: 44 * s}}>
        <div style={{position: 'relative', height: crossH, width: crossH * CROSS_ASPECT, transform: `scale(${0.6 + 0.4 * pop})`, opacity: interpolate(pop, [0, 0.5], [0, 1], {extrapolateRight: 'clamp'})}}>
          <div style={{position: 'absolute', inset: -crossH * 0.45, background: `radial-gradient(closest-side, rgba(227,30,45,${0.38 * glow}), transparent)`}} />
          <Img src={CROSS_DATA_URI} style={{position: 'relative', height: crossH, width: crossH * CROSS_ASPECT, filter: `drop-shadow(0 0 ${22 * glow * s}px rgba(255,30,40,0.8))`}} />
        </div>
        <div style={{textAlign: landscape ? 'left' : 'center', fontFamily: NEWS_FONT, opacity: textIn, transform: `translateX(${(1 - textIn) * 60 * s}px)`}}>
          <div style={{fontSize: 27 * s, fontWeight: 700, letterSpacing: 9 * s, color: 'rgba(244,246,251,0.78)', whiteSpace: 'nowrap'}}>CFC PRETORIA NORTH</div>
          <div style={{fontSize: 92 * s, fontWeight: 900, lineHeight: 1.02, color: INK, marginTop: 8 * s, whiteSpace: 'nowrap', textShadow: '0 0 30px rgba(120,170,255,0.25)'}}>{title}</div>
          <div style={{height: 6 * s, width: `${rule * 100}%`, background: RED, marginTop: 18 * s, boxShadow: '0 0 18px rgba(216,31,42,0.7)'}} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const PresenterCard: React.FC<{name: string; role: string; photo?: string; network: string; s: number; landscape: boolean; start: number}> = ({
  name,
  role,
  photo,
  network,
  s,
  landscape,
  start,
}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const local = frame - Math.round(start * fps);
  const slide = spring({frame: local - 4, fps, config: {damping: 18, stiffness: 110, mass: 0.9}});
  const textIn = (delay: number) => spring({frame: local - delay, fps, config: {damping: 20, stiffness: 120, mass: 0.9}});

  // She stands cut out from her photo (no frame, no background) on a soft disc
  // of light, her feet cropped by the bottom of the frame like in the photo.
  const figureH = landscape ? height * 0.94 : height * 0.5;
  const figureLeft = landscape ? 150 * s : (width - figureH * 0.4) / 2;
  const figureBottom = landscape ? 0 : height - 110 * s - figureH;
  const textLeft = landscape ? figureLeft + figureH * 0.4 + 190 * s : 70 * s;
  const textTop = landscape ? 0 : 110 * s + figureH + 40 * s;
  // The longest word has to fit beside her, so long names shrink instead of running off the edge.
  const longestWord = Math.max(4, ...name.split(/s+/).map(w => w.length));
  const nameSize = Math.min(104 * s, (width - textLeft - 60 * s) / (longestWord * 0.7));

  return (
    <AbsoluteFill>
      {/* a faint oversized cross behind the text */}
      <Img src={CROSS_DATA_URI} style={{position: 'absolute', right: landscape ? -60 * s : -120 * s, bottom: landscape ? -80 * s : 60 * s, height: (landscape ? 700 : 560) * s, opacity: 0.07, filter: 'grayscale(0.2)'}} />
      <div
        style={{
          position: 'absolute',
          left: figureLeft,
          ...(landscape ? {bottom: figureBottom} : {top: 110 * s}),
          height: figureH,
          transform: `translateX(${(1 - slide) * -(figureLeft + figureH * 0.4 + 60 * s)}px)`,
        }}
      >
        <div style={{position: 'absolute', left: '50%', top: '46%', width: figureH * 0.95, height: figureH * 0.95, marginLeft: -figureH * 0.475, marginTop: -figureH * 0.475, borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(47,111,184,0.55) 0%, rgba(29,58,112,0.55) 62%, rgba(29,58,112,0) 100%)'}} />
        {photo ? <Img src={photo} style={{position: 'relative', height: '100%', width: 'auto', display: 'block', filter: 'drop-shadow(0 14px 30px rgba(0,0,0,0.6))'}} /> : null}
      </div>
      <div style={{position: 'absolute', top: landscape ? 90 * s : textTop - 10 * s, bottom: landscape ? 90 * s : undefined, left: textLeft - 40 * s, width: 6 * s, height: landscape ? undefined : 0, background: RED, boxShadow: '0 0 20px rgba(216,31,42,0.6)', opacity: landscape ? textIn(10) : 0}} />

      <div
        style={{
          position: 'absolute',
          left: textLeft,
          right: 60 * s,
          top: textTop,
          bottom: landscape ? 0 : undefined,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          fontFamily: NEWS_FONT,
          gap: 14 * s,
        }}
      >
        <div style={{opacity: textIn(14), transform: `translateX(${(1 - textIn(14)) * 40 * s}px)`, fontSize: 26 * s, fontWeight: 800, letterSpacing: 8 * s, color: '#5aa3e8'}}>YOUR PRESENTER</div>
        <div style={{opacity: textIn(20), transform: `translateX(${(1 - textIn(20)) * 60 * s}px)`, fontSize: nameSize, fontWeight: 900, lineHeight: 1.02, color: INK}}>{name}</div>
        <div style={{height: 6 * s, width: `${textIn(28) * 340 * s}px`, background: RED, boxShadow: '0 0 18px rgba(216,31,42,0.7)'}} />
        <div style={{opacity: textIn(34), transform: `translateX(${(1 - textIn(34)) * 40 * s}px)`, fontSize: 32 * s, fontWeight: 600, color: 'rgba(244,246,251,0.82)'}}>{role}</div>
        <div style={{opacity: textIn(40), fontSize: 22 * s, fontWeight: 700, letterSpacing: 5 * s, color: 'rgba(244,246,251,0.5)', marginTop: 10 * s}}>{network.toUpperCase()}</div>
      </div>
    </AbsoluteFill>
  );
};

/**
 * The opening: the church logo sting, a red wipe, then the presenter's photo
 * with her name beside it, and a second wipe that lands on the live studio.
 * It sits above everything for `seconds` (+ the wipe-out) while the studio
 * and presenter video wait underneath until the intro ends.
 */
export const IntroLayer: React.FC<{seconds: number; name: string; role: string; photo?: string; network: string; media?: IntroMedia[]}> = ({
  seconds,
  name,
  role,
  photo,
  network,
  media,
}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  if (t > seconds + INTRO_WIPE_OUT) return null;
  const landscape = width >= height;
  const s = Math.min(width, height) / 720;
  const cardShown = t >= HANDOVER;
  // Once the intro is over only the closing wipe remains, sweeping off to
  // show the live studio underneath.
  if (t >= seconds) {
    return (
      <AbsoluteFill style={{zIndex: 2000}}>
        <Wipe at={seconds} sweepOut={INTRO_WIPE_OUT} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{zIndex: 2000, background: cardShown ? 'radial-gradient(110% 90% at 30% 30%, #0f2347 0%, #081028 55%, #050a18 100%)' : '#000'}}>
      {!cardShown ? (media && media.length ? <IntroMontage media={media} until={HANDOVER} /> : <AbsoluteFill style={{background: 'radial-gradient(70% 60% at 50% 50%, #0b1630 0%, #000 80%)'}} />) : null}
      <Sheen from={0.2} to={1.9} />
      {!cardShown ? <LogoSting network={network} s={s} landscape={landscape} /> : null}
      {cardShown ? <PresenterCard name={name} role={role} photo={photo} network={network} s={s} landscape={landscape} start={HANDOVER} /> : null}
      <Wipe at={HANDOVER} />
      <Wipe at={seconds} sweepOut={INTRO_WIPE_OUT} />
    </AbsoluteFill>
  );
};
