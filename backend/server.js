const express = require('express');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./auth');
const resolveRoutes = require('./routes/resolve');

const app = express();
const PORT = process.env.PORT || 8888;

// Needed so POST /auth/device (used for the debug panel) can read a JSON body.
app.use(express.json());

// Render (and most PaaS hosts) sit behind a reverse proxy — this makes
// req.protocol/req.secure resolve correctly if that's ever relied on later.
app.set('trust proxy', 1);

// Mount Spotify auth routes (login / callback / token / status / debug)
app.use('/auth', authRoutes);

// Song resolution (search -> filter -> rank -> confidence gate) runs server-side.
app.use('/api', resolveRoutes);

// shared/intent.js is used by both the browser and the server, so serve it too.
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// Serve the frontend as static files
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
  console.log(`Akon server running on port ${PORT}`);
  if (!process.env.SPOTIFY_REDIRECT_URI) {
    console.warn('[Akon] WARNING: SPOTIFY_REDIRECT_URI is not set — check your .env file.');
  } else {
    console.log(`[Akon] Using Spotify redirect URI: ${process.env.SPOTIFY_REDIRECT_URI}`);
    console.log('[Akon] This must exactly match a Redirect URI in your Spotify Dashboard app settings.');
  }
});
