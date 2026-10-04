const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
const UNSUPPORTED_MIME_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',
  'video/'
];

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

// The OAuth client id/secret come from environment variables, loaded from the
// local .env by server.js. That file is git-ignored, so a fresh machine has no
// credentials until it is copied across. Without them Google rejects sign-in
// with "Missing required parameter: client_id", so the auth routes check here
// first and explain what is missing instead of sending a broken request.
function getOAuthConfigStatus() {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
    .filter(name => !(process.env[name] || '').trim());

  return {
    configured: missing.length === 0,
    missing,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    usingDefaultRedirectUri: !(process.env.GOOGLE_REDIRECT_URI || '').trim()
  };
}

function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function extractFolderId(inputUrl) {
  if (!inputUrl) return null;
  const trimmed = inputUrl.trim();
  const folderRegex = /folders\/([a-zA-Z0-9-_]+)/;
  const match = trimmed.match(folderRegex);
  if (match && match[1]) {
    return match[1];
  }
  const idQueryRegex = /[?&]id=([a-zA-Z0-9-_]+)/;
  const matchQuery = trimmed.match(idQueryRegex);
  if (matchQuery && matchQuery[1]) {
    return matchQuery[1];
  }
  if (/^[a-zA-Z0-9-_]{10,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

// One OAuth client per tokens object, so a long-running job keeps (and reuses)
// the access token it refreshes instead of refreshing on every Drive call.
const authClients = new WeakMap();

function getAuthClient(tokens) {
  let client = authClients.get(tokens);
  if (!client) {
    client = createOAuthClient();
    client.setCredentials(tokens);
    client.on('tokens', fresh => Object.assign(tokens, fresh));
    authClients.set(tokens, client);
  }
  return client;
}

async function getDriveClient(tokens) {
  return google.drive({ version: 'v3', auth: getAuthClient(tokens) });
}

async function validateFolder(tokens, folderUrl) {
  const folderId = extractFolderId(folderUrl);
  if (!folderId) {
    throw new Error('Invalid Google Drive folder link or ID.');
  }

  const drive = await getDriveClient(tokens);
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, mimeType, capabilities'
    });

    const folder = res.data;
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('The provided link is not a Google Drive folder.');
    }

    return {
      folderId: folder.id,
      folderName: folder.name
    };
  } catch (err) {
    throw new Error(`Unable to access Google Drive folder: ${err.message}`);
  }
}

