'use strict';
const express = require('express');
const { getValidAccessToken } = require('../auth');
const { resolveSong } = require('../music/resolver');
const { searchTracks } = require('../music/spotifySearch');
const llm = require('../music/llm');
const { extractIntent } = require('../../shared/intent');

const router = express.Router();

const deps = {
  search: (q) => searchTracks(q, getValidAccessToken),
  llm: { enabled: llm.enabled, extract: llm.llmExtract }
};

/**
 * POST /api/resolve  { query, alternatives?: string[], implicit?: boolean }
 * Returns { action: 'play'|'choose'|'not_found', track?, alternatives?, options?, message, debug }
 * The browser plays the returned URI through the Web Playback SDK; the server never
 * starts playback itself, so it can't target the wrong device.
 */
router.post('/resolve', async (req, res) => {
  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query.slice(0, 200) : '';
  if (!query.trim()) return res.status(400).json({ error: 'missing_query' });

  const alternatives = Array.isArray(body.alternatives)
    ? body.alternatives.filter((a) => typeof a === 'string').map((a) => a.slice(0, 200)).slice(0, 4)
    : [];

  try {
    const result = await resolveSong({ query, alternatives, implicit: !!body.implicit }, deps);
    const top = result.track || (result.options && result.options[0]);
    console.log(
      `[Akon:resolve] "${query}" -> ${result.action}` +
        (top ? ` ${top.name} — ${top.artists.join(', ')} (${top.score})` : '') +
        ` [${result.source}, ${result.debug.ms}ms, ${result.debug.queries.length} queries]`
    );
    res.json(result);
  } catch (err) {
    const status = err.status === 401 ? 401 : 502;
    console.error('[Akon:resolve] failed:', err.message);
    res.status(status).json({ error: err.message });
  }
});

// Handy for debugging phrasing without speaking: GET /api/intent?text=agla%20gaana
router.get('/intent', (req, res) => {
  res.json(extractIntent(String(req.query.text || '')));
});

module.exports = router;
