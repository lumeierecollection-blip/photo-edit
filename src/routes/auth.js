const express = require('express');
const router = express.Router();
const { createOAuthClient } = require('../services/driveService');

// Scopes required for Google Drive read/write
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly'
];

router.get('/google', (req, res) => {
  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=AuthenticationFailed');
  }

  const oauth2Client = createOAuthClient();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Error getting tokens:', err);
    res.redirect('/?error=TokenExchangeFailed');
  }
});

router.get('/status', (req, res) => {
  if (req.session && req.session.tokens) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
