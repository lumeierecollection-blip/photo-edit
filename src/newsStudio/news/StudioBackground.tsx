import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

export type StudioPalette = {
  deep: string;
  mid: string;
  glow: string;
  accent: string;
};

export const defaultStudioPalette: StudioPalette = {
  deep: '#050b1a',
  mid: '#12294f',
  glow: '#2f6fb8',
  accent: '#5aa3e8',
};

/**
 * Grain, a lens vignette and a very slight chromatic fringe at the corners.
 * These three are what separate a photographed set from a flat render, and
 * cost nothing to keep animating since the noise pattern is baked once into
 * an SVG filter rather than recomputed per frame.
 */
const FilmTexture: React.FC = () => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <svg width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
      <defs>
        <filter id="grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
            result="noise"
          />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(120% 80% at 50% 40%, transparent 45%, rgba(0,0,0,0.55) 100%)',
      }}
    />
  </AbsoluteFill>
);

/**
 * Out-of-focus screens along the back wall. Real studio walls are lit panels
 * seen well behind the anchor's plane of focus, so they are drawn softly
 * blurred and desaturated rather than as crisp shapes; a sharp grid of
 * rectangles is the single biggest tell that a background is a render.
 */
const VideoWall: React.FC<{palette: StudioPalette; scale: number}> = ({
  palette,
  scale,
}) => {
  const frame = useCurrentFrame();
  const panels = 6;

  return (
    <div
      style={{
        position: 'absolute',
        top: -30 * scale,
        left: -80 * scale,
        right: -80 * scale,
        height: 760 * scale,
        display: 'flex',
        gap: 14 * scale,
        filter: `blur(${7 * scale}px)`,
        opacity: 0.85,
      }}
    >
      {new Array(panels).fill(true).map((_, i) => {
        const phase = Math.sin((frame / 90) * Math.PI + i * 1.1);
        const brightness = interpolate(phase, [-1, 1], [0.5, 1]);
        const hueShift = i % 2 === 0 ? palette.glow : palette.accent;

        return (
          <div
            key={i}
            style={{
              flex: 1,
              background: `linear-gradient(200deg, ${hueShift} 0%, ${palette.mid} 45%, ${palette.deep} 100%)`,
              opacity: brightness * 0.9,
              borderRadius: 6 * scale,
            }}
          />
        );
      })}
    </div>
  );
};

/**
 * Soft circular practical lights, the warm bokeh a real key/fill rig throws
 * onto the set behind the talent. Kept blurred and low-contrast so they read
 * as photographed light sources, not graphic elements.
 */
const PracticalLights: React.FC<{scale: number}> = ({scale}) => {
  const frame = useCurrentFrame();
  const lights = [
    {x: 0.14, y: 0.16, r: 150, color: 'rgba(255,214,170,0.5)', period: 130},
    {x: 0.82, y: 0.1, r: 190, color: 'rgba(120,180,255,0.4)', period: 160},
    {x: 0.92, y: 0.34, r: 110, color: 'rgba(255,190,140,0.35)', period: 95},
    {x: 0.06, y: 0.4, r: 120, color: 'rgba(140,190,255,0.3)', period: 110},
  ];

  return (
    <AbsoluteFill style={{filter: `blur(${26 * scale}px)`}}>
      {lights.map((light, i) => {
        const flicker = interpolate(
          Math.sin((frame / light.period) * Math.PI * 2),
          [-1, 1],
          [0.75, 1],
        );

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${light.x * 100}%`,
              top: `${light.y * 100}%`,
              width: light.r * scale,
              height: light.r * scale,
              marginLeft: (-light.r * scale) / 2,
              marginTop: (-light.r * scale) / 2,
              borderRadius: '50%',
              background: light.color,
              opacity: flicker,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * Glossy studio floor beneath the desk, with a faint upward reflection. Real
 * broadcast floors are polished, and that reflected glow is what visually
 * anchors a subject to the ground instead of a flat colour fill.
 */
const Floor: React.FC<{palette: StudioPalette; scale: number}> = ({
  palette,
  scale,
}) => (
  <div
    style={{
      position: 'absolute',
      left: -80 * scale,
      right: -80 * scale,
      bottom: 0,
      // 40% of the frame: 520px of the original 1280px-tall portrait set.
      height: '40%',
      // The top starts transparent and eases into the floor colour, so this
      // layer blends into the wall behind it instead of cutting a hard line
      // across the frame.
      background: `linear-gradient(180deg, transparent 0%, ${palette.mid} 30%, ${palette.deep} 65%)`,
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: '20%',
        right: '20%',
        height: '55%',
        background: `radial-gradient(60% 100% at 50% 0%, ${palette.accent}55 0%, transparent 70%)`,
        filter: `blur(${20 * scale}px)`,
      }}
    />
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.05) 40%, transparent 55%)',
      }}
    />
  </div>
);

export const StudioBackground: React.FC<{palette: StudioPalette}> = ({
  palette,
}) => {
  const {width, height} = useVideoConfig();
  // Short side, so portrait and landscape sets keep the same proportions.
  const scale = Math.min(width, height) / 720;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(130% 90% at 50% 22%, ${palette.mid} 0%, ${palette.deep} 75%)`,
        overflow: 'hidden',
      }}
    >
      <VideoWall palette={palette} scale={scale} />
      <PracticalLights scale={scale} />
      <Floor palette={palette} scale={scale} />
      <FilmTexture />
    </AbsoluteFill>
  );
};