async function listPhotosInFolder(tokens, folderId, includeSubfolders = false) {
  const drive = await getDriveClient(tokens);
  
  const photos = [];
  let ignoredCount = 0;
  const foldersToScan = [folderId];
  const scannedFolders = new Set();

  while (foldersToScan.length > 0) {
    const currentFolderId = foldersToScan.shift();
    if (scannedFolders.has(currentFolderId)) continue;
    scannedFolders.add(currentFolderId);

    let pageToken = null;
    do {
      try {
        const res = await drive.files.list({
          q: `'${currentFolderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, webContentLink)',
          pageToken: pageToken,
          pageSize: 100
        });

        const files = res.data.files || [];
        for (const file of files) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            if (includeSubfolders) {
              foldersToScan.push(file.id);
            }
            continue;
          }

          const ext = path.extname(file.name).toLowerCase();
          const isSupported = SUPPORTED_EXTENSIONS.includes(ext) || file.mimeType.startsWith('image/');

          if (isSupported) {
            photos.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              md5Checksum: file.md5Checksum
            });
          } else {
            ignoredCount++;
          }
        }
        pageToken = res.data.nextPageToken;
      } catch (err) {
        console.error(`Error listing files in folder ${currentFolderId}:`, err.message);
        break;
      }
    } while (pageToken);
  }

  return { photos, ignoredCount };
}

// Pass { signal } (an AbortSignal) to stop a transfer part-way, e.g. when a
// batch is paused or cancelled; the promise then rejects with an AbortError.
async function downloadFile(tokens, fileId, destPath, { signal } = {}) {
  const drive = await getDriveClient(tokens);

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    throwIfAborted(signal);
    try {
      const res = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream', signal }
      );

      return await new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(destPath);
        const onAbort = () => res.data.destroy(abortError());
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        res.data
          .on('error', err => {
            if (signal) signal.removeEventListener('abort', onAbort);
            dest.destroy();
            fs.unlink(destPath, () => {});
            reject(err);
          })
          .pipe(dest)
          .on('finish', () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(destPath);
          });
      });
    } catch (err) {
      if ((signal && signal.aborted) || err.name === 'AbortError') throw abortError();
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Failed to download file after ${maxRetries} attempts: ${err.message}`);
      }
      await sleep(Math.pow(2, attempt) * 1000, signal);
    }
  }
}

async function createOutputFolder(tokens, parentFolderId, folderName) {
  const drive = await getDriveClient(tokens);
  
  try {
    const checkRes = await drive.files.list({
      q: `'${parentFolderId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, webViewLink)'
    });

    if (checkRes.data.files && checkRes.data.files.length > 0) {
      return {
        folderId: checkRes.data.files[0].id,
        folderName: checkRes.data.files[0].name,
        webViewLink: checkRes.data.files[0].webViewLink,
        exists: true
      };
    }
  } catch (err) {
    console.error('Error checking existing output folder:', err.message);
  }

  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId]
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    fields: 'id, name, webViewLink'
  });

  return {
    folderId: res.data.id,
    folderName: res.data.name,
    webViewLink: res.data.webViewLink,
    exists: false
  };
}

async function uploadFile(tokens, outputFolderId, filePath, fileName, { signal } = {}) {
  const drive = await getDriveClient(tokens);
  const fileMetadata = {
    name: fileName,
    parents: [outputFolderId]
  };

  const ext = path.extname(fileName).toLowerCase();
  let mimeType = 'image/jpeg';
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.heic' || ext === '.heif') mimeType = 'image/heic';

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    throwIfAborted(signal);
    try {
      // A fresh stream every attempt: a retry must not reuse one that the
      // failed attempt already read, or it would upload an empty file.
      const res = await drive.files.create({
        resource: fileMetadata,
        media: { mimeType, body: fs.createReadStream(filePath) },
        fields: 'id, name, webViewLink'
      }, { signal });
      return res.data;
    } catch (err) {
      if ((signal && signal.aborted) || err.name === 'AbortError') throw abortError();
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Failed to upload file after ${maxRetries} attempts: ${err.message}`);
      }
      await sleep(Math.pow(2, attempt) * 1000, signal);
    }
  }
}

// ---------------------------------------------------------------------------
// Video-grade Drive helpers (used by the Video Converter).
//
// Videos can be many gigabytes, so these helpers stream to/from disk, resume
// interrupted transfers (HTTP Range downloads, Drive resumable uploads),
// verify what was transferred, and retry only failures that are temporary.
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.mpeg', '.mpg',
  '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.ogv', '.vob', '.mxf', '.dv', '.asf'
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Small chunks so each request finishes in seconds even on a slow, unstable
// link; a dropped connection then costs one chunk, not minutes of upload.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const UPLOAD_CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_STALL_MS = 60 * 1000; // no bytes for this long = dead connection
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'ERR_NETWORK', 'ERR_BAD_RESPONSE'
]);
// Local problems that retrying cannot fix.
const LOCAL_FS_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EMFILE']);
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function isVideoFile(file) {
  if (!file || !file.name) return false;
  if (file.mimeType && file.mimeType.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.includes(path.extname(file.name).toLowerCase());
}

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function httpStatusOf(err) {
  if (!err) return null;
  if (err.response && err.response.status) return err.response.status;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.code === 'number') return err.code;
  return null;
}

function isTransientError(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.transient) return true;
  if (TRANSIENT_NET_CODES.has(err.code)) return true;
  const status = httpStatusOf(err);
  if (status && TRANSIENT_HTTP.has(status)) return true;
  if (status === 403) {
    const reasons = JSON.stringify((err.response && err.response.data) || err.errors || '');
    return /rateLimitExceeded|userRateLimitExceeded/.test(reasons);
  }
  // "aborted"/"terminated" are what Node reports when a connection drops
  // mid-download; they carry no error code.
  return /socket hang up|network|timeout|aborted|terminated|premature|reset/i.test(err.message || '');
}

