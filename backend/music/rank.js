'use strict';
/**
 * filterTracks -> scoreTracks -> pickBestTrack.
 *
 * Scores are 0..1 and mean the same thing for every query, so a fixed confidence
 * threshold is meaningful. Popularity and Spotify's own result order are PRIORS
 * (max 10-12% of the score); they break ties between equally good title/artist
 * matches ("play stronger" -> the Kanye one first) but can never override what
 * the user actually said ("stronger by kelly clarkson" -> Kelly).
 */
const { normalize, phonetic, phoneticTokens, titleSimilarity, artistSimilarity, tokensMatch } = require('./text');

const THRESHOLDS = {
  play: 0.72, // auto-play at or above this
  playImplicit: 0.8, // no "play" verb was said ("akon kesariya")
  playLlm: 0.85, // request came from the LLM's guess (lyrics / garbled input)
  options: 0.45, // below play but at/above this: offer choices, don't play
  margin: 0.06 // if #2 (a different song) is this close, attach it as an alternative
};

// Karaoke / tribute / cover factories. Matched on title, album and artist.
const JUNK_TRACK_RE =
  /\b(karaoke|tributes?|made famous|originally performed|in the style of|backing tracks?|cover version|covered by|as made famous|sing along|singalong|lullaby renditions?|piano tribute)\b|[([][^)\]]*\bcovers?\b[^)\]]*[)\]]/i;
const JUNK_ARTIST_RE =
  /\b(karaoke|tribute|covers?|backing tracks?|the hit crew|rockabye baby|vitamin string quartet|8d audio|sing2piano|party hit kings|anthem kids)\b/i;

const VERSION_TAG_RE =
  /\b(remix|mix|live|acoustic|unplugged|lo ?fi|slowed|reverb|sped up|speed up|nightcore|instrumental|8d|reprise|mashup|bass boosted|extended|radio edit|female version|male version|demo|flip|rework|edit|version|jhankar|dj)\b/i;

const CONNECTORS = new Set(['by', 'ka', 'ki', 'ke', 'from', 'ft', 'feat', 'featuring', 'se', 'vala', 'wala', 'and']);

