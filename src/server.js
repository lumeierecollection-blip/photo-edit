const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'church-media-watermark-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
  })
);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/drive', require('./routes/drive'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/history', require('./routes/history'));
app.use('/api/video', require('./routes/video'));
const newsRoutes = require('./routes/news');
app.use('/api/news', newsRoutes);
app.use('/news-media', newsRoutes.mediaRouter);

const videoJobs = require('./services/videoJobService');
videoJobs.sweepStaleTempFiles();
videoJobs.installShutdownHandlers();
require('./services/newsProjectService').markInterruptedJobs();

// Fallback to index.html for SPA routing
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Church Media Tools running on http://localhost:${PORT}`);

  // Surface missing Google credentials at startup rather than at the moment a
  // user clicks "Sign in with Google" and lands on a Google error page.
  const oauthConfig = require('./services/driveService').getOAuthConfigStatus();
  if (!oauthConfig.configured) {
    console.warn(`\n  WARNING: Google sign-in is not configured. Missing: ${oauthConfig.missing.join(', ')}`);
    console.warn(`  Create a .env file in ${process.cwd()} (copy .env.example, or copy .env from your other computer),`);
    console.warn('  then restart. Google Drive features stay unavailable until then.\n');
  }
});

module.exports = app;
