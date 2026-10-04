import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {measureText} from '@remotion/layout-utils';

export const NEWS_FONT = 'Liberation Sans, Arial, Helvetica, sans-serif';

const RED = '#d81f2a';

/**
 * Network badge in the top corner. With a logo, the logo sits on a white tile
 * in place of the two-letter red block.
 */
export const LogoBug: React.FC<{name: string; scale: number; logoSrc?: string}> = ({
  name,
  scale,
  logoSrc,
}) => (
  <div
    style={{
      position: 'absolute',
      top: 30 * scale,
      left: 26 * scale,
      display: 'flex',
      alignItems: 'stretch',
      fontFamily: NEWS_FONT,
      boxShadow: `0 ${4 * scale}px ${16 * scale}px rgba(0,0,0,0.45)`,
    }}
  >
    {logoSrc ? (
      <div
        style={{
          background: 'white',
          display: 'flex',
          alignItems: 'center',
          padding: `${5 * scale}px ${9 * scale}px`,
        }}
      >
        <Img src={logoSrc} style={{height: 36 * scale, width: 'auto', display: 'block'}} />
      </div>
    ) : (
      <div
        style={{
          background: RED,
          color: 'white',
          fontSize: 30 * scale,
          fontWeight: 700,
          letterSpacing: 1 * scale,
          padding: `${8 * scale}px ${12 * scale}px`,
          lineHeight: 1,
        }}
      >
        {name.slice(0, 2).toUpperCase()}
      </div>
    )}
    <div
      style={{
        background: 'rgba(4,9,28,0.82)',
        color: 'white',
        fontSize: 19 * scale,
        fontWeight: 700,
        letterSpacing: 3 * scale,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${14 * scale}px`,
      }}
    >
      {name.toUpperCase()}
    </div>
  </div>
);

/** Pulsing LIVE pill with the on-air clock underneath. */
export const LiveBadge: React.FC<{clock: string; scale: number}> = ({
  clock,
  scale,
}) => {
  const frame = useCurrentFrame();
  const pulse = interpolate(Math.sin((frame / 15) * Math.PI), [-1, 1], [0.35, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 30 * scale,
        right: 26 * scale,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8 * scale,
        fontFamily: NEWS_FONT,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8 * scale,
          background: RED,
          padding: `${7 * scale}px ${13 * scale}px`,
          boxShadow: `0 ${4 * scale}px ${16 * scale}px rgba(0,0,0,0.45)`,
        }}
      >
        <div
          style={{
            width: 11 * scale,
            height: 11 * scale,
            borderRadius: '50%',
            background: 'white',
            opacity: pulse,
          }}
        />
        <span
          style={{
            color: 'white',
            fontSize: 21 * scale,
            fontWeight: 700,
            letterSpacing: 2 * scale,
          }}
        >
          LIVE
        </span>
      </div>
      <div
        style={{
          background: 'rgba(4,9,28,0.82)',
          color: 'white',
          fontSize: 18 * scale,
          fontWeight: 700,
          letterSpacing: 1.5 * scale,
          padding: `${5 * scale}px ${11 * scale}px`,
        }}
      >
        {clock}
      </div>
    </div>
  );
};

export type MainHeadline = {
  text: string;
  /** Seconds into the video when this headline takes over the main bar. */
  start: number;
};

/** The headline showing at `seconds`, and when it started. */
export const currentHeadline = (headlines: MainHeadline[], seconds: number) => {
  let current: MainHeadline | null = null;
  for (const h of headlines) {
    if (h.start <= seconds && (!current || h.start >= current.start)) {
      current = h;
    }
  }
  return current;
};

/** How long the presenter's name stays up in 'start' mode. */
const NAME_SECONDS = 10;

/**
 * Presenter name and position, plus the main headline bar underneath. The
 * name slides in over the presenter's shoulder; each new headline wipes in
 * from the left at its start time.
 */
export const LowerThird: React.FC<{
  label: string;
  headlines: MainHeadline[];
  name: string;
  role: string;
  nameMode: 'always' | 'start';
  scale: number;
  startFrame: number;
}> = ({label, headlines, name, role, nameMode, scale, startFrame}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const seconds = frame / fps;

  const nameIn = spring({frame: frame - startFrame, fps, config: {damping: 200, mass: 0.7}});
  const nameOut =
    nameMode === 'start'
      ? spring({frame: frame - startFrame - NAME_SECONDS * fps, fps, config: {damping: 200, mass: 0.7}})
      : 0;
  const nameShown = nameIn - nameOut;
  const hasName = name.trim() !== '' || role.trim() !== '';

  const headline = currentHeadline(headlines, seconds);
  const sinceChange = headline ? frame - Math.round(headline.start * fps) : 0;
  const headlineIn = spring({
    frame: Math.max(sinceChange, frame - startFrame - 8),
    fps,
    config: {damping: 200, mass: 0.6},
  });
  const wipe = headline ? spring({frame: sinceChange, fps, config: {damping: 200, mass: 0.5}}) : 0;
  const barWidth = width - 52 * scale;

  return (
    <div
      style={{
        position: 'absolute',
        left: 26 * scale,
        bottom: 126 * scale,
        width: barWidth,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6 * scale,
        fontFamily: NEWS_FONT,
      }}
    >
      {hasName && nameShown > 0.001 ? (
        <div
          style={{
            transform: `translateX(${interpolate(nameShown, [0, 1], [-width, 0])}px)`,
            background: 'linear-gradient(90deg, rgba(6,17,46,0.96) 0%, rgba(11,36,86,0.92) 100%)',
            borderLeft: `${6 * scale}px solid ${RED}`,
            padding: `${10 * scale}px ${20 * scale}px ${12 * scale}px`,
            maxWidth: barWidth,
            boxShadow: `0 ${6 * scale}px ${22 * scale}px rgba(0,0,0,0.5)`,
          }}
        >
          <div style={{color: 'white', fontSize: 32 * scale, fontWeight: 700, letterSpacing: 0.5 * scale, lineHeight: 1.1}}>
            {name.toUpperCase()}
          </div>
          {role.trim() ? (
            <div style={{color: '#8fc4ff', fontSize: 19 * scale, fontWeight: 700, letterSpacing: 2 * scale, marginTop: 4 * scale}}>
              {role.toUpperCase()}
            </div>
          ) : null}
        </div>
      ) : null}

      {headline && headline.text.trim() ? (
        <div
          style={{
            transform: `translateX(${interpolate(headlineIn, [0, 1], [-width, 0])}px)`,
            display: 'flex',
            alignItems: 'stretch',
            width: barWidth,
            boxShadow: `0 ${6 * scale}px ${22 * scale}px rgba(0,0,0,0.5)`,
          }}
        >
          {label.trim() ? (
            <div
              style={{
                background: RED,
                color: 'white',
                fontSize: 19 * scale,
                fontWeight: 700,
                letterSpacing: 1.5 * scale,
                padding: `0 ${14 * scale}px`,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              {label.toUpperCase()}
            </div>
          ) : null}
          <div
            style={{
              flex: 1,
              background: 'rgba(250,250,252,0.97)',
              color: '#06112e',
              fontSize: 30 * scale,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: 0.3 * scale,
              padding: `${11 * scale}px ${18 * scale}px`,
              clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)`,
            }}
          >
            {headline.text.toUpperCase()}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** Bottom crawl. The headlines repeat, so the strip never runs out. */
export const Ticker: React.FC<{
  label: string;
  headlines: string[];
  scale: number;
  /** Pixels per second, before scaling. */
  speed: number;
}> = ({label, headlines, scale, speed}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const height = 74 * scale;
  const fontSize = 23 * scale;

  const segment = headlines.map((h) => h.toUpperCase()).join('     •     ') + '     •     ';
  const segmentWidth = measureText({
    text: segment,
    fontFamily: NEWS_FONT,
    fontSize,
    fontWeight: '700',
    letterSpacing: `${1 * scale}px`,
  }).width;

  const travelled = (frame / fps) * speed * scale;
  const shift = segmentWidth > 0 ? -(travelled % segmentWidth) : 0;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height,
        display: 'flex',
        alignItems: 'stretch',
        fontFamily: NEWS_FONT,
        background: 'rgba(4,9,28,0.94)',
        borderTop: `${3 * scale}px solid ${RED}`,
      }}
    >
      <div
        style={{
          background: RED,
          color: 'white',
          fontSize: 22 * scale,
          fontWeight: 700,
          letterSpacing: 2 * scale,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${16 * scale}px`,
          flexShrink: 0,
          zIndex: 1,
        }}
      >
        {label.toUpperCase()}
      </div>
      <div style={{flex: 1, overflow: 'hidden', position: 'relative'}}>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 16 * scale,
            transform: `translate(${shift}px, -50%)`,
            whiteSpace: 'pre',
            color: 'white',
            fontSize,
            fontWeight: 700,
            letterSpacing: 1 * scale,
          }}
        >
          {segment.repeat(4)}
        </div>
      </div>
    </div>
  );
};

/** Thin bar of colour that separates the crawl from the lower third. */
export const AccentStrip: React.FC<{scale: number}> = ({scale}) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 74 * scale,
      height: 40 * scale,
      background: 'linear-gradient(90deg, #0b2456 0%, #123a80 100%)',
      borderTop: `${2 * scale}px solid rgba(63,169,255,0.5)`,
    }}
  />
);

export const NewsOverlay: React.FC<{
  network: string;
  logoSrc?: string;
  showLive: boolean;
  clock: string;
  headline: string;
  mainHeadlines: MainHeadline[];
  name: string;
  role: string;
  nameMode: 'always' | 'start';
  tickerLabel: string;
  tickerHeadlines: string[];
  tickerSpeed: number;
  lowerThirdStart: number;
}> = ({
  network,
  logoSrc,
  showLive,
  clock,
  headline,
  mainHeadlines,
  name,
  role,
  nameMode,
  tickerLabel,
  tickerHeadlines,
  tickerSpeed,
  lowerThirdStart,
}) => {
  const {width, height} = useVideoConfig();
  // Sized from the short side so portrait and landscape frames get graphics
  // of the same proportions (the originals were designed at 720 wide).
  const scale = Math.min(width, height) / 720;

  return (
    <AbsoluteFill>
      {/* The studio wall already carries the network name; the corner badge only
          appears when a logo is chosen for it. */}
      {logoSrc ? <LogoBug name={network} scale={scale} logoSrc={logoSrc} /> : null}
      {showLive ? <LiveBadge clock={clock} scale={scale} /> : null}
      <LowerThird
        label={headline}
        headlines={mainHeadlines}
        name={name}
        role={role}
        nameMode={nameMode}
        scale={scale}
        startFrame={lowerThirdStart}
      />
      <AccentStrip scale={scale} />
      <Ticker
        label={tickerLabel}
        headlines={tickerHeadlines}
        scale={scale}
        speed={tickerSpeed}
      />
    </AbsoluteFill>
  );
};