// During a byte transfer, any failure without an HTTP status is the network
// letting go (drop, reset, stall) — retry it. HTTP errors and local disk
// problems keep their normal classification.
function isTransferRetryable(err) {
  if (!err || err.name === 'AbortError') return false;
  if (isTransientError(err)) return true;
  if (LOCAL_FS_CODES.has(err.code)) return false;
  return httpStatusOf(err) == null;
}

function abortError() {
  const err = new Error('Cancelled by user.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function backoffDelay(attempt) {
  // 2s, 4s, 8s, 16s ... capped at 60s, with jitter so parallel jobs don't sync up.
  const base = Math.min(60000, 1000 * Math.pow(2, attempt));
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Runs fn(), retrying temporary failures with exponential backoff.
async function withRetry(fn, { retries = 5, signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    throwIfAborted(signal);
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      if (!isTransientError(err) || attempt >= retries) throw err;
      attempt++;
      if (onRetry) onRetry(attempt, err);
      await sleep(backoffDelay(attempt), signal);
    }
  }
}

async function getFolder(tokens, folderId) {
  const drive = await getDriveClient(tokens);
  const res = await withRetry(() => drive.files.get({
    fileId: folderId,
    fields: 'id, name, mimeType, parents, webViewLink, trashed',
    supportsAllDrives: true
  }));
  if (res.data.mimeType !== FOLDER_MIME || res.data.trashed) {
    throw new Error('The output location is not an available Google Drive folder.');
  }
  return res.data;
}

async function listFolderChildren(tokens, folderId, extraQuery = '', fields = 'id, name, mimeType, size, md5Checksum, appProperties') {
  const drive = await getDriveClient(tokens);
  const files = [];
  let pageToken;
  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${escapeQueryValue(folderId)}' in parents and trashed = false${extraQuery}`,
      fields: `nextPageToken, files(${fields})`,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    }));
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function listVideosInFolder(tokens, folderId, includeSubfolders = false) {
  const videos = [];
  let ignoredCount = 0;
  const foldersToScan = [folderId];
  const scanned = new Set();

  while (foldersToScan.length > 0) {
    const current = foldersToScan.shift();
    if (scanned.has(current)) continue;
    scanned.add(current);

    const children = await listFolderChildren(
      tokens, current, '',
      'id, name, mimeType, size, md5Checksum, appProperties, videoMediaMetadata(width, height, durationMillis)'
    );
    for (const file of children) {
      if (file.mimeType === FOLDER_MIME) {
        // Never descend into our own output folders when scanning subfolders.
        if (includeSubfolders && !/— MP4 Converted/.test(file.name)) foldersToScan.push(file.id);
        continue;
      }
      if (file.mimeType === 'application/vnd.google-apps.shortcut' || !isVideoFile(file)) {
        ignoredCount++;
        continue;
      }
      videos.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size != null ? Number(file.size) : null,
        md5Checksum: file.md5Checksum || null,
        driveMetadata: file.videoMediaMetadata || null
      });
    }
  }

  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { videos, ignoredCount };
}

async function findChildFolders(tokens, parentFolderId, folderName) {
  return listFolderChildren(
    tokens, parentFolderId,
    ` and mimeType = '${FOLDER_MIME}' and name = '${escapeQueryValue(folderName)}'`,
    'id, name, webViewLink, createdTime'
  );
}

// Always creates a brand-new folder (never reuses one with the same name).
async function createFolder(tokens, parentFolderId, folderName) {
  const drive = await getDriveClient(tokens);
  const res = await withRetry(() => drive.files.create({
    requestBody: { name: folderName, mimeType: FOLDER_MIME, parents: [parentFolderId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true
  }));
  return { folderId: res.data.id, folderName: res.data.name, webViewLink: res.data.webViewLink };
}

function md5OfFile(filePath, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    const onAbort = () => stream.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(hash.digest('hex'));
    });
  });
}

const fileSizeOnDisk = p => (fs.existsSync(p) ? fs.statSync(p).size : 0);

// Google caps how much one file can be downloaded per ~24h. That is not an
// error in the file or the account; the only remedy is to wait.
function isDownloadQuotaError(err) {
  if (httpStatusOf(err) !== 403) return false;
  const details = `${err.message} ${JSON.stringify((err.response && err.response.data) || err.errors || '')}`;
  return /downloadQuotaExceeded|download quota/i.test(details);
}

