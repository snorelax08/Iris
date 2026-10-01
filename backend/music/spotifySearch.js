'use strict';
/**
 * Thin Spotify /v1/search client for the resolver. Runs server-side with the
 * token the backend already holds (auth.js), so search can be tested, cached,
 * and logged in one place instead of in the browser.
 */
const axios = require('axios');

const SEARCH_URL = 'https://api.spotify.com/v1/search';
const LIMIT = Math.max(1, Math.min(50, parseInt(process.env.AKON_SEARCH_LIMIT || '10', 10) || 10));
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map(); // query -> { at, items }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheGet(q) {
  const hit = cache.get(q);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(q);
    return null;
  }
  cache.delete(q); // LRU bump
  cache.set(q, hit);
  return hit.items;
}

function cacheSet(q, items) {
  cache.set(q, { at: Date.now(), items });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Returns the raw track items for one query string, in Spotify's own order.
 * market=from_token: results are relinked/filtered for the user's country, and
 * each track carries is_playable, which filterTracks() uses.
 */
async function searchTracks(query, getToken, { retries = 1 } = {}) {
  const cached = cacheGet(query);
  if (cached) return cached;

  const token = await getToken();
  try {
    const res = await axios.get(SEARCH_URL, {
      params: { q: query, type: 'track', limit: LIMIT, market: 'from_token' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 4000
    });
    const items = (res.data && res.data.tracks && res.data.tracks.items) || [];
    cacheSet(query, items);
    return items;
  } catch (err) {
    const status = err.response && err.response.status;
    if (retries > 0 && (status === 429 || (status >= 500 && status < 600))) {
      const retryAfter = parseInt((err.response.headers || {})['retry-after'] || '1', 10);
      await sleep(Math.min(2000, Math.max(250, retryAfter * 1000)));
      return searchTracks(query, getToken, { retries: retries - 1 });
    }
    const e = new Error(`spotify_search_failed:${status || err.code || err.message}`);
    e.status = status;
    throw e;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { searchTracks, clearCache };
