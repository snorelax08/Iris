document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('loginBtn');
  const appDiv = document.getElementById('app');
  const micBtn = document.getElementById('micBtn');

  const listeningStatusEl = document.getElementById('listeningStatus');
  const lastCommandEl = document.getElementById('lastCommand');
  const nowPlayingEl = document.getElementById('nowPlaying');
  const playbackStatusEl = document.getElementById('playbackStatus');

  const debugToggle = document.getElementById('debugToggle');
  const debugLog = document.getElementById('debugLog');

  let currentVolume = 70; // fallback only; the real level is read from the SDK before relative changes
  let volumeBeforeMute = 70;

  loginBtn.addEventListener('click', () => {
    window.location.href = '/auth/login';
  });

  checkLoginStatus();

  async function checkLoginStatus() {
    try {
      const res = await fetch('/auth/status');
      const data = await res.json();

      if (data.logged_in) {
        loginBtn.classList.add('hidden');
        appDiv.classList.remove('hidden');
        setupPlayer();
        setupVoice();
      }
    } catch (err) {
      console.error('Failed to check login status:', err);
    }
  }

  function setupPlayer() {
    SpotifyController.init(
      () => {
        // Player device is ready (device id reporting to /auth/device happens
        // inside SpotifyController itself, for the debug panel).
        listeningStatusEl.textContent = 'Player ready';
      },
      (state) => {
        const track = state.track_window && state.track_window.current_track;
        nowPlayingEl.textContent = track
          ? `${track.name} — ${track.artists.map((a) => a.name).join(', ')}`
          : 'Nothing';
        playbackStatusEl.textContent = state.paused ? 'Paused' : 'Playing';
        // UI-only side effect (album art, equalizer, keyboard pause/resume state).
        try { window.dispatchEvent(new CustomEvent('akon:state', { detail: state })); } catch (e) { /* ignore */ }
      }
    );
  }

  function setupVoice() {
    const voiceReady = VoiceControl.init(handleCommand);

    // The button is now a manual mute, not part of the normal flow (see below).
    window.addEventListener('akon:phase', (e) => {
      const off = e.detail && e.detail.phase === 'off';
      micBtn.textContent = off ? 'Turn on microphone' : 'Mute microphone';
      micBtn.setAttribute('aria-pressed', String(off));
    });

    micBtn.addEventListener('click', () => {
      if (!voiceReady) return;
      if (VoiceControl.isEnabled()) VoiceControl.stop();
      else VoiceControl.start();
    });

    // Hands-free: the mic opens as soon as the app loads and stays open. Saying "Iris"
    // is the only trigger; there is no Start/Stop click per command any more.
    if (voiceReady) VoiceControl.start();

    // The old flow always began with a click, which also counted as the user gesture
    // browsers require before audio may play (and, in some browsers, before the mic
    // may open). With no click, the first tap/keypress anywhere does both jobs.
    const onFirstGesture = (e) => {
      if (SpotifyController.activate()) {
        window.removeEventListener('pointerdown', onFirstGesture, true);
        window.removeEventListener('keydown', onFirstGesture, true);
      }
      if (voiceReady && VoiceControl.isBlocked() && e.target !== micBtn) VoiceControl.start();
    };
    window.addEventListener('pointerdown', onFirstGesture, true);
    window.addEventListener('keydown', onFirstGesture, true);

    window.addEventListener('akon:autoplay-blocked', () => {
      if (window.showToast) window.showToast('The browser blocked sound. Tap anywhere on the page to allow it.', 'warn', 7000);
    });
  }

  const dlog = (msg, level) => window.AkonDebug && window.AkonDebug.log(msg, level);
  const who = (t) => `${t.name} — ${t.artists.join(', ')}`;

  // Choices from the last "choose" (or runners-up from an ambiguous "play"),
  // so "Akon option two" / "Akon wrong song" can act on them. Expires after 60 s.
  // `current` = index of the option now playing (-1 if none), so "wrong song" moves on.
  let pending = { options: [], current: -1, expires: 0 };
  function setPending(options, current = -1) {
    pending = { options: options || [], current, expires: Date.now() + 60000 };
  }
  function pendingOptions() {
    return Date.now() < pending.expires ? pending.options : [];
  }

  // Every command bumps this. A slow song search that finishes after a newer
  // command (e.g. "pause") must not start playing — that was a source of
  // "random" behaviour when commands were given in quick succession.
  let commandSeq = 0;

  async function playResolved(track, seq) {
    if (seq !== commandSeq) return false;
    try {
      window.dispatchEvent(new CustomEvent('akon:match', {
        detail: { name: track.name, artist: track.artists.join(', '), score: track.score, art: track.art }
      }));
    } catch (e) { /* ignore */ }
    return SpotifyController.playTrack(track.uri, track.albumUri);
  }

  function resolvedUi(detail) {
    try { window.dispatchEvent(new CustomEvent('akon:resolved', { detail })); } catch (e) { /* ignore */ }
  }

  async function resolveAndPlay(query, alternatives, implicit, seq) {
    nowPlayingEl.textContent = `Searching: ${query}...`;
    let result;
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, alternatives, implicit })
      });
      if (!res.ok) throw new Error(`resolve returned ${res.status}`);
      result = await res.json();
    } catch (err) {
      dlog(`Song lookup failed: ${err.message}`, 'error');
      if (seq === commandSeq) nowPlayingEl.textContent = 'Search failed — try again';
      resolvedUi({ action: 'error', message: 'Search failed — try again' });
      return;
    }
    if (seq !== commandSeq) return; // superseded by a newer command

    const top = (result.debug && result.debug.top) || [];
    dlog(`Resolve "${query}" -> ${result.action} (${result.confidence}, ${result.source}, ${result.debug && result.debug.ms}ms) | ` +
      top.slice(0, 3).map((t) => `${t.track} = ${t.score}`).join(' | '));

    if (result.action === 'play') {
      // Numbered like the message: option one = what's playing, option two = first runner-up.
      setPending([result.track, ...result.alternatives], 0);
      await playResolved(result.track, seq);
      resolvedUi({ action: 'play', message: result.alternatives.length ? result.message : '' });
      return;
    }
    if (result.action === 'choose') {
      setPending(result.options);
      nowPlayingEl.textContent = result.message;
      dlog(result.message, 'warn');
      resolvedUi({ action: 'choose', message: result.message });
      return;
    }
    setPending([]);
    nowPlayingEl.textContent = result.message || 'Song not found';
    dlog(`Song not found: "${query}"`, 'warn');
    resolvedUi({ action: 'not_found', message: result.message });
  }

  async function changeVolume(delta) {
    const current = await SpotifyController.getVolume();
    if (current !== null) currentVolume = current;
    currentVolume = Math.max(0, Math.min(100, currentVolume + delta));
    await SpotifyController.setVolume(currentVolume);
  }

  async function handleCommand(command, fullTranscript, altCommands = []) {
    lastCommandEl.textContent = fullTranscript;
    const seq = ++commandSeq;
    const intent = AkonIntent.extractIntent(command);
    dlog(`Intent: ${JSON.stringify(intent)}`);

    try {
      switch (intent.type) {
        case 'play_song': {
          // Alternatives only make sense if they are also song requests.
          const alts = altCommands
            .map((a) => AkonIntent.extractIntent(a))
            .filter((i) => i.type === 'play_song')
            .map((i) => i.query);
          await resolveAndPlay(intent.query, alts, intent.implicit, seq);
          break;
        }
        case 'select_option': {
          const opts = pendingOptions();
          if (opts[intent.index]) {
            pending.current = intent.index;
            await playResolved(opts[intent.index], seq);
          } else {
            // No options on screen: "play one" is the U2 song, not a menu choice.
            await resolveAndPlay(intent.fallbackQuery, [], false, seq);
          }
          break;
        }
        case 'reject': {
          const opts = pendingOptions();
          const nextIdx = pending.current + 1;
          if (opts[nextIdx]) {
            pending.current = nextIdx;
            await playResolved(opts[nextIdx], seq);
          } else {
            await SpotifyController.nextTrack();
          }
          break;
        }
        case 'pause':
          await SpotifyController.pause();
          break;
        case 'resume':
          await SpotifyController.resume();
          break;
        case 'next':
          await SpotifyController.nextTrack();
          break;
        case 'previous':
          await SpotifyController.previousTrack();
          break;
        case 'volume_up':
          await changeVolume(intent.step || 15);
          break;
        case 'volume_down':
          await changeVolume(-(intent.step || 15));
          break;
        case 'volume_set':
          currentVolume = intent.value;
          await SpotifyController.setVolume(currentVolume);
          break;
        case 'mute': {
          const v = await SpotifyController.getVolume();
          if (v) volumeBeforeMute = v;
          await SpotifyController.setVolume(0);
          break;
        }
        case 'unmute':
          await SpotifyController.setVolume(volumeBeforeMute || 60);
          break;
        default:
          dlog(`Unrecognized command after wake word: "${command}"`, 'warn');
      }
    } catch (err) {
      dlog(`Command "${command}" failed: ${err.message}`, 'error');
    }
    maybeRefreshDebugPanel();
  }

  // ---- Debug panel: shows server auth/device state + recent client log ----
  if (debugToggle && debugLog) {
    debugToggle.addEventListener('click', async () => {
      const isHidden = debugLog.classList.contains('hidden');
      if (isHidden) {
        debugLog.classList.remove('hidden');
        debugToggle.textContent = 'Hide Debug Info';
        await refreshDebugPanel();
      } else {
        debugLog.classList.add('hidden');
        debugToggle.textContent = 'Show Debug Info';
      }
    });
  }

  function maybeRefreshDebugPanel() {
    if (debugLog && !debugLog.classList.contains('hidden')) refreshDebugPanel();
  }

  async function refreshDebugPanel() {
    if (!debugLog) return;

    let serverState = {};
    try {
      const res = await fetch('/auth/debug');
      serverState = await res.json();
    } catch (err) {
      serverState = { error: 'Could not reach /auth/debug' };
    }

    const clientLines = (window.AkonDebug && window.AkonDebug.logs) || [];
    debugLog.textContent =
      '--- Server auth/device state ---\n' +
      JSON.stringify(serverState, null, 2) +
      '\n\n--- Client log (most recent last) ---\n' +
      clientLines.join('\n');
  }
});
