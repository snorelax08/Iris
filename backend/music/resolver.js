'use strict';
/**
 * Song resolution pipeline:
 *   text -> parseSongRequest -> buildSearchQueries -> Spotify search (batched, parallel)
 *        -> filterTracks -> scoreTracks -> pickBestTrack (confidence gate)
 *        -> [optional LLM candidates -> same search/rank, stricter gate]
 *
 * Dependencies are injected (search, llm) so the whole pipeline runs offline in tests.
 */
const { parseSongRequest, buildSearchQueries } = require('./query');
const { filterTracks, scoreTracks, pickBestTrack } = require('./rank');

const BATCH = 3;

function formatTrack(entry) {
  const t = entry.track;
  const imgs = (t.album && t.album.images) || [];
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    album: t.album ? t.album.name : null,
    albumUri: t.album && t.album.uri ? t.album.uri : null,
    art: imgs.length ? imgs[0].url : null,
    score: Number(entry.score.toFixed(3))
  };
}

const label = (e) => `${e.track.name} — ${(e.track.artists || []).map((a) => a.name).join(', ')}`;

/** Runs queries in parallel batches until the gate says "play". */
async function searchAndRank(req, search, trace) {
  const queries = buildSearchQueries(req);
  const pool = new Map(); // track id/uri -> { track, position }
  const dropped = [];
  let ranked = [];
  let decision = { action: 'not_found', confidence: 0, options: [] };
  let firstError = null;
  let anySucceeded = false;

  for (let i = 0; i < queries.length; i += BATCH) {
    const batch = queries.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map((q) => search(q)));

    results.forEach((r, k) => {
      if (r.status !== 'fulfilled') {
        firstError = firstError || r.reason;
        trace.errors.push(`${batch[k]}: ${r.reason && r.reason.message}`);
        return;
      }
      anySucceeded = true;
      trace.queries.push({ q: batch[k], n: r.value.length });
      r.value.forEach((track, position) => {
        if (!track) return;
        const id = track.id || track.uri;
        const prev = pool.get(id);
        if (!prev || position < prev.position) pool.set(id, { track, position });
      });
    });

    const { kept, dropped: d } = filterTracks([...pool.values()].map((p) => p.track), req);
    const keptIds = new Set(kept.map((t) => t.id || t.uri));
    dropped.splice(0, dropped.length, ...d);
    ranked = scoreTracks(req, [...pool.values()].filter((p) => keptIds.has(p.track.id || p.track.uri)));
    decision = pickBestTrack(ranked, req);
    if (decision.action === 'play') break; // confident: don't spend more round trips
  }

  // Every Spotify call failed (logged out, network, rate limit): that's an error,
  // not "song not found" — reporting it as not-found hid auth problems.
  if (!anySucceeded && firstError) throw firstError;

  trace.dropped = dropped.slice(0, 5).map((d) => `${d.track.name} (${d.reason})`);
  trace.top = ranked.slice(0, 5).map((e) => ({
    track: label(e),
    score: Number(e.score.toFixed(3)),
    reading: e.details.reading,
    title: Number(e.details.titleSim.toFixed(2)),
    artist: e.details.artistSim === null ? null : Number(e.details.artistSim.toFixed(2)),
    prior: e.details.prior
  }));
  return { ranked, decision };
}

function dedupeOptions(list) {
  const seen = new Set();
  return list.filter((o) => (seen.has(o.uri) ? false : (seen.add(o.uri), true))).slice(0, 3);
}

function message(result) {
  const who = (t) => `${t.name} by ${t.artists.join(', ')}`;
  if (result.action === 'play') {
    return result.alternatives.length
      ? `Playing ${who(result.track)}. Not it? Say "option two" for ${who(result.alternatives[0])}.`
      : `Playing ${who(result.track)}.`;
  }
  if (result.action === 'choose') {
    return 'Did you mean: ' + result.options.map((o, i) => `${i + 1}) ${who(o)}`).join(', ') + '? Say "option one", "two" or "three".';
  }
  if (result.reason === 'lyric_search_unavailable') {
    return "I can't search by lyrics yet. Tell me the song title or the artist.";
  }
  return "I couldn't find that song. Try saying the title and the artist.";
}

/**
 * resolveSong({ query, alternatives, implicit }, { search, llm }) -> {
 *   action: 'play' | 'choose' | 'not_found',
 *   track?, alternatives?, options?, confidence, source, message, debug
 * }
 */
async function resolveSong(input, deps) {
  const started = Date.now();
  const { search, llm } = deps;
  const trace = { queries: [], errors: [] };

  const req = parseSongRequest(input.query, { alternatives: input.alternatives, implicit: input.implicit });
  let { decision } = await searchAndRank(req, search, trace);
  let source = 'heuristic';

  let result;
  if (decision.action === 'play') {
    result = {
      action: 'play',
      track: formatTrack(decision.best),
      alternatives: decision.alternatives.map(formatTrack),
      confidence: decision.confidence
    };
  }

  // LLM fallback only when heuristics didn't reach "play" (or it's clearly a lyric).
  const llmOn = llm && llm.enabled && llm.enabled();
  if (llmOn && (!result || req.lyric)) {
    const guesses = await llm.extract(input.query);
    trace.llm = guesses;
    const llmOptions = [];
    for (const g of guesses) {
      const gReq = parseSongRequest(g.artist ? `${g.title} by ${g.artist}` : g.title, {
        source: 'llm',
        hint: g
      });
      const gTrace = { queries: [], errors: [] };
      let r;
      try {
        r = await searchAndRank(gReq, search, gTrace);
      } catch (err) {
        trace.errors.push(`llm guess "${g.title}": ${err.message}`);
        continue;
      }
      trace.queries.push(...gTrace.queries.map((q) => ({ ...q, llm: true })));
      if (r.decision.action === 'play' && (!result || req.lyric)) {
        result = {
          action: 'play',
          track: formatTrack(r.decision.best),
          alternatives: r.decision.alternatives.map(formatTrack),
          confidence: r.decision.confidence
        };
        source = 'llm';
        break;
      }
      llmOptions.push(...(r.decision.options || []).map(formatTrack));
    }
    if (!result && llmOptions.length) {
      const heuristicOptions = decision.action === 'choose' ? decision.options.map(formatTrack) : [];
      const options = dedupeOptions([...heuristicOptions, ...llmOptions].sort((a, b) => b.score - a.score));
      result = { action: 'choose', options, confidence: options[0].score };
      source = 'llm';
    }
  }

  if (!result) {
    if (decision.action === 'choose') {
      result = { action: 'choose', options: decision.options.map(formatTrack), confidence: decision.confidence };
    } else {
      result = { action: 'not_found', options: [], confidence: decision.confidence };
      if (req.lyric && !llmOn) result.reason = 'lyric_search_unavailable';
    }
  }

  result.source = source;
  result.confidence = Number((result.confidence || 0).toFixed(3));
  result.message = message(result);
  result.debug = {
    ms: Date.now() - started,
    cleaned: req.cleaned,
    lyric: req.lyric,
    readings: req.readings.map((r) => `${r.label}: "${r.title.join(' ')}"${r.artist ? ` / artist "${r.artist.join(' ')}"` : ''}`),
    ...trace
  };
  return result;
}

module.exports = { resolveSong, formatTrack };
