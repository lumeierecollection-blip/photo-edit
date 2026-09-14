const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
const UNSUPPORTED_MIME_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',
  'video/'
];

function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

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

async function getDriveClient(tokens) {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
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
          fields: 'nextPageToken, files(id, name, mimeType, size, webContentLink)',
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
              size: file.size
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

async function downloadFile(tokens, fileId, destPath) {
  const drive = await getDriveClient(tokens);
  const dest = fs.createWriteStream(destPath);

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    try {
      const res = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      return new Promise((resolve, reject) => {
        res.data
          .on('end', () => resolve(destPath))
          .on('error', err => {
            fs.unlink(destPath, () => {});
            reject(err);
          })
          .pipe(dest);
      });
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Failed to download file after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
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

async function uploadFile(tokens, outputFolderId, filePath, fileName) {
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

  const media = {
    mimeType: mimeType,
    body: fs.createReadStream(filePath)
  };

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    try {
      const res = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink'
      });
      return res.data;
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Failed to upload file after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

module.exports = {
  createOAuthClient,
  extractFolderId,
  validateFolder,
  listPhotosInFolder,
  downloadFile,
  createOutputFolder,
  uploadFile
};
