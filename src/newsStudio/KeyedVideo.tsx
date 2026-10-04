import React, {useCallback, useRef} from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig} from 'remotion';
import {applyChromaKey, ChromaKeyOptions} from './chroma-key';

const intrinsicSize = (source: CanvasImageSource) => {
  if (source instanceof HTMLVideoElement) {
    return {width: source.videoWidth, height: source.videoHeight};
  }

  if (source instanceof HTMLImageElement) {
    return {width: source.naturalWidth, height: source.naturalHeight};
  }

  const sized = source as {width?: number; height?: number};
  return {width: sized.width ?? 0, height: sized.height ?? 0};
};

/**
 * Plays a green screen video with the backdrop removed, leaving whatever is
 * behind it visible.
 *
 * The video element itself is invisible. It stays mounted so that Remotion
 * decodes its frames and keeps its audio track in the render; every frame is
 * handed to the canvas, keyed, and drawn there instead.
 */
export const KeyedVideo: React.FC<{
  src: string;
  chromaKey: ChromaKeyOptions;
  /** Extra scale applied to the subject, 1 fills the frame. */
  zoom?: number;
  /** Horizontal nudge as a fraction of the frame width. */
  offsetX?: number;
  /** Vertical nudge as a fraction of the frame height. */
  offsetY?: number;
  volume?: number;
  /**
   * Rectangles of the clip, as fractions of its width and height, that are
   * removed after keying: a bottle or a cable in the corner of the shot.
   */
  mattes?: {x0: number; y0: number; x1: number; y1: number}[];
  /**
   * CSS filter applied to the keyed subject. A drop shadow reads off the alpha
   * channel, which grounds the subject against the new background.
   */
  filter?: string;
}> = ({src, chromaKey, zoom = 1, offsetX = 0, offsetY = 0, volume, filter, mattes}) => {
  const {width, height} = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const onVideoFrame = useCallback(
    (frame: CanvasImageSource) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d', {willReadFrequently: true});
      if (!canvas || !context) {
        return;
      }

      const source = intrinsicSize(frame);
      if (!source.width || !source.height) {
        return;
      }

      // Cover the frame when the clip has the frame's shape. A clip of the
      // other shape (a phone-filmed portrait clip in a landscape frame, say)
      // is fitted by height instead, so the presenter is not cropped to a
      // close-up. Then apply the caller's zoom and nudge.
      const cover = Math.max(canvas.width / source.width, canvas.height / source.height);
      const contain = Math.min(canvas.width / source.width, canvas.height / source.height);
      const sameShape = source.width >= source.height === canvas.width >= canvas.height;
      const scale = (sameShape ? cover : contain) * zoom;
      const drawWidth = source.width * scale;
      const drawHeight = source.height * scale;
      const left = (canvas.width - drawWidth) / 2 + offsetX * canvas.width;
      const top = (canvas.height - drawHeight) / 2 + offsetY * canvas.height;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame, left, top, drawWidth, drawHeight);

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      applyChromaKey(imageData.data, canvas.width, canvas.height, chromaKey);
      context.putImageData(imageData, 0, 0);

      for (const m of mattes || []) {
        context.clearRect(left + m.x0 * drawWidth, top + m.y0 * drawHeight, (m.x1 - m.x0) * drawWidth, (m.y1 - m.y0) * drawHeight);
      }

      // Where the clip's edge falls inside the frame, scaling blends its
      // outermost pixels with the empty canvas; those half-transparent green
      // pixels escape the key and show as thin lines, so trim them off.
      const trim = 3;
      if (left > 0) context.clearRect(left - 1, 0, trim + 1, canvas.height);
      if (left + drawWidth < canvas.width) context.clearRect(left + drawWidth - trim, 0, trim + 1, canvas.height);
      if (top > 0) context.clearRect(0, top - 1, canvas.width, trim + 1);
      if (top + drawHeight < canvas.height) context.clearRect(0, top + drawHeight - trim, canvas.width, trim + 1);
    },
    [chromaKey, offsetX, offsetY, zoom, mattes],
  );

  return (
    <>
      <OffthreadVideo
        // The web app passes a full http:// address to the uploaded video;
        // a bare file name still resolves from the bundle's public folder.
        src={/^https?:\/\//.test(src) ? src : staticFile(src)}
        onVideoFrame={onVideoFrame}
        volume={volume}
        style={{opacity: 0, position: 'absolute'}}
      />
      <AbsoluteFill style={{filter}}>
        <canvas ref={canvasRef} width={width} height={height} />
      </AbsoluteFill>
    </>
  );
};
