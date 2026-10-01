/**
 * VoiceControl
 * Wraps the browser's Web Speech API (browser-native; no cloud/paid SDK added).
 *
 * Hands-free flow for Iris:
 *  - The mic opens when start() is called (app.js calls it on load) and stays open.
 *    Whenever the browser ends a recognition session it is restarted automatically.
 *  - Saying "Iris" enters the listening phase the moment the word appears in an
 *    INTERIM transcript, so the eye reacts while the user is still talking.
 *  - "Iris play Believer" in one breath works exactly as before. "Iris" + a pause
 *    opens a short window in which the next utterance is taken as the command.
 *  - Background music can keep the recognizer from ever closing an utterance; that was
 *    why every command needed a click on "Stop listening". Once the wake word has been
 *    heard, the utterance is now closed for the user after a short settle (stop() makes
 *    the recognizer return a final result), then recognition restarts by itself.
 *  - Phases are broadcast as `akon:phase` { phase: off|idle|listening|thinking|speaking }.
 *    They are UI-only; command handling is unchanged (callback(command, transcript, alts)).
 *
 * Works best in Chrome/Edge (desktop). Safari/Firefox support is limited.
 */
const VoiceControl = (() => {
  // en-IN (not en-US): Indian-English recognition transcribes Hinglish titles
  // ("kesariya", "tum hi ho") far closer to Spotify's romanized titles than en-US.
  // Override with window.AKON_SPEECH_LANG = 'en-US' if most users are not in India.
  const LANG = window.AKON_SPEECH_LANG || 'en-IN';

  // Wake word is "Iris". Recognizers sometimes hear a near-miss, so a few are accepted.
  // "akon" is deliberately NOT here any more: it is now just an artist name, so
  // "Iris play Lonely by Akon" keeps Akon inside the command.
  const WAKE_RE = /\b(iris(?:['’]s)?|irish|irris|irus|ires|ira['’]?s|eyeris)\b/;

  const WINDOW_MS = 8000;        // after a bare "Iris": how long the next utterance counts as the command
  const SETTLE_MS = 1400;        // interim text unchanged this long after the wake word -> close the utterance
  const MAX_UTTERANCE_MS = 7000; // hard cap once awake (music can keep an utterance open indefinitely)
  const RESPOND_MS = 2200;       // how long the responding ("speaking") phase shows before idle

  let recognition = null;
  let enabled = false;          // mic should be running
  let blocked = false;          // browser refused the mic (permission / no gesture / no device)
  let onCommandCallback = null;

  let phase = 'off';
  let windowUntil = 0;          // command window after the wake word
  let wakeIdx = -1;             // result index whose interim contained the wake word
  let pending = null;           // { idx, text } unfinalized interim we are waiting on
  let settleTimer = null;
  let capTimer = null;
  let phaseTimer = null;
  let restartTimer = null;
  let restartDelay = 0;
  let sessionHadError = false;
  let cmdSeq = 0;

  const dlog = (msg, level) => window.AkonDebug && window.AkonDebug.log(msg, level);
  const emit = (name, detail) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* UI only */ }
  };

  function setPhase(next, extra) {
    phase = next;
    emit('akon:phase', Object.assign({ phase: next }, extra || {}));
  }

  function init(onCommand) {
    onCommandCallback = onCommand;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      return false;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    // Interim results let the wake word switch the UI to "listening" immediately,
    // instead of only after the whole sentence has been finalized.
    recognition.interimResults = true;
    recognition.lang = LANG;
    recognition.maxAlternatives = 4; // alternates are fed to the resolver as extra readings

    recognition.onresult = handleResult;

    recognition.onstart = () => {
      sessionHadError = false;
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are normal/expected in continuous mode — ignore quietly
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
        // Hands-free can't override a browser mic refusal. Stay off (no restart loop)
        // until the user allows the mic or presses "Turn on microphone".
        enabled = false;
        blocked = true;
        clearTimers();
        dlog(`Microphone unavailable (${event.error})`, 'warn');
        setPhase('off', { reason: event.error === 'audio-capture' ? 'no-mic' : 'blocked' });
        return;
      }
      sessionHadError = true;
      console.warn('Speech recognition error:', event.error);
    };

    // Browsers end recognition sessions on silence, on errors and after a time limit.
    // Restart so listening is continuous; back off if sessions keep failing (e.g. offline).
    recognition.onend = () => {
      // An utterance we were waiting on ended without a final result: use its last interim text.
      if (enabled && pending) {
        const p = pending;
        pending = null;
        handleFinal([p.text], p.idx);
      }
      wakeIdx = -1; // result indices restart with every session
      if (!enabled) return;
      restartDelay = sessionHadError ? Math.min(Math.max(500, restartDelay * 2), 8000) : 0;
      scheduleRestart();
    };

    return true;
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!enabled) return;
      try {
        recognition.start();
      } catch (e) {
        // InvalidStateError = already running, which is fine. Anything else: retry later.
        if (e && e.name !== 'InvalidStateError') {
          restartDelay = Math.min(Math.max(500, restartDelay * 2), 8000);
          scheduleRestart();
        }
      }
    }, restartDelay);
  }

  function clearTimers() {
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    clearTimeout(phaseTimer);
    clearTimeout(restartTimer);
    capTimer = null;
  }

  // Text after the FIRST wake word ("iris play iris" -> "play iris", the Goo Goo Dolls song).
  function afterWake(text) {
    const m = WAKE_RE.exec(text);
    if (!m) return null;
    return tidy(text.slice(m.index + m[0].length));
  }

  function tidy(text) {
    return String(text || '')
      .trim()
      .replace(/^[,.!?\s]+/, '')
      .replace(/[.,!?]+$/, '')
      .trim();
  }

  function awake() {
    return phase === 'listening' && Date.now() < windowUntil;
  }

  // Keep the command window open at least `ms` from now; back to idle when it lapses.
  function armWindow(ms) {
    windowUntil = Math.max(windowUntil, Date.now() + ms);
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => {
      if (phase === 'listening') {
        windowUntil = 0;
        setPhase('idle');
      }
    }, windowUntil - Date.now());
  }

  function enterListening() {
    windowUntil = 0;
    armWindow(WINDOW_MS);
    if (phase !== 'listening') {
      setPhase('listening');
      // UI-only side effect (wake cue). Never affects command handling.
      emit('akon:wake');
    }
  }

  // Ask the recognizer to finalize what it has (stop() returns a final result for the
  // audio so far; onend then restarts recognition). Replaces the old manual Stop click.
  function closeUtterance() {
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    capTimer = null;
    if (!enabled || !pending || !recognition) return;
    dlog('Closing the utterance (no pause detected)');
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }

  function handleResult(event) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const transcripts = [];
        for (let k = 0; k < res.length; k++) {
          transcripts.push(String(res[k].transcript || '').trim().toLowerCase());
        }
        handleFinal(transcripts, i);
      } else {
        handleInterim(String((res[0] && res[0].transcript) || '').trim().toLowerCase(), i);
      }
    }
  }

  function handleInterim(text, idx) {
    if (!text || !enabled) return;
    const hasWake = WAKE_RE.test(text);
    if (hasWake) {
      wakeIdx = idx;
      enterListening();
    } else if (!awake()) {
      return; // not addressed to Iris
    }

    if (!pending || pending.idx !== idx) {
      pending = { idx, text };
      clearTimeout(capTimer);
      capTimer = setTimeout(closeUtterance, MAX_UTTERANCE_MS);
    } else {
      pending.text = text;
    }
    armWindow(SETTLE_MS + 1500); // a long command must not time out while it is being spoken

    emit('akon:hearing', { text: hasWake ? afterWake(text) || '' : tidy(text) });

    clearTimeout(settleTimer);
    settleTimer = setTimeout(closeUtterance, SETTLE_MS);
  }

  function handleFinal(transcripts, idx) {
    if (pending && pending.idx === idx) {
      pending = null;
      clearTimeout(settleTimer);
      clearTimeout(capTimer);
      capTimer = null;
    }
    if (!enabled) return;

    let transcript;
    let command;
    let alternatives;

    // Use the most confident transcript that contains the wake word.
    const primaryIdx = transcripts.findIndex((t) => WAKE_RE.test(t));
    if (primaryIdx !== -1) {
      transcript = transcripts[primaryIdx];
      command = afterWake(transcript);
      alternatives = transcripts
        .filter((_, i) => i !== primaryIdx)
        .map((t) => afterWake(t) || t)
        .filter((t) => t && t !== command);
      if (!command) {
        // Bare "Iris": listen for the command in the next utterance.
        enterListening();
        dlog(`Heard "${transcript}" -> listening for a command`);
        return;
      }
    } else if (idx === wakeIdx) {
      // The interim had the wake word but the final dropped it; don't guess. The
      // window stays open, so the user can simply say the command again.
      dlog(`Heard "${transcripts[0]}" (wake word dropped in final) — ignored`, 'warn');
      return;
    } else if (awake()) {
      // Follow-up utterance after a bare "Iris".
      transcript = transcripts[0];
      command = tidy(transcript);
      alternatives = transcripts.slice(1).map(tidy).filter((t) => t && t !== command);
    } else {
      return;
    }
    if (idx === wakeIdx) wakeIdx = -1;
    if (!command) return;

    dispatchCommand(command, transcript, alternatives);
  }

  function dispatchCommand(command, transcript, alternatives) {
    windowUntil = 0;
    clearTimeout(phaseTimer);

    if (window.AkonDebug) {
      window.AkonDebug.log(`Heard "${transcript}" -> command "${command}"` + (alternatives.length ? ` (alts: ${alternatives.join(' / ')})` : ''));
    }

    // UI-only side effect (history strip / searching skeleton).
    emit('akon:heard', { command, transcript });

    const seq = ++cmdSeq;
    setPhase('thinking', { command });

    let result;
    try {
      result = onCommandCallback ? onCommandCallback(command, transcript, alternatives) : null;
    } catch (err) {
      dlog(`Command "${command}" failed: ${err.message}`, 'error');
    }

    // When the command has been carried out, show the responding phase, then go back to
    // waiting for "Iris" — the mic never stopped, so the next command needs no click.
    Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        if (seq !== cmdSeq || phase !== 'thinking') return; // superseded by a newer wake/command
        setPhase('speaking');
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(() => {
          if (phase === 'speaking') setPhase('idle');
        }, RESPOND_MS);
      });
  }

  function start() {
    if (!recognition) return false;
    enabled = true;
    blocked = false;
    restartDelay = 0;
    clearTimeout(restartTimer);
    try {
      recognition.start();
    } catch (e) {
      // already started — safe to ignore
    }
    setPhase('idle');
    return true;
  }

  // Manual mute. abort() (not stop()) so half-heard speech is discarded, not executed.
  function stop() {
    enabled = false;
    clearTimers();
    windowUntil = 0;
    pending = null;
    wakeIdx = -1;
    if (recognition) {
      try { recognition.abort(); } catch (e) { /* ignore */ }
    }
    setPhase('off', { reason: 'muted' });
  }

  return {
    init,
    start,
    stop,
    isEnabled: () => enabled,
    isBlocked: () => blocked
  };
})();
