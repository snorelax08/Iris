const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();

const router = express.Router();

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.SPOTIFY_REDIRECT_URI;

// In-memory token store.
// This is intentionally simple (single-user, local dev app).
// For a multi-user production app you'd store this per-session/per-user in a database.
const tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null // epoch ms
};

// Diagnostics only — never contains secrets. Populated by the frontend via
// POST /auth/device once the Web Playback SDK reports a device id, and by
// refreshAccessToken() below. Surfaced read-only via GET /auth/debug.
let lastRefreshedAt = null; // epoch ms
let lastKnownDeviceId = null;

function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Step 1: Redirect user to Spotify's consent screen
router.get('/login', (req, res) => {
  const state = generateRandomString(16);

  // Scopes needed:
  // - streaming: required for Web Playback SDK
  // - user-read-email / user-read-private: required by SDK for the player device
  // - user-read-playback-state / user-modify-playback-state: control playback via Web API
  const scope = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state'
  ].join(' ');

  res.redirect(
    'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id,
        scope,
        redirect_uri,
        state
      })
  );
});

// Step 2: Spotify redirects back here with an auth code
router.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const error = req.query.error || null;

  if (error || !code) {
    return res.redirect('/?error=access_denied');
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
        }
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    tokenStore.access_token = access_token;
    tokenStore.refresh_token = refresh_token;
    tokenStore.expires_at = Date.now() + expires_in * 1000;
    lastRefreshedAt = Date.now();

    console.log('[Akon:auth] Login successful, tokens stored.');
    res.redirect('/?logged_in=true');
  } catch (err) {
    console.error('Token exchange failed:', err.response ? err.response.data : err.message);
    res.redirect('/?error=invalid_token');
  }
});

// Refresh the access token using the stored refresh token
async function refreshAccessToken() {
  if (!tokenStore.refresh_token) {
    throw new Error('No refresh token available');
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenStore.refresh_token
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
      }
    }
  );

  tokenStore.access_token = response.data.access_token;
  tokenStore.expires_at = Date.now() + response.data.expires_in * 1000;
  lastRefreshedAt = Date.now();

  // Spotify sometimes rotates the refresh token too
  if (response.data.refresh_token) {
    tokenStore.refresh_token = response.data.refresh_token;
  }

  console.log('[Akon:auth] Access token refreshed.');
  return tokenStore.access_token;
}

// Single source of truth for "give me a usable access token" — used by GET /token
// (browser SDK) and by the server-side song resolver (/api/resolve).
async function getValidAccessToken() {
  if (!tokenStore.access_token) {
    const e = new Error('not_logged_in');
    e.status = 401;
    throw e;
  }
  if (Date.now() > tokenStore.expires_at - 60 * 1000) {
    try {
      await refreshAccessToken();
    } catch (err) {
      console.error('Token refresh failed:', err.response ? err.response.data : err.message);
      const e = new Error('refresh_failed');
      e.status = 401;
      throw e;
    }
  }
  return tokenStore.access_token;
}

// Frontend polls/calls this to get a valid access token.
// Automatically refreshes if the token is expired or about to expire.
router.get('/token', async (req, res) => {
  try {
    res.json({ access_token: await getValidAccessToken() });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Simple check so the frontend knows whether to show "Connect Spotify" or the app
router.get('/status', (req, res) => {
  res.json({ logged_in: !!tokenStore.access_token });
});

// The frontend calls this once the Web Playback SDK reports a device id.
// Purely for the debug panel below — never used for auth decisions.
router.post('/device', (req, res) => {
  const deviceId = req.body && req.body.device_id;
  if (deviceId) {
    lastKnownDeviceId = deviceId;
    console.log(`[Akon:device] Frontend reported device id: ${deviceId}`);
  }
  res.json({ ok: true });
});

// Diagnostics endpoint. Deliberately excludes access_token, refresh_token,
// and client_secret — only shape/timing info a developer needs to debug
// auth or device-activation issues from the browser console or curl.
router.get('/debug', (req, res) => {
  res.json({
    logged_in: !!tokenStore.access_token,
    has_refresh_token: !!tokenStore.refresh_token,
    token_expires_at: tokenStore.expires_at ? new Date(tokenStore.expires_at).toISOString() : null,
    seconds_until_expiry: tokenStore.expires_at
      ? Math.max(0, Math.round((tokenStore.expires_at - Date.now()) / 1000))
      : null,
    last_refreshed_at: lastRefreshedAt ? new Date(lastRefreshedAt).toISOString() : null,
    last_known_device_id: lastKnownDeviceId,
    configured_redirect_uri: redirect_uri || null
  });
});

module.exports = router;
module.exports.getValidAccessToken = getValidAccessToken;