// Streams a Drive file to disk. Interrupted downloads resume from where they
// stopped (HTTP Range), and the result is checked against Drive's size/MD5.
// `retries` limits CONSECUTIVE attempts that fetch no new bytes: on a flaky
// connection the download keeps resuming for as long as it is progressing.
// When Google's per-file download limit is hit, waits `quotaWaitMs` and tries
// again, up to `maxQuotaWaits` times (default: hourly for a day), so an
// unattended batch finishes once the limit resets instead of failing.
async function downloadFileToDisk(tokens, file, destPath, {
  retries = 5, signal, onProgress, onRetry, onQuotaWait,
  quotaWaitMs = 60 * 60 * 1000, maxQuotaWaits = 0
} = {}) {
  const drive = await getDriveClient(tokens);
  const expectedSize = file.size != null ? Number(file.size) : null;
  let failuresWithoutProgress = 0;
  let quotaWaits = 0;

  for (;;) {
    throwIfAborted(signal);
    const before = fileSizeOnDisk(destPath);
    try {
      await downloadAttempt(drive, file, destPath, expectedSize, { signal, onProgress });
      return destPath;
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      if (isDownloadQuotaError(err) && quotaWaits < maxQuotaWaits) {
        quotaWaits++;
        if (onQuotaWait) onQuotaWait(quotaWaits, new Date(Date.now() + quotaWaitMs));
        await sleep(quotaWaitMs, signal);
        continue;
      }
      if (!isTransferRetryable(err)) throw err;
      failuresWithoutProgress = fileSizeOnDisk(destPath) > before ? 0 : failuresWithoutProgress + 1;
      if (failuresWithoutProgress > retries) {
        throw new Error(`Download kept failing with no progress (${retries} attempts in a row): ${err.message}`);
      }
      if (onRetry) onRetry(failuresWithoutProgress, err);
      await sleep(backoffDelay(Math.max(1, failuresWithoutProgress)), signal);
    }
  }
}

async function downloadAttempt(drive, file, destPath, expectedSize, { signal, onProgress }) {
  let offset = fileSizeOnDisk(destPath);
  if (expectedSize != null && offset > expectedSize) offset = 0;

  if (expectedSize == null || offset < expectedSize) {
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', headers, signal }
    );
    if (offset > 0 && res.status !== 206) offset = 0; // range ignored; start over

    // A connection can go silent without ever closing; treat 60s with no
    // bytes as a drop so the download resumes instead of hanging forever.
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        res.data.destroy(Object.assign(new Error('Download stalled (no data for 60s).'), { transient: true }));
      }, DOWNLOAD_STALL_MS);
    };

    let received = offset;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        armStall();
        if (onProgress) onProgress(received, expectedSize);
        cb(null, chunk);
      }
    });
    armStall();
    try {
      await pipeline(res.data, counter, fs.createWriteStream(destPath, { flags: offset > 0 ? 'a' : 'w' }), { signal });
    } finally {
      clearTimeout(stallTimer);
    }
  }

  const actualSize = fileSizeOnDisk(destPath);
  if (expectedSize != null && actualSize !== expectedSize) {
    const err = new Error(`Download incomplete (${actualSize} of ${expectedSize} bytes).`);
    err.transient = true;
    throw err;
  }
  if (file.md5Checksum) {
    const md5 = await md5OfFile(destPath, signal);
    if (md5 !== file.md5Checksum) {
      fs.rmSync(destPath, { force: true });
      const err = new Error('Downloaded file failed its integrity check (MD5 mismatch).');
      err.transient = true;
      throw err;
    }
  }
}

function nextOffsetFromRange(rangeHeader) {
  // Drive reports what it has as "bytes=0-12345"; no header means nothing yet.
  const match = /bytes=0-(\d+)/.exec(rangeHeader || '');
  return match ? Number(match[1]) + 1 : 0;
}

