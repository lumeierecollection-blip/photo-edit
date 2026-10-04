# Church Media Tools (Google Drive Batch Processing System)

A web application for church media teams that processes media stored in Google Drive folders. It contains three tools that share the same Google sign-in, Drive integration, progress tracking and job history:

| Tool | What it does | Output folder |
|---|---|---|
| **Photo Watermarker** | Adds a faint, see-through church logo watermark to the center of photographs, preserving dimensions, orientation and quality. | `Original Folder Name — Watermarked` |
| **Video Converter** | Converts videos from common formats into genuine, broadly compatible MP4 files. | `Original Folder Name — MP4 Converted` |
| **Church News** | Transcribes a church news video on this computer, lists the posters its announcements need, and renders the presenter into a news studio (portrait or landscape) with their name, timed main headlines and a moving headline bar. | Kept on this computer under `uploads/news/`; download from the page |

**Originals are never modified.** The Drive tools only *read* the source files and write new copies into a new folder.

---

## Features

### Photo Watermarker
- **Google Drive Integration**: Official OAuth 2.0 authentication. Paste any Google Drive folder link to instantly discover and batch process supported photographs.
- **Intelligent Watermarking**: Automatically scales the church logo proportionally and places it in the center as a faint, see-through watermark (opacity adjustable in Settings, default 35%, with a soft dark edge so it stays readable on bright photos).
- **Strict Quality & Dimension Preservation**: Maintains exact original dimensions (e.g., 6000x4000 remains 6000x4000), EXIF orientation, and high-fidelity encoding (JPEG 95, lossless PNG, high-quality WebP).
- **Subfolder Support**: Optional recursive scanning of subfolders.
- **Camera RAW files** (Canon .CR2, Nikon .NEF, Sony .ARW, .DNG and others): the full-size JPEG the camera embedded in the RAW file is watermarked and uploaded as `.jpg` (e.g. `IMG_8464.CR2` → `IMG_8464.jpg`).
- **Pause, resume, cancel and re-run**: a batch can be paused or cancelled from the progress screen; running a folder again skips photos already in its Watermarked folder.
- **Robust Error Handling & Retry**: Automatic exponential backoff retries for network/API glitches, with a detailed error report for any failed files without crashing the entire batch.
- **Admin Settings & Preview**: Upload/change church logo, preview watermark placement on a sample photo before batch processing, and view processing history.

### Video Converter
- **Real conversion, never a rename.** Every video is inspected with FFprobe and written by FFmpeg into a real MP4 container, then checked before upload.
- **Remux when safe, re-encode only when necessary** (see below) — H.264/AAC sources are copied bit-for-bit into MP4 with no quality loss.
- **Preserves** resolution, frame rate, orientation (including phone portrait video), all audio tracks, text subtitles, chapters and metadata wherever MP4 allows — and reports anything that could not be kept.
- **Validates every output** before uploading it (structure, streams, resolution, orientation, duration, frame rate, decodability).
- **Built for big files**: streaming, resumable downloads and uploads (10 GB+), MD5 verification of every transfer, disk-space-aware scheduling.
- **Batch-safe**: one bad video never stops the batch; per-video status, error report with recommended action, and "Retry failed videos".
- **Duplicate protection**: if the output folder already exists you choose *Create a new conversion folder*, *Reprocess into existing folder* (already-converted videos are skipped, nothing is overwritten) or *Cancel*.

### Church News
- **Local transcription**: OpenAI's Whisper model runs on this computer through Transformers.js (ONNX Runtime); no audio is sent to an online service. The model (about 140 MB for "Balanced") downloads once into `uploads/models/`, resuming after dropped connections. Settings choose the language, accuracy (tiny/base/small) and optional translation into English.
- **Poster finder**: plain rules, no paid AI (`src/services/posterService.js`). Sentences are grouped into announcements; one that names an event plus a date, time, place or way to sign up becomes a poster brief (title, when, where, who, cost, contact, the exact words and when they were said), with warnings such as "No venue was mentioned". Everything is editable on the page and exportable as text.
- **News studio**: the Remotion compositions from the greenscreen project live in `src/newsStudio/`. The server bundles them once and renders with Remotion's headless browser (downloaded once, about 100 MB). Output is H.264/AAC MP4, 720×1280 portrait or 1280×720 landscape. The presenter's name and position are typed in; main headlines are suggested from the posters with the time each is first mentioned, and are checked and edited before rendering.
- **Jobs**: transcription and studio work run in the background, one of each kind at a time, and their progress is saved with the project, so closing the page never stops them. Rendering is slow on small computers (about 12 minutes per minute of video on a 4-core, 4 GB PC); set `NEWS_RENDER_CONCURRENCY` to override the number of render tabs.
- **Storage**: each project is a folder in `uploads/news/<id>/` (video, transcript, posters, studio settings, preview, rendered video). Deleting a project on the page removes its folder. The headless renderer reads the video through `/news-media/`, which only answers requests from this computer.

---

## Video Converter: how it works

