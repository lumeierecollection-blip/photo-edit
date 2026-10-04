const express = require('express');
const router = express.Router();
const { createOAuthClient, getOAuthConfigStatus } = require('../services/driveService');

// Scopes required for Google Drive read/write
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly'
];

router.get('/google', (req, res) => {
  // Without credentials the generated URL would carry an empty client_id and
  // Google would answer "Error 400: invalid_request". Say what is actually
  // wrong instead, since only a local .env file can fix it.
  const config = getOAuthConfigStatus();
  if (!config.configured) {
    return res.status(500).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Google sign-in is not configured</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1.5rem;line-height:1.6;color:#111}
code{background:#f1f5f9;padding:.15rem .4rem;border-radius:4px}pre{background:#f1f5f9;padding:1rem;border-radius:8px;overflow-x:auto}
.box{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:1rem 1.25rem}</style></head>
<body>
<h1>Google sign-in is not configured on this computer</h1>
<div class="box"><p><strong>Missing:</strong> ${config.missing.map(m => `<code>${m}</code>`).join(', ')}</p></div>
<p>The application reads these from a file named <code>.env</code> in the project folder. That file is deliberately never
copied to GitHub, so a new computer starts without it.</p>
<h2>How to fix</h2>
<ol>
<li>Copy <code>.env</code> from the computer where this already works, into:<pre>${process.cwd()}</pre></li>
<li>Or create it from <code>.env.example</code> and paste the values from your existing
<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console credentials page</a>
(open your existing OAuth client — do <strong>not</strong> create a new one).</li>
<li>Stop the application and run <code>npm start</code> again. The file is only read at startup.</li>
</ol>
<p>Redirect URI this computer will use: <code>${config.redirectUri}</code>${config.usingDefaultRedirectUri ? ' (default)' : ''}<br>
This exact address must be listed under "Authorised redirect URIs" on that same OAuth client.</p>
<p><a href="/">&larr; Back to the application</a></p>
</body></html>`);
  }

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
  // `configured` lets the sign-in screen warn before the user clicks through
  // to Google. Only the names of missing variables are reported, never values.
  const config = getOAuthConfigStatus();
  res.json({
    authenticated: Boolean(req.session && req.session.tokens),
    configured: config.configured,
    missing: config.missing
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
