/**
 * AkonIntent — command intent parser, shared by the browser (window.AkonIntent) and
 * Node (require('../shared/intent')).
 *
 * Why shared: transport commands (pause/next/volume) must work even if the backend
 * is slow or asleep (Render free tier cold starts), so the browser classifies them
 * locally with zero network. Only "play <song>" goes to the server. Node uses the
 * same file for tests, so the browser and the tests cannot drift.
 *
 * extractIntent(text) -> one of:
 *   { type: 'pause' | 'resume' | 'next' | 'previous' | 'mute' | 'unmute' | 'reject' }
 *   { type: 'volume_up' | 'volume_down', step }
 *   { type: 'volume_set', value }
 *   { type: 'select_option', index, fallbackQuery }   // "option two", "doosra wala"
 *   { type: 'play_song', query, implicit }            // implicit = no play verb was said
 *   { type: 'unknown' }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AkonIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9\u0900-\u097f%\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Politeness / carrier words at the edges only (never mid-sentence).
  function stripPoliteness(t) {
    let prev;
    do {
      prev = t;
      t = t
        .replace(/^(hey|hi|ok|okay|yo|arre|arey|acha|accha)\s+/, '')
        .replace(/^(please|pls|plz|kindly)\s+/, '')
        .replace(/^(can|could|would|will) you (please )?/, '')
        .replace(/\s+(please|pls|plz|now|right now|for me|yaar|na)$/, '');
    } while (t !== prev);
    return t.trim();
  }

  const OBJ = '(?: (?:the |this |that |my )?(?:song|music|track|gaana|gana|it|playback|one|audio))?';
  const re = (body) => new RegExp('^(?:' + body + ')' + OBJ + '$');

  const PAUSE = re(
    'pause|stop|stop playing|hold on|hold|halt|freeze|quiet|silence|shut up|' +
      'ruko|ruk jao|ruk ja|rok do|roko|band karo|band kar do|band kar|bas karo|bas|chup|chup karo|pause karo|pause kar do'
  );
  const PAUSE_HI = /^(gaana|gana|music|song) (band karo|band kar do|rok do|roko|pause karo|pause kar do|stop karo)$/;

  const RESUME = re(
    'resume|continue|unpause|keep playing|carry on|play|start|start again|play again|go on|' +
      'chalu karo|chalu kar do|chalao|wapas chalao|phir se chalao|play karo|play kar do|resume karo'
  );

  const NEXT = re(
    'next|skip|skip this|skip it|skip that|next one|next please|play next|play the next|go next|go to next|go to the next|' +
      'next song please|change|change it|change the song|change song|another|another one|another song|' +
      'agla|agla gaana|agla gana|agla song|next gaana|next wala|dusra gaana|doosra gaana|gaana badlo|song badlo|badlo'
  );

  const PREVIOUS = re(
    'previous|prev|back|go back|last|play previous|play the previous|previous one|play the last|go to previous|go to the previous|' +
      'pichla|pichla gaana|pichla gana|pichhla|pichhla gaana|peeche|piche|wapas'
  );

  const REJECT = /^(no|nope|not (this|that)( one)?|wrong( one| song)?|thats wrong|that is wrong|not that song|galat|galat gaana|ye nahi|yeh nahi|nahi ye|other one|the other one)$/;

  const MUTE = /^(mute|mute it|mute the (music|song|volume)|awaaz band karo|awaz band karo)$/;
  const UNMUTE = /^(unmute|unmute it|unmute the (music|song|volume))$/;

  const VOLUME_SET = /\b(?:set (?:the )?)?volume (?:to |at |on )?(\d{1,3})(?: ?%| percent)?\b|\b(?:volume|awaaz|awaz) (\d{1,3}) (?:pe|par) (?:karo|kar do|rakho)\b/;
  const VOLUME_MAX = /\b(volume|awaaz|awaz) (max|maximum|full|poora|puri|pura)\b|\bmax(imum)? volume\b|\bfull volume\b/;
  const VOLUME_UP =
    /\b(volume up|turn (?:it |the volume |the music |this )?up|louder|increase (?:the )?volume|raise (?:the )?volume|volume increase|pump it up|crank it up|awaaz (?:badhao|badha do|tez karo|tez kar do|zyada karo)|awaz (?:badhao|badha do|tez karo)|volume (?:badhao|badha do|tez karo|zyada karo|badha)|thoda (?:tez|loud|zor se))\b/;
  const VOLUME_DOWN =
    /\b(volume down|turn (?:it |the volume |the music |this )?down|quieter|softer|lower (?:the )?volume|decrease (?:the )?volume|reduce (?:the )?volume|volume decrease|awaaz (?:kam karo|kam kar do|dheere karo|dheemi karo|ghatao)|awaz (?:kam karo|kam kar do|dheere karo)|volume (?:kam karo|kam kar do|ghatao|dheere karo|kam)|thoda (?:dheere|kam|slow))\b/;
  const BIG_STEP = /\b(a lot|lot|much|way|bahut|zyada|more more)\b/;

  const ORDINALS = {
    one: 0, '1': 0, first: 0, pehla: 0, pehli: 0, pehle: 0, pahla: 0,
    two: 1, '2': 1, second: 1, dusra: 1, doosra: 1, dusri: 1, doosri: 1, dusre: 1,
    three: 2, '3': 2, third: 2, teesra: 2, tisra: 2, teesri: 2, tisri: 2
  };
  const SELECT = /^(?:play |choose |pick |select )?(?:the )?(?:option |number |choice |no )?(one|two|three|1|2|3|first|second|third|pehla|pehli|pehle|pahla|dusra|doosra|dusri|doosri|dusre|teesra|tisra|teesri|tisri)(?: one| wala| vala| waala| option| song| gaana)?$/;

  // Play verbs: English at the start, Hindi at the end ("kesariya bajao").
  const PLAY_PREFIX = /^(?:play|put on|start playing|throw on|queue up|queue|i want to hear|i wanna hear|i want to listen to|i wanna listen to|let me hear|lets hear|lets listen to|play me|bajao|chalao|lagao|sunao)\s+(.+)$/;
  const PLAY_SUFFIX = /^(.+?)\s+(?:bajao|baja do|bajado|chalao|chala do|lagao|laga do|sunao|suna do|play karo|play kar do|play kar|chalu karo)$/;
  const LYRIC_HINT = /\b(song|one|track|gaana|gana) (that|which|jo|jisme|jismein|jis mein) |\blyrics?\b|\bthat goes\b/;

  function controlIntent(t) {
    if (PAUSE.test(t) || PAUSE_HI.test(t)) return { type: 'pause' };
    if (NEXT.test(t)) return { type: 'next' };
    if (PREVIOUS.test(t)) return { type: 'previous' };
    if (RESUME.test(t)) return { type: 'resume' };
    if (REJECT.test(t)) return { type: 'reject' };
    if (MUTE.test(t)) return { type: 'mute' };
    if (UNMUTE.test(t)) return { type: 'unmute' };
    return null;
  }

  function volumeIntent(t) {
    let m;
    if ((m = t.match(VOLUME_SET))) {
      const v = parseInt(m[1] || m[2], 10);
      if (!Number.isNaN(v)) return { type: 'volume_set', value: Math.max(0, Math.min(100, v)) };
    }
    if (VOLUME_MAX.test(t)) return { type: 'volume_set', value: 100 };
    const step = BIG_STEP.test(t) ? 30 : 15;
    if (VOLUME_UP.test(t)) return { type: 'volume_up', step };
    if (VOLUME_DOWN.test(t)) return { type: 'volume_down', step };
    return null;
  }

  function extractIntent(text) {
    const t = stripPoliteness(norm(text));
    if (!t) return { type: 'unknown' };

    const sel = t.match(SELECT);
    if (sel) return { type: 'select_option', index: ORDINALS[sel[1]], fallbackQuery: t.replace(/^play /, '') };

    const ctl = controlIntent(t);
    if (ctl) return ctl;

    const pre = t.match(PLAY_PREFIX);
    if (pre) {
      const rest = stripPoliteness(pre[1]);
      // "play next", "play the previous one", "play music" are transport commands, not song names.
      const ctlRest = controlIntent(rest);
      if (ctlRest && ctlRest.type !== 'reject') return ctlRest;
      if (/^(some |any )?(music|songs?|something|kuch bhi|koi gaana|koi bhi gaana)$/.test(rest)) return { type: 'resume' };
      return { type: 'play_song', query: rest, implicit: false };
    }

    // Volume is checked after "play X" so "play turn up the music" still plays the song.
    const vol = volumeIntent(t);
    if (vol) return vol;

    const suf = t.match(PLAY_SUFFIX);
    if (suf) return { type: 'play_song', query: suf[1], implicit: false };

    if (LYRIC_HINT.test(t)) return { type: 'play_song', query: t, implicit: false };

    // No verb at all ("akon kesariya"). Treated as a song request, but the resolver
    // applies a stricter confidence bar so "akon what time is it" never plays junk.
    return { type: 'play_song', query: t, implicit: true };
  }

  return { extractIntent, normalizeCommand: (s) => stripPoliteness(norm(s)) };
});
