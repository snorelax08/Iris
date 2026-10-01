/**
 * SpotifyController
 * Handles the Spotify Web Playback SDK (in-browser player device) and
 * the Spotify Web API (playback control only; search lives in the backend).
 *
 * IMPORTANT: This ONLY controls playback on the Web Playback SDK device
 * created in this browser tab. It never touches the Spotify desktop app.
 *
 * Note: this module is named "SpotifyController" (not "Spotify") to avoid
 * clashing with the global `Spotify` object injected by the SDK script.
 *
 * v2 (post-audit) changes:
 *  - Fixed a race condition where window.onSpotifyWebPlaybackSDKReady could
 *    fire before init() was called, silently dropping the ready event.
 *  - Explicitly transfers playback to this browser device on ready, with
 *    retry/backoff, so the device reliably shows up as active.
 *  - pause/resume/next/previous/volume now prefer the SDK player's own
 *    methods (scoped to this exact device) with a Web API fallback, instead
 *    of relying solely on device_id query params against "the active device".
 *  - (v4) Search/matching moved server-side: see backend/music/ and POST /api/resolve.
 */
const SpotifyController = (() => {
  // ---- Shared lightweight debug logger (also used by voice.js / app.js) ----
  window.AkonDebug =
    window.AkonDebug ||
    {
      logs: [],
      log(msg, level = 'info') {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.logs.push(line);
        if (this.logs.length > 60) this.logs.shift();
        const fn = console[level] ? console[level] : console.log;
        fn.call(console, `[Iris] ${msg}`);
        const panel = document.getElementById('debugLog');
        if (panel && !panel.classList.contains('hidden')) {
          panel.textContent = this.logs.join('\n');
        }
      }
    };
  const log = (msg, level) => window.AkonDebug.log(msg, level);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let player = null;
  let deviceId = null;
  let deviceActivated = false;
  let accessToken = null;
  let onStateChangeCallback = null;

  // --- Fix: race condition on SDK readiness ---
  // window.onSpotifyWebPlaybackSDKReady is called by the externally-loaded
  // spotify-player.js script ONCE, whenever its internal setup finishes.
  // That can happen before our app code ever calls init() (e.g. while we're
  // still awaiting the /auth/status check). Previously this callback was
  // defined *inside* init(), so if the SDK fired first, the callback was
  // undefined and the whole player silently never initialized — this is
  // the root cause of "Iris Web Player doesn't show up as a device".
  //
  // Fix: define the global callback immediately (at script-parse time,
  // before any async work happens), and use a small flag/queue so it works
  // no matter which of (SDK ready, init() called) happens first.
  let sdkReady = false;
  let pendingInit = null;

  window.onSpotifyWebPlaybackSDKReady = () => {
    sdkReady = true;
    log('Spotify Web Playback SDK loaded');
    if (pendingInit) {
      const { onReady, onStateChange } = pendingInit;
      pendingInit = null;
      createPlayer(onReady, onStateChange);
    }
  };

  async function getToken() {
    const res = await fetch('/auth/token');
    if (!res.ok) throw new Error('not_logged_in');
    const data = await res.json();
    accessToken = data.access_token;
    return accessToken;
  }

  /**
   * Public entry point. Safe to call before or after the SDK script has
   * finished loading — see race-condition fix above.
   */
  function init(onReady, onStateChange) {
    if (sdkReady) {
      createPlayer(onReady, onStateChange);
    } else {
      pendingInit = { onReady, onStateChange };
    }
  }

  async function createPlayer(onReady, onStateChange) {
    onStateChangeCallback = onStateChange;
    await getToken();

    player = new Spotify.Player({
      name: 'Iris Web Player',
      getOAuthToken: (cb) => {
        getToken().then(cb).catch((err) => log(`getOAuthToken failed: ${err.message}`, 'error'));
      },
      volume: 0.7
    });

    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      deviceActivated = false;
      log(`Iris Web Player ready (device ${device_id})`);

      // Report the device id to the backend purely for the /auth/debug panel.
      fetch('/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id })
      }).catch(() => {});

      // Explicitly transfer playback here so this device is marked ACTIVE,
      // not just "available". Without this, the first play command usually
      // still works (Spotify auto-activates on play), but subsequent
      // pause/next/previous calls can behave inconsistently if some other
      // Spotify Connect device is (or later becomes) the active one.
      transferPlaybackHere();

      if (onReady) onReady(device_id);
    });

    player.addListener('not_ready', ({ device_id }) => {
      deviceActivated = false;
      log(`Iris Web Player went offline (device ${device_id})`, 'warn');
    });

    player.addListener('initialization_error', ({ message }) => log(`SDK init error: ${message}`, 'error'));
    player.addListener('authentication_error', ({ message }) => log(`SDK auth error: ${message}`, 'error'));
    player.addListener('account_error', ({ message }) =>
      log(`SDK account error (Spotify Premium required): ${message}`, 'error')
    );

    // Autoplay blocked (no user gesture yet — the old Start click used to provide one).
    // Surface it so the UI can ask for a single tap instead of failing silently.
    player.addListener('autoplay_failed', () => {
      log('Browser blocked autoplay — tap anywhere on the page to allow sound', 'warn');
      try { window.dispatchEvent(new CustomEvent('akon:autoplay-blocked')); } catch (e) { /* ignore */ }
    });

    player.addListener('player_state_changed', (state) => {
      if (state && onStateChangeCallback) onStateChangeCallback(state);
    });

    player.connect();
  }

  // ---- Web API request helper with basic error visibility + retry ----
  async function apiRequest(url, options = {}, retriesLeft = 1) {
    if (!accessToken) await getToken();

    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
    } catch (err) {
      log(`Network error calling ${options.method || 'GET'} ${url}: ${err.message}`, 'error');
      throw err;
    }

    if (!res.ok && res.status !== 204) {
      const bodyText = await res.text().catch(() => '');
      log(`${options.method || 'GET'} ${url} -> ${res.status} ${bodyText}`.slice(0, 300), 'warn');

      if ((res.status === 429 || res.status >= 500) && retriesLeft > 0) {
        await sleep(400);
        return apiRequest(url, options, retriesLeft - 1);
      }
    }

    return res;
  }

  // ---- Device activation (fixes "device not showing" / race conditions) ----
  async function transferPlaybackHere(retriesLeft = 3, delay = 400) {
    if (!deviceId) return false;

    try {
      const res = await apiRequest('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        body: JSON.stringify({ device_ids: [deviceId], play: false })
      });

      if (res.ok || res.status === 204) {
        deviceActivated = true;
        log('Playback transferred to Iris Web Player');
        return true;
      }

      throw new Error(`transfer returned status ${res.status}`);
    } catch (err) {
      log(`Playback transfer attempt failed: ${err.message}`, 'warn');
      if (retriesLeft > 0) {
        await sleep(delay);
        return transferPlaybackHere(retriesLeft - 1, delay * 2);
      }
      log('Giving up on playback transfer after 3 attempts — will still try to play', 'error');
      return false;
    }
  }

  async function ensureActiveDevice() {
    if (!deviceId) {
      log('No Iris Web Player device yet — is the SDK connected?', 'warn');
      return false;
    }
    if (deviceActivated) return true;
    return transferPlaybackHere();
  }

  // Song search/matching moved to the backend (POST /api/resolve, backend/music/*):
  // it needs a confidence gate, caching, an optional LLM step (API key can't live
  // in the browser) and offline tests. This controller now only does playback.

  // ---- Playback control ----
  // contextUri (the track's album): playing a bare `uris: [uri]` queue left
  // nothing after the song, so "Akon next" had nowhere to go and looked broken.
  // With the album as context, next/previous always have somewhere to move.
  async function playTrack(uri, contextUri) {
    await ensureActiveDevice();
    if (!deviceId) {
      log('Cannot play — no active Iris Web Player device', 'error');
      return false;
    }

    const bodyFor = (withContext) =>
      withContext
        ? { context_uri: contextUri, offset: { uri }, position_ms: 0 }
        : { uris: [uri], position_ms: 0 };
    const attemptPlay = (withContext) =>
      apiRequest(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: 'PUT',
        body: JSON.stringify(bodyFor(withContext))
      });
    const good = (r) => r.ok || r.status === 204 || r.status === 202;

    let useContext = !!contextUri;
    let res = await attemptPlay(useContext);
    if (!good(res) && useContext) {
      // Offset can fail for relinked tracks; the bare URI always works.
      log(`Play with album context failed (status ${res.status}) — retrying without context`, 'warn');
      useContext = false;
      res = await attemptPlay(false);
    }
    if (!good(res)) {
      log(`Play failed (status ${res.status}) — retrying once`, 'warn');
      await sleep(500);
      res = await attemptPlay(false);
    }

    const ok = good(res);
    log(ok ? `Playing ${uri}` : `Play failed after retry (status ${res.status})`, ok ? 'info' : 'error');
    return ok;
  }

  async function pause() {
    if (player) {
      try {
        await player.pause();
        log('Paused via SDK');
        return true;
      } catch (err) {
        log(`SDK pause() failed, falling back to Web API: ${err.message}`, 'warn');
      }
    }
    await ensureActiveDevice();
    if (!deviceId) return false;
    const res = await apiRequest(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
      method: 'PUT'
    });
    return res.ok || res.status === 204;
  }

  async function resume() {
    if (player) {
      try {
        await player.resume();
        log('Resumed via SDK');
        return true;
      } catch (err) {
        log(`SDK resume() failed, falling back to Web API: ${err.message}`, 'warn');
      }
    }
    await ensureActiveDevice();
    if (!deviceId) return false;
    const res = await apiRequest(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT'
    });
    return res.ok || res.status === 204;
  }

  // --- Fix: "Akon next" incorrectly affecting playback / not skipping ---
  // Previously this only hit the Web API `next` endpoint scoped by
  // ?device_id=. If that device wasn't the Connect-API "active" device yet
  // (see transferPlaybackHere above), the call could silently no-op or
  // land on the wrong device. player.nextTrack() talks directly to THIS
  // SDK instance, so it can't be misrouted to another device.
  async function nextTrack() {
    log('Next track requested');
    if (player) {
      try {
        await player.nextTrack();
        log('Skipped to next track via SDK');
        return true;
      } catch (err) {
        log(`SDK nextTrack() failed, falling back to Web API: ${err.message}`, 'warn');
      }
    }
    await ensureActiveDevice();
    if (!deviceId) return false;
    const res = await apiRequest(`https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`, {
      method: 'POST'
    });
    const ok = res.ok || res.status === 204;
    log(ok ? 'Skipped to next track via Web API' : `Next failed (status ${res.status})`, ok ? 'info' : 'error');
    return ok;
  }

  async function previousTrack() {
    if (player) {
      try {
        await player.previousTrack();
        log('Went to previous track via SDK');
        return true;
      } catch (err) {
        log(`SDK previousTrack() failed, falling back to Web API: ${err.message}`, 'warn');
      }
    }
    await ensureActiveDevice();
    if (!deviceId) return false;
    const res = await apiRequest(`https://api.spotify.com/v1/me/player/previous?device_id=${deviceId}`, {
      method: 'POST'
    });
    return res.ok || res.status === 204;
  }

  async function setVolume(percent) {
    const clamped = Math.max(0, Math.min(100, percent));

    if (player) {
      try {
        await player.setVolume(clamped / 100);
        log(`Volume set to ${clamped}% via SDK`);
        return true;
      } catch (err) {
        log(`SDK setVolume() failed, falling back to Web API: ${err.message}`, 'warn');
      }
    }
    await ensureActiveDevice();
    if (!deviceId) return false;
    const res = await apiRequest(
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${clamped}&device_id=${deviceId}`,
      { method: 'PUT' }
    );
    return res.ok || res.status === 204;
  }

  // Current SDK volume (0-100) so "volume up" is relative to the real level,
  // not a local guess that drifts when volume is changed elsewhere.
  async function getVolume() {
    if (player) {
      try {
        const v = await player.getVolume();
        if (typeof v === 'number') return Math.round(v * 100);
      } catch (err) {
        log(`SDK getVolume() failed: ${err.message}`, 'warn');
      }
    }
    return null;
  }

  function getDeviceId() {
    return deviceId;
  }

  // Must run inside a user gesture (tap/keypress). Lets the SDK's media element play
  // in browsers with strict autoplay rules. Returns false if the player isn't built yet.
  function activate() {
    if (!player) return false;
    try {
      if (typeof player.activateElement === 'function') player.activateElement();
    } catch (err) {
      log(`activateElement failed: ${err.message}`, 'warn');
    }
    return true;
  }

  return {
    init,
    playTrack,
    pause,
    resume,
    nextTrack,
    previousTrack,
    setVolume,
    getVolume,
    getDeviceId,
    activate
  };
})();