/** Title without "(feat. X)", "[Remastered]", " - Live at …" etc., as phonetic tokens. */
function cleanTitleTokens(name) {
  const stripped = String(name || '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '');
  const t = phoneticTokens(stripped);
  return t.length ? t : phoneticTokens(name);
}

/** Version tags that live in the decorations: "(Lofi Flip)", " - Slowed + Reverb". */
function versionTags(name) {
  const decorations = [];
  const s = String(name || '');
  (s.match(/[([][^)\]]*[)\]]/g) || []).forEach((d) => decorations.push(d));
  const dash = s.match(/\s+-\s+(.*)$/);
  if (dash) decorations.push(dash[1]);
  return decorations
    .filter((d) => VERSION_TAG_RE.test(d) && !/^\W*(from|feat|ft)\b/i.test(d.replace(/^[([]/, '')))
    .map((d) => normalize(d));
}

function isJunk(track, req) {
  if (req && req.allowJunk) return false;
  const artists = (track.artists || []).map((a) => a.name).join(' ');
  const album = (track.album && track.album.name) || '';
  return JUNK_TRACK_RE.test(`${track.name} ${album}`) || JUNK_ARTIST_RE.test(artists);
}

/**
 * Hard filter. Removes karaoke/covers/tributes (unless explicitly asked for),
 * tracks Spotify says aren't playable in the user's market, and local files.
 */
function filterTracks(tracks, req) {
  const kept = [];
  const dropped = [];
  for (const t of tracks) {
    if (!t || !t.uri || t.is_local) continue;
    if (t.is_playable === false) {
      dropped.push({ track: t, reason: 'not_playable' });
    } else if (isJunk(t, req)) {
      dropped.push({ track: t, reason: 'junk' });
    } else {
      kept.push(t);
    }
  }
  return { kept, dropped };
}

/** Peel this track's artist words off either end of the phrase: "arijit singh ka kesariya". */
function implicitSplit(queryToks, artistLists) {
  const all = artistLists.flat().filter((a) => a.length >= 2);
  if (!all.length) return null;
  const isArtistTok = (t) => t.length >= 2 && all.some((a) => tokensMatch(t, a) || (t.length >= 4 && a.startsWith(t)));

  let i = 0;
  while (i < queryToks.length && isArtistTok(queryToks[i])) i++;
  let j = queryToks.length;
  while (j > i && isArtistTok(queryToks[j - 1])) j--;
  if (i === 0 && j === queryToks.length) return null;

  const artist = [...queryToks.slice(0, i), ...queryToks.slice(j)];
  let title = queryToks.slice(i, j);
  while (title.length && CONNECTORS.has(title[0])) title = title.slice(1);
  while (title.length && CONNECTORS.has(title[title.length - 1])) title = title.slice(0, -1);
  if (!title.length || !artist.length) return null;
  return { title, artist };
}

function scoreTrack(req, track, meta = {}) {
  const titleToks = cleanTitleTokens(track.name);
  const artistLists = (track.artists || []).map((a) => phoneticTokens(a.name));
  const tags = versionTags(track.name);
  const fullName = normalize(track.name);

  const pos = typeof meta.position === 'number' ? meta.position : 9;
  const posPrior = Math.max(0, 1 - pos * 0.1);
  const pop = typeof track.popularity === 'number' ? track.popularity / 100 : null;
  const prior = pop === null ? posPrior : 0.5 * pop + 0.5 * posPrior;

  let best = { score: 0, reading: null, titleSim: 0, artistSim: null };

  for (const r of req.readings) {
    const qTitle = r.title.map(phonetic);
    const qArtist = r.artist ? r.artist.map(phonetic) : null;

    const candidates = [{ title: qTitle, artist: qArtist, explicit: !!qArtist }];
    if (!qArtist) {
      const split = implicitSplit(qTitle, artistLists);
      if (split) candidates.push({ title: split.title, artist: split.artist, explicit: false });
    }

    for (const c of candidates) {
      const tSim = titleSimilarity(c.title, titleToks);
      let s;
      let aSim = null;
      if (c.artist) {
        aSim = artistSimilarity(c.artist, artistLists);
        s = 0.7 * tSim + 0.2 * aSim + 0.1 * prior;
        if (c.explicit && aSim < 0.5) s -= 0.15; // they named a different artist
      } else {
        s = 0.88 * tSim + 0.12 * prior;
      }
      if (s > best.score) best = { score: s, reading: r.label, titleSim: tSim, artistSim: aSim };
    }
  }

  let score = best.score;

  // Versions: plain title beats "(Lofi Flip)" / " - Live" unless that's what was asked for.
  const wanted = req.versionWanted || [];
  if (tags.length && !wanted.some((w) => tags.some((t) => t.includes(w)))) score -= 0.12;
  if (wanted.length) {
    const has = wanted.every((w) => fullName.includes(w) || (track.album && normalize(track.album.name).includes(w)));
    score += has ? 0.03 : -0.1;
  }

  // Explicitly asked for karaoke/cover ("stronger karaoke"): now the junk IS the target.
  if (req.allowJunk) score += isJunk(track, null) ? 0.08 : -0.1;

  // Film/album hint ("kesariya from brahmastra"): small bonus only.
  if (req.album && track.album) {
    const albumToks = phoneticTokens(track.album.name);
    if (req.album.map(phonetic).some((a) => albumToks.some((b) => tokensMatch(a, b)))) score += 0.04;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    titleSim: best.titleSim,
    artistSim: best.artistSim,
    reading: best.reading,
    versionTags: tags,
    prior: Number(prior.toFixed(2))
  };
}

/** Same song on different albums/compilations collapses to one entry (keeps the best). */
function songKey(track) {
  const primary = track.artists && track.artists[0] ? phoneticTokens(track.artists[0].name).join('') : '';
  return cleanTitleTokens(track.name).join('') + '|' + primary + '|' + versionTags(track.name).join(',');
}

/**
 * scoreTracks(req, entries) where entries = [{ track, position }]
 * Returns ranked [{ track, score, details }] with duplicates collapsed.
 */
function scoreTracks(req, entries) {
  const byKey = new Map();
  for (const { track, position } of entries) {
    const details = scoreTrack(req, track, { position });
    const key = songKey(track);
    const prev = byKey.get(key);
    if (!prev || details.score > prev.score) byKey.set(key, { track, score: details.score, details });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

/**
 * The confidence gate. Never plays a weak match.
 *   play       -> score >= threshold (alternatives attached if #2 is within margin)
 *   choose     -> options threshold <= score < play threshold: return top 3, don't play
 *   not_found  -> nothing credible
 */
function pickBestTrack(ranked, req) {
  const playAt = req.source === 'llm' ? THRESHOLDS.playLlm : req.implicit ? THRESHOLDS.playImplicit : THRESHOLDS.play;
  const top = ranked[0];
  const credible = ranked.filter((r) => r.score >= THRESHOLDS.options).slice(0, 3);

  if (!top || top.score < THRESHOLDS.options) {
    return { action: 'not_found', confidence: top ? top.score : 0, options: [] };
  }
  if (top.score >= playAt) {
    const second = ranked[1];
    const close = second && top.score - second.score < THRESHOLDS.margin;
    return {
      action: 'play',
      confidence: top.score,
      best: top,
      alternatives: close ? credible.slice(1) : []
    };
  }
  return { action: 'choose', confidence: top.score, options: credible };
}

module.exports = {
  THRESHOLDS,
  filterTracks,
  scoreTrack,
  scoreTracks,
  pickBestTrack,
  isJunk,
  versionTags,
  cleanTitleTokens,
  implicitSplit
};
