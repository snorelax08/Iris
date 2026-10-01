'use strict';
/**
 * Turns the song part of a voice command ("kesariya wala gaana bajao",
 * "stronger by kanye west", "that song that goes i got the power") into a
 * structured request, and builds the ordered list of Spotify queries to run.
 *
 * Design rule: stripping is only done at the EDGES of the phrase (carrier words
 * like "play", "wala gaana", "please"), never in the middle. Every aggressive
 * interpretation is kept as an extra *reading* alongside a conservative one; the
 * ranker scores each track against all readings and takes the best. So an
 * over-eager strip can never hide an exact title the user actually said.
 */
const { normalize, tokenize } = require('./text');

const LEADING = [
  /^(hey|hi|ok|okay|akon)\s+/,
  /^(please|pls|plz|kindly)\s+/,
  /^(can|could|would|will) you (please )?/,
  /^(i want to|i wanna|i would like to|id like to|let me|lets) (hear|listen to|play)\s+/,
  /^(play|put on|start playing|throw on|queue up|queue|play me|bajao|chalao|lagao|sunao)\s+/,
  /^(the |a )?(song|track|gaana|gana|music) (called|named|titled)\s+/,
  /^(the |a )?(song|track)\s+/, // "play the song believer" (only with an explicit song noun)
  /^(original|the original)( version of)?\s+/
];

// Hindi demonstratives before a title ("ye kesariya wala gaana"). Stripped only in an
// ALTERNATE reading, because they are also real title words ("Ye Tune Kya Kiya").
const LEADING_SOFT = /^(ye|yeh|vo|voh|wo|woh|vah|wah)\s+/;

const TRAILING = [
  /\s+(please|pls|plz|for me|on spotify|right now|now|yaar)$/,
  /\s+(bajao|baja do|bajado|chalao|chala do|laga do|lagao|sunao|suna do|play karo|play kar do|play kar|chalu karo)$/,
  /\s+(wala|vala|waala|wali|vali|waali|wale|vale)\s+(gaana|gana|gaaana|song|track|geet)$/,
  /\s+(wala|vala|waala|wali|vali|waali|wale|vale)$/,
  /\s+(original|original version|the original)$/
];
// "love song", "video games": "song" at the end is only stripped in an alternate reading.
const TRAILING_SOFT = /\s+(song|gaana|gana|track|music)$/;

const JUNK_WORDS = /\b(karaoke|tributes?|covers?|covered|made famous|originally performed|in the style of|backing track)\b/;
const VERSION_WORDS = [
  'remix', 'live', 'acoustic', 'unplugged', 'lofi', 'lo fi', 'slowed', 'reverb', 'sped up',
  'speed up', 'nightcore', 'instrumental', '8d', 'reprise', 'mashup', 'bass boosted',
  'extended', 'radio edit', 'female version', 'male version', 'studio version', 'demo'
];
const VERSION_RE = new RegExp('\\b(' + VERSION_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|') + ')\\b', 'g');

const LYRIC_PATTERNS = [
  /^(?:the |that |a )?(?:song|one|track|gaana|gana)\s+(?:that|which|where)\s+(?:goes|says|sings|has(?: the)?(?: line| lyrics?| words?)?)\s+(.+)$/,
  /^(?:the |that )?(?:song|one|track)\s+(?:with|where)\s+(?:the )?(?:lyrics?|line|words?)\s+(.+)$/,
  /^(?:vo|voh|wo|woh)?\s*(?:gaana|gana|song)\s+(?:jisme|jismein|jis mein|jo)\s+(.+?)(?:\s+(?:aata|aati|hai|aata hai|aati hai|bolta hai))*$/,
  /^(?:.*\s)?that goes\s+(.+)$/,
  /^lyrics?\s+(.+)$/
];

function applyAll(text, patterns) {
  let t = text;
  let prev;
  do {
    prev = t;
    for (const p of patterns) t = t.replace(p, '').trim();
  } while (t !== prev);
  return t;
}

/** Strips carrier words at the edges. Returns the conservative cleaned phrase. */
function cleanQuery(raw) {
  return applyAll(normalize(raw), [...LEADING, ...TRAILING]);
}

function splitLast(tokens, word) {
  const i = tokens.lastIndexOf(word);
  if (i > 0 && i < tokens.length - 1) return { left: tokens.slice(0, i), right: tokens.slice(i + 1) };
  return null;
}

/**
 * parseSongRequest(rawQuery, opts) -> {
 *   raw, cleaned, lyric, allowJunk, versionWanted: string[],
 *   album, readings: [{ title: string[], artist: string[]|null, label }]
 *   implicit, source
 * }
 */
