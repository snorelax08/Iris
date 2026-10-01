'use strict';
/**
 * Pure text utilities for matching spoken requests against Spotify metadata.
 * No I/O, no state — everything here is unit-testable offline.
 */

// Low-information words. They are NEVER deleted from a query (the old FILLER_WORDS
// list deleted "tu", "tune", "kya", "of", "the"… from the middle of titles, which is
// why "ye tune kya kiya" and "shape of you" broke). They only count for less when
// measuring how much of a title was covered.
const WEAK_TOKENS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'by', 'for', 'is',
  'ka', 'ki', 'ke', 'se', 'hai', 'ho', 'na', 'ne', 'ko'
]);

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', twentytwo: '22'
};

function normalize(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics (Beyoncé -> beyonce)
    .toLowerCase()
    .replace(/[’'`]/g, '') // "don't" -> "dont" (Spotify and ASR disagree on apostrophes)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ') // keep Devanagari if the ASR ever emits it
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  const n = normalize(str);
  return n ? n.split(' ') : [];
}

/**
 * Phonetic key for one token. Collapses the spelling variation that romanized Hindi
 * and speech recognition produce for the same sound:
 *   kesariya/kesaria/kesariyaa, pyaar/pyar, dil/dill, deewana/diwana,
 *   wala/vala, zindagi/jindagi, phir/fir.
 */
function phonetic(token) {
  let t = String(token || '');
  if (NUMBER_WORDS[t]) return NUMBER_WORDS[t];
  t = t
    .replace(/ph/g, 'f')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/ch/g, '#') // protect "ch" before c->k
    .replace(/c/g, 'k')
    .replace(/#/g, 'ch')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/iy(?=a)/g, 'i') // kesariya -> kesaria, kiya -> kia
    .replace(/(.)\1+/g, '$1') // pyaar -> pyar, dill -> dil
    .replace(/([aeiou])h$/, '$1'); // yeh -> ye, vah -> va
  return t;
}

function phoneticTokens(str) {
  return tokenize(str).map(phonetic).filter(Boolean);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function charSimilarity(a, b) {
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Two phonetic tokens "match" if equal, or within a small edit distance for longer words (ASR slips). */
function tokensMatch(a, b) {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 4) return false;
  const d = levenshtein(a, b);
  return d <= 1 || (len >= 7 && d <= 2);
}

function weight(tok) {
  return WEAK_TOKENS.has(tok) ? 0.3 : 1;
}

/** Weighted fraction of `from` tokens that have a match somewhere in `to`. */
function coverage(from, to) {
  let total = 0;
  let hit = 0;
  for (const t of from) {
    const w = weight(t);
    total += w;
    if (to.some((u) => tokensMatch(t, u))) hit += w;
  }
  return total ? hit / total : 0;
}

/**
 * Similarity between what the user said (as a title) and a track title, both as
 * phonetic token arrays. 1.0 = same title. Handles partial titles ("kal ho na" vs
 * "kal ho naa ho") and small misrecognitions ("beliver" vs "believer").
 */
function titleSimilarity(queryToks, titleToks) {
  if (!queryToks.length || !titleToks.length) return 0;
  const q = queryToks.join(' ');
  const t = titleToks.join(' ');
  if (q === t) return 1;
  if (q.replace(/ /g, '') === t.replace(/ /g, '')) return 0.98; // "sun raha hai" vs "sunraha hai"
  const tokenScore = 0.6 * coverage(queryToks, titleToks) + 0.4 * coverage(titleToks, queryToks);
  return Math.max(tokenScore, charSimilarity(q, t));
}

/**
 * How well the artist words the user said match ANY of the track's artists.
 * `artistLists` is an array of phonetic token arrays, one per credited artist.
 */
function artistSimilarity(queryArtistToks, artistLists) {
  if (!queryArtistToks.length || !artistLists.length) return 0;
  const qJoined = queryArtistToks.join('');
  let best = 0;
  for (const a of artistLists) {
    if (!a.length) continue;
    const joined = a.join('');
    // "rem" vs "r e m", "ap dhillon" vs "ap dhillon"
    const joinedSim = charSimilarity(qJoined, joined);
    const tokenSim = coverage(queryArtistToks, a);
    best = Math.max(best, tokenSim, joinedSim >= 0.8 ? joinedSim : 0);
  }
  // Collaborations: "kesariya arijit pritam" should count both credited artists.
  const all = artistLists.flat();
  best = Math.max(best, coverage(queryArtistToks, all));
  return Math.min(1, best);
}

module.exports = {
  WEAK_TOKENS,
  normalize,
  tokenize,
  phonetic,
  phoneticTokens,
  levenshtein,
  charSimilarity,
  tokensMatch,
  coverage,
  titleSimilarity,
  artistSimilarity
};
