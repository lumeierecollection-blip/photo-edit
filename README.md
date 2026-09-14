# Church Photo Watermarker (Google Drive Batch Processing System)

A production-ready web application built for church media teams to batch-process photographs stored inside Google Drive folders by automatically applying a church logo watermark at the bottom-center while strictly preserving original dimensions, EXIF orientation, color space, and image quality.

---

## Features

- **Google Drive Integration**: Official OAuth 2.0 authentication. Paste any Google Drive folder link to instantly discover and batch process supported photographs.
- **Intelligent Watermarking**: Automatically scales the church logo proportionally (default 12% width) and positions it at the bottom-center (default 3% bottom margin) with full alpha transparency support.
- **Strict Quality & Dimension Preservation**: Maintains exact original dimensions (e.g., 6000x4000 remains 6000x4000), EXIF orientation, and high-fidelity encoding (JPEG 95, lossless PNG, high-quality WebP).
- **Originals Untouched**: The source folder and its original photographs remain completely untouched. Processed copies are automatically uploaded into a newly created Google Drive folder (`Original Folder Name — Watermarked`).
- **Subfolder Support**: Optional recursive scanning of subfolders.
- **Robust Error Handling & Retry**: Automatic exponential backoff retries for network/API glitches, with a detailed error report for any failed files without crashing the entire batch.
- **Admin Settings & Preview**: Upload/change church logo, preview watermark placement on a sample photo before batch processing, and view processing history.
- **Professional Media UI**: Clean, responsive Tailwind CSS interface designed specifically for media teams without clutter or confusing developer jargon.

---

## Prerequisites

- Node.js (v18+ recommended)
- Google Cloud Console Project with Google Drive API enabled and OAuth 2.0 credentials (`Client ID` and `Client Secret`).

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
   ```
4. Start the application:
   ```bash
   npm start
   ```
5. Open your browser and navigate to `http://localhost:3000`.

---

## Running Automated Tests

To run the automated test suite (verifying landscape, portrait, square watermarking, EXIF normalization, and dimension preservation):
```bash
npm test
```

---

## Troubleshooting

- **Google Auth Error**: Ensure your Google Cloud Console OAuth consent screen has your email added as a test user, and `http://localhost:3000/auth/google/callback` is registered as an authorized redirect URI.
- **Logo Transparency**: Ensure your uploaded logo is a transparent PNG. Avoid flattening onto a white background.
