export type ChromaKeyOptions = {
  /**
   * Greenness above which a pixel becomes fully transparent, on the 0-255
   * scale produced by `greenScore`. Measured on this footage the backdrop
   * scores 94-107 everywhere, including deep shadow, while the subject never
   * exceeds 35.
   */
  threshold: number;
  /**
   * Width of the soft edge below the threshold. Pixels in that band fade out
   * gradually, which keeps hair and shoulder edges from looking cut out.
   */
  softness: number;
  /**
   * How much of the green light bouncing off the subject is neutralised.
   * 0 keeps the spill, 1 removes all of it.
   */
  spillSuppression: number;
  /**
   * Pixels darker than this (sum of the three channels) are always kept.
   * Near-black pixels carry too little colour for the ratio below to mean
   * anything, and would otherwise flicker.
   */
  minBrightness: number;
  /**
   * Box-blur radius, in pixels, applied to the alpha mask before it is used.
   * A cutout computed pixel-by-pixel is jagged wherever video compression has
   * blocked the edge; blurring only the mask (never the colour) rounds that
   * off into the soft edge a real camera lens would produce, which is what
   * keeps the result from reading as "green screen".
   */
  edgeBlur: number;
};

export const defaultChromaKeyOptions: ChromaKeyOptions = {
  threshold: 75,
  softness: 30,
  spillSuppression: 0.9,
  minBrightness: 24,
  edgeBlur: 1.5,
};

/**
 * How green a pixel is, independent of how brightly it is lit.
 *
 * A neutral pixel puts a third of its total light in the green channel, so the
 * green share is measured against that baseline and rescaled to roughly 0-255.
 * Using the share rather than an absolute channel difference is what lets a
 * shadowed fold of the backdrop key out with the same setting as the brightly
 * lit middle of it.
 */
export const greenScore = (r: number, g: number, b: number) => {
  const sum = r + g + b;
  if (sum === 0) {
    return 0;
  }

  return (g / sum - 1 / 3) * 765;
};

/** Separable box blur of a single-channel float buffer, in place. */
const boxBlur = (
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
) => {
  if (radius <= 0) {
    return src;
  }

  const tmp = new Float32Array(src.length);
  const r = Math.round(radius);
  const size = r * 2 + 1;

  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -r; x <= r; x++) {
      sum += src[row + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / size;
      const add = src[row + Math.min(width - 1, x + r + 1)];
      const drop = src[row + Math.max(0, x - r)];
      sum += add - drop;
    }
  }

  // Vertical pass, back into src.
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) {
      sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      src[y * width + x] = sum / size;
      const add = tmp[Math.min(height - 1, y + r + 1) * width + x];
      const drop = tmp[Math.max(0, y - r) * width + x];
      sum += add - drop;
    }
  }

  return src;
};

/**
 * Removes the green background from `data` in place.
 *
 * Alpha is computed for every pixel first and only then blurred and applied,
 * rather than thresholding each pixel independently, so the cutout gets a
 * soft, camera-like edge instead of a jagged one.
 */
export const applyChromaKey = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: ChromaKeyOptions,
) => {
  const {threshold, softness, spillSuppression, minBrightness, edgeBlur} =
    options;
  const lower = threshold - softness;
  const span = Math.max(softness, 1);
  const pixelCount = width * height;
  const alpha = new Float32Array(pixelCount);

  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r + g + b < minBrightness) {
      alpha[p] = 1;
      continue;
    }

    const score = greenScore(r, g, b);
    alpha[p] =
      score <= lower ? 1 : score >= threshold ? 0 : 1 - (score - lower) / span;

    if (alpha[p] > 0 && spillSuppression > 0) {
      // Pull the green channel back towards the other channels so the
      // surviving edge pixels do not glow green over the new background.
      const strongestOther = Math.max(r, b);
      if (g > strongestOther) {
        data[i + 1] = Math.round(g - (g - strongestOther) * spillSuppression);
      }
    }
  }

  boxBlur(alpha, width, height, edgeBlur);

  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    data[i + 3] = Math.round(data[i + 3] * alpha[p]);
  }
};
