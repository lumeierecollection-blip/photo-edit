import React from 'react';
import {AbsoluteFill, Sequence, useVideoConfig} from 'remotion';
import {ChromaKeyOptions} from '../chroma-key';
import {KeyedVideo} from '../KeyedVideo';
import {PosterSlide, StudioSet} from './StudioSet';
import {MainHeadline, NewsOverlay} from './Graphics';
import {defaultStudioPalette, StudioPalette} from './StudioBackground';
import {BrollCue, BrollLayer} from './Broll';
import {IntroLayer} from './Intro';

/** Portrait for phones and social media, landscape for presentation screens. */
export type NewsFormat = 'portrait' | 'landscape';

export const FORMAT_SIZES: Record<NewsFormat, {width: number; height: number}> = {
  portrait: {width: 720, height: 1280},
  landscape: {width: 1280, height: 720},
};

export type NewsBroadcastProps = {
  format: NewsFormat;
  /** http:// address of the green screen clip, or a file in the public folder. */
  videoSrc: string;
  /** Length of the clip; the server measures it with FFprobe. */
  durationInSeconds: number;
  chromaKey: ChromaKeyOptions;
  /** Scale and position of the presenter inside the frame. */
  anchorZoom: number;
  anchorOffsetX: number;
  anchorOffsetY: number;
  palette: StudioPalette;
  /** This week's photos for the right-hand wall screen (http:// addresses). */
  photos: string[];
  /** Posters for the left-hand wall screen, each shown from its start time. */
  posterScreen: PosterSlide[];
  network: string;
  /** http:// address of the church logo for the corner badge. */
  logoSrc?: string;
  showLive: boolean;
  clock: string;
  /** Label on the red tab at the start of the main headline bar. */
  headline: string;
  /** Main headlines, each shown from its start time until the next one. */
  mainHeadlines: MainHeadline[];
  /** Presenter's name and position, typed in by the user. */
  name: string;
  role: string;
  /** Keep the name up for the whole video, or only for the first seconds. */
  nameMode: 'always' | 'start';
  tickerLabel: string;
  tickerHeadlines: string[];
  tickerSpeed: number;
  lowerThirdStart: number;
  /** Full-screen explainer cards shown over the presenter while a topic is spoken. */
  broll: BrollCue[];
  /** Opening sting and presenter card before the news starts; 0 for none. */
  introSeconds: number;
  /** The presenter's photo for the opening card (http:// address). */
  presenterPhoto?: string;
  /** Parts of the clip to remove after keying (fractions of the clip). */
  mattes?: {x0: number; y0: number; x1: number; y1: number}[];
};

/**
 * From the greenscreen project: that clip's backdrop scored 67 to 144 on the
 * greenness scale while the presenter never rose above 1, so the key sits
 * comfortably between the two. The web app lets people adjust the threshold
 * for their own lighting.
 */
export const newsChromaKey: ChromaKeyOptions = {
  threshold: 60,
  softness: 28,
  spillSuppression: 0.9,
  minBrightness: 24,
  edgeBlur: 1.5,
};

export const newsBroadcastDefaults: NewsBroadcastProps = {
  format: 'portrait',
  videoSrc: 'greenscreen-news.mp4',
  durationInSeconds: 10,
  chromaKey: newsChromaKey,
  anchorZoom: 1,
  anchorOffsetX: 0,
  anchorOffsetY: 0,
  palette: defaultStudioPalette,
  photos: [],
  posterScreen: [],
  network: 'Church News',
  showLive: false,
  clock: '',
  headline: 'Church News',
  mainHeadlines: [{text: 'This week\'s church news', start: 0}],
  name: 'Presenter',
  role: 'Church News',
  nameMode: 'always',
  tickerLabel: 'Church News',
  tickerHeadlines: ['Welcome to this week\'s church news'],
  tickerSpeed: 90,
  lowerThirdStart: 20,
  broll: [],
  introSeconds: 0,
};

export const NewsBroadcast: React.FC<NewsBroadcastProps> = ({
  format,
  videoSrc,
  durationInSeconds,
  chromaKey,
  anchorZoom,
  anchorOffsetX,
  anchorOffsetY,
  palette,
  photos,
  posterScreen,
  broll,
  introSeconds,
  presenterPhoto,
  mattes,
  ...overlay
}) => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{backgroundColor: palette.deep}}>
      {/* The studio, presenter and cards start when the intro ends, so all their
          times stay measured from the start of the presenter's clip. */}
      <Sequence from={Math.round((introSeconds || 0) * fps)} layout="none">
      <StudioSet network={overlay.network} photos={photos} posters={posterScreen} />
      <KeyedVideo
        src={videoSrc}
        chromaKey={chromaKey}
        zoom={anchorZoom}
        offsetX={anchorOffsetX}
        offsetY={anchorOffsetY}
        mattes={mattes}
        filter="drop-shadow(0 10px 26px rgba(0,0,0,0.6))"
      />
      <NewsOverlay {...overlay} />
      {/* Full-screen explainer cards hide the presenter completely. */}
      <BrollLayer cues={broll || []} palette={palette} network={overlay.network} />
      </Sequence>
      {introSeconds > 0 ? (
        <IntroLayer seconds={introSeconds} name={overlay.name} role={overlay.role} photo={presenterPhoto} network={overlay.network} />
      ) : null}
    </AbsoluteFill>
  );
};
