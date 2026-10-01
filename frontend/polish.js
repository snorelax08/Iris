/**
 * Iris polish layer (cosmetic/UX only).
 *
 * Rules this file follows:
 *  - It only LISTENS: to `akon:*` events fired by tiny hooks in app.js / voice.js /
 *    spotify.js, to AkonDebug log lines, and to existing DOM text. It never changes
 *    search, SDK init, device activation, auth, or command parsing.
 *  - Every handler is wrapped in try/catch, so a failure here can't break the app.
 *  - No microphone / getUserMedia / audio analysis. The listening pulse is pure CSS.
 *  - Each feature has a switch below. Set to false to turn it off independently.
 */
(() => {
  const CONFIG = {
    toasts: true,
    art: true,
    wakeFlash: false,  // the iris itself now shows the wake word (iris.js)
    chime: false,      // OFF by default: untested against a live mic (Known Risk Area #1)
    history: true,
    matchHint: true,   // low-confidence "Best guess" hint
    skeleton: true,
    keyboard: true,
    lowConfidence: 0.5 // UI-only threshold; does not touch the matching logic
  };

  const $ = (id) => document.getElementById(id);
  const on = (name, fn) =>
    window.addEventListener(name, (e) => {
      try { fn(e.detail || {}); } catch (err) { console.warn('[Iris polish]', name, err); }
    });
  const dlog = (m, l) => { try { window.AkonDebug && window.AkonDebug.log(m, l); } catch (e) { /* ignore */ } };

  // ---------- Toasts ----------
  function showToast(msg, type = 'info', ms = 3200) {
    if (!CONFIG.toasts) return;
    const box = $('toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, ms);
  }
  window.showToast = showToast;

  // Tap AkonDebug.log (read-only side effect) so toasts follow the existing log lines.
  const D = window.AkonDebug;
  if (D && !D.__polished) {
    const orig = D.log;
    D.log = function (msg, level) {
      const r = orig.apply(this, arguments);
      try { onLog(String(msg), level); } catch (e) { /* ignore */ }
      return r;
    };
    D.__polished = true;
  }

  function onLog(msg, level) {
    let m;
    if ((m = msg.match(/^Volume set to (\d+)%/))) return showToast(`Volume ${m[1]}%`);
    if (/^No search results found/.test(msg)) { hideSkeleton(); return showToast('Song not found', 'error'); }
    if ((m = msg.match(/^Unrecognized command after wake word: "(.*)"$/))) return showToast(`Didn't understand "${m[1]}"`, 'warn');
    if (level === 'error') return showToast(msg.slice(0, 90), 'error', 4500);
  }

  // ---------- Album art ----------
  const artImg = $('artImg');
  function setArt(url) {
    if (!CONFIG.art || !artImg) return;
    if (!url) { artImg.classList.add('hidden'); artImg.removeAttribute('src'); return; }
    if (artImg.getAttribute('src') !== url) artImg.src = url;
    artImg.classList.remove('hidden');
  }
  if (artImg) artImg.addEventListener('error', () => artImg.classList.add('hidden')); // placeholder shows instead

  function largestImage(images) {
    if (!images || !images.length) return null;
    return images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
  }

  // ---------- Playback state (album art, equalizer, states, keyboard) ----------
  let paused = true;
  on('akon:state', (st) => {
    const track = st.track_window && st.track_window.current_track;
    paused = !!st.paused;
    document.body.classList.toggle('is-playing', !!track && !st.paused);
    if (track) {
      hideSkeleton();
      setArt(largestImage(track.album && track.album.images));
    } else {
      setArt(null);
    }
  });

  // ---------- Mic button (listening state now comes from `akon:phase`, see iris.js) ----------
  const micBtn = $('micBtn');
  if (micBtn) {
    // After a mouse/touch click (detail > 0) release focus so Space/arrow shortcuts work.
    // Keyboard-triggered clicks (detail === 0) keep focus, so keyboard users are unaffected.
    micBtn.addEventListener('click', (e) => { if (CONFIG.keyboard && e.detail > 0) micBtn.blur(); });
  }

  // ---------- Wake-word flash + optional chime ----------
  let audioCtx = null;
  function playChime() {
    if (!CONFIG.chime) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC(); // output only; never touches the microphone
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.13);
    } catch (e) { /* fire and forget */ }
  }

  on('akon:wake', () => {
    if (CONFIG.wakeFlash && micBtn) {
      micBtn.classList.remove('flash');
      void micBtn.offsetWidth; // restart animation
      micBtn.classList.add('flash');
      setTimeout(() => micBtn.classList.remove('flash'), 700);
    }
    playChime();
  });

  // ---------- Command history + searching skeleton ----------
  const recent = [];
  let skeletonTimer = null;

  function renderHistory() {
    const ul = $('history');
    if (!ul || !CONFIG.history) return;
    ul.textContent = '';
    recent.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c;
      ul.appendChild(li);
    });
  }

  function showSkeleton(name) {
    if (!CONFIG.skeleton) return;
    const sk = $('skeleton');
    if (!sk) return;
    $('skeletonText').textContent = `Searching: ${name}…`;
    sk.classList.remove('hidden');
    clearTimeout(skeletonTimer);
    skeletonTimer = setTimeout(hideSkeleton, 10000); // safety net: never get stuck
  }
  function hideSkeleton() {
    clearTimeout(skeletonTimer);
    const sk = $('skeleton');
    if (sk) sk.classList.add('hidden');
  }

  function setHint(text) {
    const h = $('matchHint');
    if (!h || !CONFIG.matchHint) return;
    h.textContent = text || '';
    h.classList.toggle('hidden', !text);
  }

  on('akon:heard', ({ command }) => {
    if (!command) return;
    recent.unshift(command);
    recent.length = Math.min(recent.length, 5);
    renderHistory();
    setHint('');
    // Only real song requests get the skeleton ("play next" is a transport command).
    const intent = window.AkonIntent ? window.AkonIntent.extractIntent(command) : null;
    if (intent && intent.type === 'play_song') showSkeleton(intent.query);
  });

  // Resolver outcome (play with runners-up / choose / not found): clear the skeleton
  // and show the message, e.g. 'Did you mean: 1) … Say "option one"'.
  on('akon:resolved', ({ action, message }) => {
    if (action !== 'play') hideSkeleton();
    setHint(message || '');
  });

  on('akon:match', ({ name, artist, score, art }) => {
    hideSkeleton();
    setArt(art); // real art swaps in as soon as the search resolves
    if (typeof score === 'number' && score < CONFIG.lowConfidence) {
      setHint(`Best guess: ${name} — ${artist}. Say "Iris next" if that's wrong.`);
    }
  });

  // ---------- Keyboard fallback (calls the same SpotifyController functions as voice) ----------
  document.addEventListener('keydown', (e) => {
    if (!CONFIG.keyboard || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const app = $('app');
    if (!app || app.classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select', 'button', 'a'].includes(tag) || e.target.isContentEditable) return;
    if (typeof SpotifyController === 'undefined') return;

    let action = null;
    if (e.code === 'Space') action = paused ? 'resume' : 'pause';
    else if (e.code === 'ArrowRight') action = 'nextTrack';
    else if (e.code === 'ArrowLeft') action = 'previousTrack';
    if (!action) return;

    e.preventDefault();
    dlog(`Keyboard: ${action}`);
    Promise.resolve(SpotifyController[action]()).catch((err) => dlog(`Keyboard ${action} failed: ${err.message}`, 'warn'));
  });
})();
