import React from 'react';
import {AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {NEWS_FONT} from './Graphics';
import {CROSS_ASPECT, CROSS_DATA_URI} from './crossMark';

export type PosterSlide = {src: string; start: number};

/**
 * The church news studio, rebuilt from the church's reference broadcast: a
 * three-panel wall (an angled poster screen on the left, the glowing red cross
 * in the middle, a framed photo screen on the right) over a glossy blue floor.
 *
 * Everything is laid out in the reference's own 1920x1080 coordinates and then
 * scaled to the frame, so the set keeps the exact proportions of the original.
 */
const W = 1920;
const H = 1080;

const RED = '#e31e2d';

type Pt = [number, number];

/**
 * CSS matrix3d that pins a w x h rectangle to four corners (TL, TR, BR, BL).
 * This is what makes the left screen look like it sits at an angle on the wall.
 */
function quadTransform(w: number, h: number, q: [Pt, Pt, Pt, Pt]): string {
  const src: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
  const A: number[][] = [];
  const b: number[] = [];
  src.forEach(([x, y], i) => {
    const [X, Y] = q[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  });
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h8 = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h8[k];
    h8[r] = s / A[r][r];
  }
  const [a, bb, c, d, e, f, g, h2] = h8;
  return `matrix3d(${a},${d},0,${g},${bb},${e},0,${h2},0,0,1,0,${c},${f},0,1)`;
}

const clip = (pts: Pt[]) => `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(',')})`;

/** Faint horizontal scan lines and edge shading that make a picture read as a lit screen. */
const ScreenFinish: React.FC<{dim?: number}> = ({dim = 0.12}) => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <AbsoluteFill
      style={{
        background:
          'repeating-linear-gradient(0deg, rgba(0,0,0,0.0) 0px, rgba(0,0,0,0.0) 2px, rgba(0,0,0,0.12) 3px)',
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 120% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.35) 100%), rgba(8,14,30,${dim})`,
      }}
    />
  </AbsoluteFill>
);

/**
 * This week's posters, cross-fading as each announcement comes up. Nothing
 * shows before the first poster's start time, and a slide with an empty src
 * clears the screen until the next poster.
 */
const PosterSlides: React.FC<{slides: PosterSlide[]}> = ({slides}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const sorted = [...slides].sort((a, b) => a.start - b.start);
  let current = -1;
  sorted.forEach((s, i) => {
    if (t >= s.start) current = i;
  });
  const fade = (from: number, to: number, at: number) =>
    interpolate(at, [0, 0.5], [from, to], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: '#0a1220'}}>
      {sorted.map((s, i) => {
        if (current < 0 || !s.src) return null;
        const since = t - sorted[current].start;
        const opacity = i === current ? fade(0, 1, since) : i === current - 1 ? fade(1, 0, since) : 0;
        if (opacity <= 0) return null;
        return (
          <Img
            key={i}
            src={s.src}
            style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity}}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * Photos side by side with a thin dark gap, drifting slowly right to left and
 * looping, like the reference's right-hand screen.
 */
const PhotoStrip: React.FC<{photos: string[]; tileWidth: number; gap: number; speed: number}> = ({
  photos,
  tileWidth,
  gap,
  speed,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const step = tileWidth + gap;
  const setWidth = photos.length * step;
  const offset = ((frame / fps) * speed) % setWidth;
  const repeats = Math.max(2, Math.ceil((tileWidth * 3) / setWidth) + 1);
  const tiles: string[] = [];
  for (let r = 0; r < repeats; r++) tiles.push(...photos);

  return (
    <AbsoluteFill style={{background: '#050912'}}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          display: 'flex',
          gap,
          transform: `translateX(${-offset}px)`,
        }}
      >
        {tiles.map((src, i) => (
          <Img key={i} src={src} style={{width: tileWidth, height: '100%', objectFit: 'cover', flexShrink: 0}} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** A nameplate in the reference's letter-spaced red capitals. */
const NetworkName: React.FC<{text: string; size: number; spacing?: number}> = ({text, size, spacing = 0.14}) => (
  <div
    style={{
      fontFamily: NEWS_FONT,
      fontWeight: 800,
      fontSize: size,
      letterSpacing: `${spacing}em`,
      color: RED,
      whiteSpace: 'nowrap',
      textShadow: '0 0 14px rgba(227,30,45,0.55)',
      textTransform: 'uppercase',
    }}
  >
    {text}
  </div>
);

/** The glowing red cross on its black panel, behind the presenter. */
const CrossPanel: React.FC<{x: number; y: number; w: number; h: number; crossW: number; crossY: number}> = ({
  x,
  y,
  w,
  h,
  crossW,
  crossY,
}) => {
  const frame = useCurrentFrame();
  const glow = interpolate(Math.sin(frame / 38), [-1, 1], [0.75, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: 'border-box',
        border: '3px solid #2c3a55',
        background: 'linear-gradient(180deg, #02050b 0%, #050a16 100%)',
        boxShadow: '0 0 30px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: crossY,
          width: crossW * 1.9,
          height: crossW * 1.9,
          marginLeft: (-crossW * 1.9) / 2,
          marginTop: -crossW * 0.45,
          background: `radial-gradient(closest-side, rgba(227,30,45,${0.3 * glow}) 0%, transparent 100%)`,
        }}
      />
      <Img
        src={CROSS_DATA_URI}
        style={{
          position: 'absolute',
          left: '50%',
          top: crossY,
          width: crossW,
          height: crossW / CROSS_ASPECT,
          marginLeft: -crossW / 2,
          filter: `drop-shadow(0 0 ${22 * glow}px rgba(255,30,40,0.75))`,
        }}
      />
    </div>
  );
};

/** The framed screen at the right of the wall: title plate over the photo strip. */
const RightPanel: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  network: string;
  photos: string[];
  titleSize: number;
  headerH: number;
}> = ({x, y, w, h, network, photos, titleSize, headerH}) => {
  const screenW = w - 12;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: 'border-box',
        border: '3px solid #34445f',
        background: '#04070e',
        boxShadow: '0 0 34px rgba(0,0,0,0.6), inset 0 0 30px rgba(0,0,0,0.6)',
      }}
    >
      <div
        style={{
          height: headerH,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #000 0%, #0a0f1c 100%)',
          borderBottom: '2px solid #4a1520',
        }}
      >
        <NetworkName text={network} size={titleSize} spacing={0.12} />
      </div>
      <div style={{position: 'absolute', left: 5, top: headerH + 2, width: screenW, bottom: 5, overflow: 'hidden'}}>
        {photos.length > 0 ? (
          <PhotoStrip photos={photos} tileWidth={screenW + 4} gap={12} speed={36 * (screenW / 630)} />
        ) : (
          <AbsoluteFill style={{background: 'linear-gradient(160deg, #12294f, #050b1a)'}} />
        )}
        <ScreenFinish dim={0.18} />
      </div>
    </div>
  );
};

const LandscapeSet: React.FC<{network: string; photos: string[]; posters: PosterSlide[]}> = ({
  network,
  photos,
  posters,
}) => {
  // Left wall panel corners, measured from the reference (1920x1080).
  const header: [Pt, Pt, Pt, Pt] = [[-60, -91], [585, 122], [585, 289], [-60, 133]];
  const screen: [Pt, Pt, Pt, Pt] = [[0, 250], [578, 345], [578, 625], [0, 662]];

  return (
    <div style={{position: 'absolute', left: 0, top: 0, width: W, height: H}}>
      {/* Wall */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(90% 70% at 35% 12%, #0e1f44 0%, #081028 55%, #050a18 100%)',
        }}
      />

      {/* Glossy floor, brightest at the right where the reference catches the light */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 660,
          width: W,
          height: H - 660,
          background:
            'linear-gradient(180deg, rgba(5,10,24,0) 0%, rgba(10,30,64,0.85) 35%, #0a2348 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 1150,
          top: 690,
          width: 900,
          height: 330,
          background: 'radial-gradient(closest-side, rgba(52,128,205,0.55) 0%, rgba(30,80,150,0.25) 55%, transparent 100%)',
          filter: 'blur(18px)',
        }}
      />

      {/* Left wall panel: slanted nameplate over an angled poster screen */}
      <div style={{position: 'absolute', left: 0, top: 0, width: 640, height: 900, overflow: 'hidden'}}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 645,
            height: 200,
            transformOrigin: '0 0',
            transform: quadTransform(645, 200, header),
            background: 'linear-gradient(180deg, #000 0%, #060a16 100%)',
          }}
        >
          <div style={{position: 'absolute', left: 58, top: 100, transform: 'translateY(-50%)'}}>
            <NetworkName text={network} size={41} spacing={0.1} />
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            clipPath: clip([[-60, 133], [585, 289], [585, 345], [-60, 240]]),
            background: 'linear-gradient(180deg, #0d1f40, #16305a)',
          }}
        />
        {/* thin red rule where the nameplate meets the panel */}
        <div
          style={{
            position: 'absolute',
            left: -60,
            top: 133,
            width: 720,
            height: 3,
            transformOrigin: '0 0',
            transform: 'rotate(13.56deg)',
            background: 'linear-gradient(90deg, #8d1420, #c21a28)',
          }}
        />
        {/* the lower bezel beneath the screen */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            clipPath: clip([[-60, 668], [578, 625], [578, 700], [-60, 760]]),
            background: 'linear-gradient(180deg, #0b1a36, #07102a)',
          }}
        />
        {/* glossy ledge */}
        <div
          style={{
            position: 'absolute',
            left: -60,
            top: 776,
            width: 560,
            height: 10,
            transformOrigin: '0 0',
            transform: 'rotate(-7.3deg)',
            background: 'linear-gradient(180deg, #a9c8e6 0%, #4d6f98 45%, #122344 100%)',
            boxShadow: '0 4px 14px rgba(120,170,230,0.35)',
          }}
        />
        {/* the screen itself */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 640,
            height: 400,
            transformOrigin: '0 0',
            transform: quadTransform(640, 400, screen),
            overflow: 'hidden',
            background: '#0a1220',
          }}
        >
          {posters.length > 0 ? (
            <PosterSlides slides={posters} />
          ) : (
            <AbsoluteFill style={{background: 'linear-gradient(160deg, #12294f, #050b1a)'}} />
          )}
          <ScreenFinish dim={0.1} />
        </div>
        {/* right-hand metal post */}
        <div
          style={{
            position: 'absolute',
            left: 580,
            top: 122,
            width: 30,
            height: 520,
            background: 'linear-gradient(90deg, #1b2b47 0%, #3a4f73 40%, #16243c 100%)',
          }}
        />
      </div>

      {/* Centre: the red cross, behind the presenter */}
      <CrossPanel x={632} y={30} w={612} h={690} crossW={510} crossY={28} />

      {/* Right: photo screen */}
      <RightPanel x={1260} y={30} w={646} h={632} network={network} photos={photos} titleSize={40} headerH={106} />
    </div>
  );
};

/**
 * Portrait uses the same pieces restacked for a tall frame: the two screens
 * along the top over the glowing cross, so posters and photos stay visible.
 */
const PortraitSet: React.FC<{network: string; photos: string[]; posters: PosterSlide[]}> = ({
  network,
  photos,
  posters,
}) => {
  const {width, height} = useVideoConfig();
  const s = width / 720;
  const panelW = 338 * s;
  const panelH = 290 * s;
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{background: 'radial-gradient(110% 60% at 50% 12%, #0e1f44 0%, #081028 55%, #050a18 100%)'}}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: height * 0.5,
          bottom: 0,
          background: 'linear-gradient(180deg, rgba(5,10,24,0) 0%, rgba(10,30,64,0.85) 50%, #0a2348 100%)',
        }}
      />
      <CrossPanel x={width * 0.12} y={height * 0.3} w={width * 0.76} h={height * 0.5} crossW={width * 0.5} crossY={height * 0.05} />
      <RightPanel
        x={14 * s}
        y={height * 0.07}
        w={panelW}
        h={panelH}
        network={network}
        photos={posters.map(p => p.src)}
        titleSize={15 * s}
        headerH={44 * s}
      />
      <RightPanel
        x={width - panelW - 14 * s}
        y={height * 0.07}
        w={panelW}
        h={panelH}
        network={network}
        photos={photos}
        titleSize={15 * s}
        headerH={44 * s}
      />
    </AbsoluteFill>
  );
};

const FilmGrain: React.FC = () => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <svg width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
      <defs>
        <filter id="set-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.04 0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter="url(#set-grain)" />
    </svg>
    <AbsoluteFill
      style={{background: 'radial-gradient(130% 100% at 50% 45%, transparent 55%, rgba(0,0,0,0.4) 100%)'}}
    />
  </AbsoluteFill>
);

export const StudioSet: React.FC<{network: string; photos: string[]; posters: PosterSlide[]}> = ({
  network,
  photos,
  posters,
}) => {
  const {width, height} = useVideoConfig();
  const landscape = width >= height;
  const scale = width / W;
  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#050a18'}}>
      {landscape ? (
        <div style={{position: 'absolute', left: 0, top: 0, width: W, height: H, transformOrigin: '0 0', transform: `scale(${scale})`}}>
          <LandscapeSet network={network} photos={photos} posters={posters} />
        </div>
      ) : (
        <PortraitSet network={network} photos={photos} posters={posters} />
      )}
      <FilmGrain />
    </AbsoluteFill>
  );
};