function parseSongRequest(rawQuery, opts = {}) {
  const cleaned = cleanQuery(rawQuery);
  const req = {
    raw: String(rawQuery || ''),
    cleaned,
    lyric: null,
    allowJunk: JUNK_WORDS.test(normalize(rawQuery)),
    versionWanted: [],
    album: null,
    readings: [],
    implicit: !!opts.implicit,
    source: opts.source || 'heuristic'
  };

  for (const p of LYRIC_PATTERNS) {
    const m = cleaned.match(p);
    if (m && m[1] && m[1].split(' ').length >= 2) {
      req.lyric = m[1].trim();
      break;
    }
  }

  let base = req.lyric || cleaned;
  const unstripped = base; // "live forever" is a title, not a live version of "forever"
  const versions = base.match(VERSION_RE);
  if (versions) {
    req.versionWanted = [...new Set(versions.map((v) => v.replace(/\s+/g, ' ')))];
    base = base.replace(VERSION_RE, ' ').replace(/\s+/g, ' ').trim() || base;
  }
  if (req.allowJunk) base = base.replace(JUNK_WORDS, ' ').replace(/\s+(version|of)$/, '').replace(/\s+/g, ' ').trim() || base;

  const add = (title, artist, label) => {
    if (!title || !title.length) return;
    const key = title.join(' ') + '|' + (artist ? artist.join(' ') : '');
    if (req.readings.some((r) => r.key === key)) return;
    req.readings.push({ title, artist: artist && artist.length ? artist : null, label, key });
  };

  const variants = [base];
  if (unstripped !== base) variants.push(unstripped);
  const soft1 = base.replace(LEADING_SOFT, '');
  const soft2 = soft1.replace(TRAILING_SOFT, '');
  if (soft1 !== base) variants.push(soft1);
  if (soft2 !== soft1 && soft2) variants.push(soft2);

  for (const v of variants) {
    const toks = tokenize(v);
    // Reading 1: whole phrase as the title. The ranker also tries peeling off
    // artist words per-track ("stronger kanye west", "arijit singh ka kesariya").
    add(toks, null, 'whole');

    // Reading 2: "<title> by <artist>" (last "by", so "stand by me by ben e king" works).
    const by = splitLast(toks, 'by');
    if (by) add(by.left, by.right, 'by');

    // Reading 3: "<artist> ka/ki/ke gaana <title>" (Hinglish).
    const ka = v.match(/^(.+?) (?:ka|ki|ke) (?:gaana|gana|song|gaane|geet) (.+)$/);
    if (ka) add(tokenize(ka[2]), tokenize(ka[1]), 'ka');

    // "<title> from <film/album>" — album is a soft bonus, not a filter.
    const from = splitLast(toks, 'from');
    if (from) {
      add(from.left, null, 'from');
      req.album = req.album || from.right;
    }
  }

  // Speech-recognition alternatives (e.g. en-IN hears "kesariya", en-US heard "cassarea").
  for (const alt of (opts.alternatives || []).slice(0, 3)) {
    const t = tokenize(cleanQuery(alt));
    if (t.length) add(t, null, 'asr_alt');
  }

  if (opts.hint && opts.hint.title) {
    add(tokenize(opts.hint.title), opts.hint.artist ? tokenize(opts.hint.artist) : null, 'llm');
  }

  return req;
}

/**
 * Ordered, de-duplicated Spotify query strings. Most specific first; the resolver
 * runs them in small parallel batches and stops as soon as it is confident.
 */
function buildSearchQueries(req) {
  const out = [];
  const push = (q) => {
    q = String(q || '').replace(/\s+/g, ' ').trim();
    if (q && !out.includes(q)) out.push(q);
  };
  const quote = (toks) => toks.join(' ').replace(/"/g, '');

  const explicit = req.readings.filter((r) => r.artist);
  for (const r of explicit) push(`track:"${quote(r.title)}" artist:"${quote(r.artist)}"`);
  for (const r of explicit) push(`${quote(r.title)} ${quote(r.artist)}`);

  const whole = req.readings.filter((r) => !r.artist);
  if (whole[0]) push(quote(whole[0].title));
  for (const r of explicit) push(quote(r.title)); // title alone: catches wrong/misheard artist
  if (req.album && whole[0]) push(`${quote(whole[0].title)} ${quote(req.album)}`);
  for (const r of whole.slice(1)) push(quote(r.title));
  if (req.versionWanted.length && whole[0]) push(`${quote(whole[0].title)} ${req.versionWanted.join(' ')}`);

  // Broaden once: drop the last word of a long phrase (trailing ASR garbage). Never
  // shrink to a single generic word like the old fallback loop did.
  if (whole[0] && whole[0].title.length >= 4) push(quote(whole[0].title.slice(0, -1)));

  return out.slice(0, 8);
}

module.exports = { cleanQuery, parseSongRequest, buildSearchQueries, VERSION_RE, JUNK_WORDS };
