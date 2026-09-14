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

// Fallback to index.html for SPA routing
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Church Photo Watermarker running on http://localhost:${PORT}`);
});

module.exports = app;