```
Google Drive folder ─► find videos ─► for each video (in parallel, bounded):
   download (resumable, MD5-verified)
   ─► analyze with FFprobe
   ─► plan: remux or re-encode, per stream
   ─► FFmpeg ─► validate output ─► (if a remux fails validation: one full re-encode attempt)
   ─► upload to "<Folder> — MP4 Converted" (resumable, verified) ─► delete temp files
```

### Supported input formats
MP4, MOV, M4V, AVI, MKV, WEBM, WMV, FLV, MPEG/MPG, 3GP/3G2, TS, MTS, M2TS, OGV (also VOB, MXF, DV, ASF). Files are recognised by extension or by Drive's `video/*` type; everything else in the folder is ignored. A recognised extension is not a promise: the actual content is inspected, and unreadable or corrupt files are reported as **Failed** (stage *Analysis*), audio-only files as **Skipped**.

### MP4 codec behaviour
The output is always an MP4 (`isom` brand) with the index at the front (`-movflags +faststart`) so it starts playing before it has fully downloaded.

| Source stream | What happens |
|---|---|
| H.264, 8-bit 4:2:0 | **Copied unchanged** (remux) |
| H.264 10-bit / 4:2:2 / 4:4:4 | Re-encoded to H.264 8-bit 4:2:0 (those profiles don't play on most devices) |
| H.265/HEVC | Re-encoded to H.264 by default (not universally playable, e.g. many Windows PCs/browsers). Admins can choose *Keep HEVC* to remux it instead. |
| VP8/VP9/AV1, MPEG-2, MPEG-4 Part 2/DivX/Xvid, WMV, FLV, Theora, ProRes, DV, … | Re-encoded to H.264 |
| AAC, MP3 audio | **Copied unchanged** |
| AC-3, E-AC-3, Opus, Vorbis, FLAC, PCM, WMA, MP2, … | Converted to AAC — 128 kbps per channel (256 kbps stereo, 640 kbps for 5.1), channels and sample rate kept |
| Additional audio tracks | All kept, with language tags |
| Text subtitles (SRT, ASS/SSA, WebVTT) | Kept as MP4 text subtitles (ASS styling is lost; noted in the report) |
| Image subtitles (PGS, DVD, DVB), attachments (fonts), data/timecode tracks, cover art, extra video angles | Cannot be stored in a compatible MP4 — **not carried over, and listed in the report** |
| Chapters, title, creation time, copyright, other container tags | Preserved; any tag MP4 cannot hold is listed in the report |

### Quality preservation when re-encoding
- H.264 High profile, **CRF 18** (visually lossless), preset *medium*, `yuv420p`.
- **Never** scales, crops, stretches, letterboxes or changes frame rate. 4K stays 4K; 24/25/30/50/60 fps stay as they are; variable-frame-rate phone video keeps its timing.
- **Orientation**: rotation metadata is read. Remuxed files keep the rotation flag; re-encoded files are physically rotated so portrait stays portrait everywhere.
- **Interlaced** sources (DV, MPEG-2, 1080i camcorders) are deinterlaced at the same frame rate (`bwdif`).
- **HDR** (HDR10/HLG) re-encoded to H.264 is tone-mapped to SDR so colours look right (requires FFmpeg with `zscale`; otherwise a warning is recorded).
- Odd pixel dimensions (e.g. 641×361) get a single row/column of padding — H.264 requires even sizes. This is the only case where the frame size can change, by 1 pixel, and it is noted.

### Output validation
Before upload each MP4 must pass: file exists and is non-trivial; MP4 box structure complete (`ftyp`, `moov`, not truncated); readable by FFprobe as MP4; video stream present with the expected codec; same number of audio tracks as planned (never silently silent); display resolution and orientation match the source; duration within tolerance; frame rate present (differences >5 % are flagged); and the first and last seconds decode cleanly (or every frame, if *Thorough check* is enabled). Source-vs-output properties are shown in the detailed report, and unexpected differences flag the video for review.

### Large files, concurrency and temporary files
- Transfers stream to disk; nothing is held in memory. Downloads resume with HTTP Range requests; uploads use Drive's resumable protocol in 32 MB chunks, so a dropped connection only resends one chunk. Both are verified against Drive's size/MD5.
- **Automatic concurrency**: 2 videos in flight at once (1 on machines under 4 GB RAM), and at most 1 CPU-heavy re-encode at a time (2 on 16+ core / 16 GB machines). Remuxes don't wait for the encode slot. Both limits can be set by an admin.
- **Disk space**: each video reserves ~2.3× its size in the temp folder (source + output + fast-start rewrite). A video waits if space is short, or fails with "Insufficient server disk space" if it can never fit.
- Converted output is written to `uploads/temp/video/<job>/` and always deleted when the video finishes, fails, or the server stops or restarts. The **downloaded original** is kept in `uploads/temp/video-cache/` only while it is still needed: until its MP4 is safely in Drive, or while a download or upload failure awaits a retry. That way, retries resume instead of downloading the whole file again, which on a slow connection would also trip Google's per-file download limit. Originals of corrupt or unconvertible videos are deleted immediately, and anything left in the cache for 3 days is removed at startup.
- **Google's per-file download limit** (`downloadQuotaExceeded`) is not a storage problem. When it happens the video shows *Waiting for Google limit* and the app retries automatically every hour for up to 24 hours, so a batch left running finishes on its own once the limit resets.
- Jobs are held in server memory: if the server restarts mid-job, run the folder again and choose **Reprocess into existing folder** — finished videos are skipped automatically.

### Errors and retries
Temporary problems (network drops, timeouts, HTTP 408/429/5xx, Drive rate limits) are retried automatically with exponential backoff and jitter (default 5 retries). Permanent problems (missing file, permission denied, corrupt media) are not retried. Each failure records the file, stage (Download, Analysis, Conversion, Validation, Upload), category, technical details and a recommended action, and can be retried from the results screen.

---

## Prerequisites

- Node.js (v18.15+; v20+ recommended)
- Google Cloud Console Project with Google Drive API enabled and OAuth 2.0 credentials (`Client ID` and `Client Secret`).
- **FFmpeg and FFprobe** (for the Video Converter and Church News), built with `libx264` and the native `aac` encoder. `zscale`, `bwdif` and `libx265` are used when present.

### Installing FFmpeg
- **Windows**: `winget install Gyan.FFmpeg` (or download a "full" build from gyan.dev and add its `bin` folder to PATH).
- **macOS**: `brew install ffmpeg`
- **Debian/Ubuntu**: `sudo apt install ffmpeg`
- **Docker**: add `RUN apt-get update && apt-get install -y ffmpeg` to your image.

If FFmpeg is not on the PATH, set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env` to the full executable paths. Restart the app after installing. If FFmpeg is missing, the photo tool keeps working and the Video Converter shows an "engine not installed" notice.

---

## Installation & Setup

1. Clone or download the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory with your Google OAuth credentials:
   ```env
   GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   SESSION_SECRET=your-secure-session-secret
   PORT=3000
   # Optional, only if FFmpeg is not on the PATH:
   # FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
   # FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe
   ```
4. Start the application:
   ```bash
   npm start
   ```
5. Open your browser and navigate to `http://localhost:3000`.

### Google Drive permissions
Both tools use the same sign-in and the same scopes (`drive.readonly` to find and read source files, `drive.file` to create the output folder and upload new files). The app never requests permission to modify or delete existing files. Converted videos carry a private app property linking them to their source video, which is how *Reprocess* knows what is already done.

### Deployment notes (Video Converter)
- The server needs FFmpeg, enough CPU for H.264 encoding, and temp disk space of roughly 2.5× the largest video (more for parallel videos) under `uploads/temp`.
- Serverless/request-time-limited hosts are unsuitable: conversions run as long-lived background work on the server. Use a VM, container or always-on host.
- Behind a reverse proxy, allow long-running requests only for the normal API calls (conversion itself runs in the background; the page polls for progress).
- Large uploads count against the signed-in user's Google Drive storage quota.

---

## Running Automated Tests

```bash
npm test
```

- `tests/imageService.test.js` — photo watermarking (landscape, portrait, square; dimension preservation).
- `tests/videoService.test.js` — planning logic plus **real FFmpeg conversions** of synthetic MOV, MP4, M4V, MKV (multi-audio + subtitles), MTS, M2TS, AVI, WEBM, 3GP, WMV, FLV, OGV, interlaced MPG, portrait (rotated and native), square, 4K 10-bit 60 fps, HDR HEVC, no-audio, odd-size, very short, audio-only and corrupt files; verifies bit-identical remux, metadata, and truncated-file detection.
- `tests/videoJobService.test.js` — the whole batch pipeline against a simulated Drive (mixed success/failure/skip, name collisions, reprocessing, cancellation, temp cleanup, originals untouched).
- `tests/driveVideoTransfer.test.js` — resumable download/upload recovery and checksum verification.

The real-media tests are skipped automatically if FFmpeg is not installed. The first run generates the test videos (under `uploads/temp/test-fixtures`) and is CPU-heavy; on slow machines this can make the photo tests' 10-second timeouts expire on that first run only — re-run, or run `npx jest --runInBand`.

---

## Troubleshooting

- **Google Auth Error**: Ensure your Google Cloud Console OAuth consent screen has your email added as a test user, and `http://localhost:3000/auth/google/callback` is registered as an authorized redirect URI.
- **Logo Transparency**: Ensure your uploaded logo is a transparent PNG. Avoid flattening onto a white background.
- **"Video engine not installed"**: install FFmpeg (see above) or set `FFMPEG_PATH`/`FFPROBE_PATH`, then restart.
- **A video failed with "Unreadable or unsupported file"**: the file is corrupt, incomplete (e.g. a recording that was cut off) or not really a video. Try playing it; if it plays, re-export it and retry.
- **"Insufficient server disk space"**: free space on the server or lower *Videos at once* in Admin Settings.
- **Conversion is slow**: re-encoding 4K is CPU-intensive. Remuxed videos are fast; re-encoded ones take roughly real-time or longer on modest hardware. A faster *Encoding speed* preset trades file size for speed (quality stays set by CRF).