// Uploads a local file with Drive's resumable protocol in chunks, so a network
// blip only re-sends the current chunk rather than the whole (huge) file.
async function uploadFileResumable(tokens, folderId, filePath, fileName, {
  mimeType = 'application/octet-stream', appProperties, retries = 5, signal, onProgress, onRetry
} = {}) {
  const auth = getAuthClient(tokens);
  const size = fs.statSync(filePath).size;
  const localMd5 = await md5OfFile(filePath, signal);
  const authHeaders = async () => ({ Authorization: `Bearer ${(await auth.getAccessToken()).token}` });
  const okOrIncomplete = status => status === 308 || (status >= 200 && status < 300);

  let sessionUri = null;
  let offset = 0;
  let needsStatusCheck = false;
  let attempt = 0;
  let result = null;

  while (!result) {
    throwIfAborted(signal);
    try {
      if (!sessionUri) {
        const init = await axios.post(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
          { name: fileName, parents: [folderId], mimeType, appProperties },
          {
            headers: {
              ...(await authHeaders()),
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': mimeType,
              'X-Upload-Content-Length': String(size)
            },
            signal
          }
        );
        sessionUri = init.headers.location;
        offset = 0;
        needsStatusCheck = false;
      }

      if (needsStatusCheck) {
        const status = await axios.put(sessionUri, null, {
          headers: { ...(await authHeaders()), 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
          validateStatus: okOrIncomplete,
          timeout: 60 * 1000,
          signal
        });
        needsStatusCheck = false;
        if (status.status !== 308) { result = status.data; break; }
        const confirmed = nextOffsetFromRange(status.headers.range);
        if (confirmed > offset) attempt = 0; // part of the failed chunk got through
        offset = confirmed;
      }

      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, size) - 1;
      const headers = {
        ...(await authHeaders()),
        'Content-Length': String(end - offset + 1),
        'Content-Range': `bytes ${offset}-${end}/${size}`
      };
      const chunk = fs.createReadStream(filePath, { start: offset, end });
      chunk.on('error', () => {}); // read errors surface through the request itself
      let res;
      try {
        res = await axios.put(sessionUri, chunk, {
          headers,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          validateStatus: okOrIncomplete,
          timeout: UPLOAD_CHUNK_TIMEOUT_MS,
          signal
        });
      } finally {
        chunk.destroy(); // release the file handle even if the request failed early
      }
      if (res.status === 308) {
        offset = nextOffsetFromRange(res.headers.range);
        attempt = 0;
        if (onProgress) onProgress(offset, size);
      } else {
        result = res.data;
      }
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      const status = httpStatusOf(err);
      if (status === 404 || status === 410) {
        sessionUri = null; // upload session expired; begin a fresh one
      } else if (!isTransferRetryable(err)) {
        throw new Error(`Upload rejected by Google Drive: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
      }
      // `attempt` counts consecutive failures with no chunk accepted; it resets
      // whenever Drive confirms more bytes, so a long upload over a flaky link
      // keeps going for as long as it is making progress.
      if (attempt >= retries) throw new Error(`Upload kept failing with no progress (${retries} attempts in a row): ${err.message}`);
      attempt++;
      if (onRetry) onRetry(attempt, err);
      await sleep(backoffDelay(attempt), signal);
      if (sessionUri) needsStatusCheck = true;
    }
  }
  if (onProgress) onProgress(size, size);

  // Confirm the file really exists in Drive with the exact bytes we sent.
  const drive = await getDriveClient(tokens);
  const check = await withRetry(() => drive.files.get({
    fileId: result.id,
    fields: 'id, name, size, md5Checksum, webViewLink, parents',
    supportsAllDrives: true
  }), { retries, signal });
  const uploaded = check.data;
  if (Number(uploaded.size) !== size || (uploaded.md5Checksum && uploaded.md5Checksum !== localMd5)) {
    throw new Error('Uploaded file in Google Drive does not match the converted file (size/MD5 mismatch).');
  }
  return uploaded;
}

module.exports = {
  createOAuthClient,
  getOAuthConfigStatus,
  extractFolderId,
  validateFolder,
  listPhotosInFolder,
  downloadFile,
  createOutputFolder,
  uploadFile,
  // Video Converter helpers
  VIDEO_EXTENSIONS,
  isVideoFile,
  isTransientError,
  isDownloadQuotaError,
  withRetry,
  getFolder,
  listFolderChildren,
  listVideosInFolder,
  findChildFolders,
  createFolder,
  downloadFileToDisk,
  uploadFileResumable
};
