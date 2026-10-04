import React from 'react';
import {Composition} from 'remotion';
import {FORMAT_SIZES, NewsBroadcast, newsBroadcastDefaults} from './news/NewsBroadcast';

const FPS = 30;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="NewsBroadcast"
      component={NewsBroadcast}
      defaultProps={newsBroadcastDefaults}
      durationInFrames={FPS * 10}
      fps={FPS}
      // Fixed sizes per format so the graphics keep their proportions no
      // matter what the source clip measures; the presenter is scaled to fit.
      width={FORMAT_SIZES.portrait.width}
      height={FORMAT_SIZES.portrait.height}
      calculateMetadata={({props}) => ({
        durationInFrames: Math.max(1, Math.floor((props.durationInSeconds + (props.introSeconds || 0)) * FPS)),
        ...(FORMAT_SIZES[props.format] || FORMAT_SIZES.portrait),
      })}
    />
  );
};
