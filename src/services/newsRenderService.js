// Church News studio renderer. Drives Remotion (from the greenscreen project)
// on the server: the React compositions in src/newsStudio are bundled once,
// then rendered to MP4 or to a single preview frame in a headless browser.
//
// The first render downloads Remotion's headless browser (~100 MB) once; after
// that no internet is needed.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENTRY_POINT = path.join(__dirname, '../newsStudio/index.ts');
const COMPOSITION_ID = 'NewsBroadcast';

let bundlePromise = null;

function studioSourceFiles(dir = path.dirname(ENTRY_POINT)) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? studioSourceFiles(full) : [full];
  });
}

/** Bundles the studio once per server run (and again if its source changes). */
async function getServeUrl({ onProgress } = {}) {
  const stamp = studioSourceFiles().map(f => fs.statSync(f).mtimeMs).join(',');
  if (bundlePromise && bundlePromise.stamp === stamp) return bundlePromise;

  const { bundle } = require('@remotion/bundler');
  const promise = bundle({
    entryPoint: ENTRY_POINT,
    onProgress: p => onProgress && onProgress({ stage: 'preparing-studio', fraction: p / 100 })
  });
  promise.stamp = stamp;
  bundlePromise = promise;
  try {
    return await promise;
  } catch (err) {
    bundlePromise = null;
    throw new Error(`Could not prepare the news studio.\n${err.message}`);
  }
}

// The office computer is slow to load a frame (images, filters) the first time.
const RENDER_TIMEOUT_MS = 120000;

let browserPromise = null;

async function ensureStudioBrowser(onProgress) {
  if (!browserPromise) {
    const { ensureBrowser } = require('@remotion/renderer');
    browserPromise = ensureBrowser({
      onBrowserDownload: () => ({
        version: null,
        onProgress: ({ percent }) => onProgress && onProgress({ stage: 'downloading-browser', fraction: percent })
      })
    }).catch(err => {
      browserPromise = null;
      throw new Error(`Could not download the headless browser the news studio renders with. This one-time download needs an internet connection; please try again.\n${err.message}`);
    });
  }
  return browserPromise;
}

function renderConcurrency() {
  const forced = Number(process.env.NEWS_RENDER_CONCURRENCY);
  if (Number.isInteger(forced) && forced > 0) return Math.min(forced, 8);
  // Each render tab holds a decoded frame and the keyed canvas; on small
  // machines more tabs just swap memory.
  const memGb = os.totalmem() / 1024 ** 3;
  const cpus = os.cpus().length || 1;
  // Measured on a 4-core, 4 GB office PC: 2 tabs render ~20% faster than 1,
  // a third adds almost nothing.
  if (memGb < 6) return cpus >= 4 ? 2 : 1;
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

async function prepare(inputProps, onProgress) {
  await ensureStudioBrowser(onProgress);
  const serveUrl = await getServeUrl({ onProgress });
  const { selectComposition } = require('@remotion/renderer');
  // The first browser start on the office computer can take longer than
  // Remotion waits; a second attempt finds it already warm.
  let composition;
  for (let attempt = 1; ; attempt++) {
    try {
      composition = await selectComposition({
        timeoutInMilliseconds: RENDER_TIMEOUT_MS,
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        chromiumOptions: { gl: 'angle' }
      });
      break;
    } catch (err) {
      if (attempt >= 3 || !/connect to the browser/i.test(err.message)) throw err;
    }
  }
  return { serveUrl, composition };
}

/** Renders one frame to a JPEG so people can check the green screen key. */
async function renderPreviewFrame(inputProps, outputPath, { atSeconds = 2, onProgress } = {}) {
  const { renderStill } = require('@remotion/renderer');
  const { serveUrl, composition } = await prepare(inputProps, onProgress);
  const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(atSeconds * composition.fps)));
  await renderStill({
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    serveUrl,
    composition,
    inputProps,
    output: outputPath,
    frame,
    imageFormat: 'jpeg',
    jpegQuality: 88,
    chromiumOptions: { gl: 'angle' }
  });
  return { frame };
}

/**
 * Renders the full news broadcast to an MP4. Pass an AbortSignal to cancel.
 * frameRange: [first, last] renders just that part (inclusive frame numbers).
 * onProgress receives { stage: 'rendering', fraction, renderedFrames, totalFrames }.
 */
async function renderNewsVideo(inputProps, outputPath, { signal, onProgress = () => {}, frameRange = null } = {}) {
  const { renderMedia, makeCancelSignal } = require('@remotion/renderer');
  const { serveUrl, composition } = await prepare(inputProps, onProgress);
  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  if (signal) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' });
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const partial = `${outputPath}.part.mp4`;
  try {
    await renderMedia({
      timeoutInMilliseconds: RENDER_TIMEOUT_MS,
      serveUrl,
      composition,
      inputProps,
      codec: 'h264',
      crf: 18,
      videoImageFormat: 'jpeg',
      jpegQuality: 90,
      outputLocation: partial,
      ...(frameRange ? { frameRange } : {}),
      concurrency: renderConcurrency(),
      chromiumOptions: { gl: 'angle' },
      cancelSignal,
      onProgress: p => onProgress({
        stage: p.stitchStage === 'muxing' ? 'finishing' : 'rendering',
        fraction: p.progress,
        renderedFrames: p.renderedFrames,
        totalFrames: frameRange ? frameRange[1] - frameRange[0] + 1 : composition.durationInFrames
      })
    });
    fs.renameSync(partial, outputPath);
  } catch (err) {
    fs.rm(partial, { force: true }, () => {});
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled by user.'), { name: 'AbortError' });
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  return { durationInFrames: composition.durationInFrames, fps: composition.fps };
}

module.exports = {
  renderNewsVideo,
  renderPreviewFrame,
  COMPOSITION_ID
};
