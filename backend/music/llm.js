'use strict';
/**
 * OPTIONAL. Only active when ANTHROPIC_API_KEY is set.
 *
 * The LLM never picks the track that plays. It only proposes {title, artist}
 * guesses for inputs the heuristics can't handle (lyric fragments, badly garbled
 * Hinglish). Every guess is then searched on Spotify and must pass the same
 * ranking, with a STRICTER play threshold (THRESHOLDS.playLlm). A hallucinated
 * song simply fails to match anything and falls through to "not found".
 */
const axios = require('axios');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.AKON_LLM_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = parseInt(process.env.AKON_LLM_TIMEOUT_MS || '2500', 10);

const SYSTEM = [
  'You convert a spoken request for a music player into Spotify search candidates.',
  'Input may be English, Hindi, or Hinglish written in Latin script, may contain',
  'speech-recognition errors, filler words, or a lyric fragment instead of a title.',
  'Respond with ONLY a JSON object, no prose, no code fences:',
  '{"kind":"title"|"lyric"|"unknown","candidates":[{"title":"...","artist":"..." or null}]}',
  'Rules: at most 3 candidates, most likely first. Use the official title as it appears',
  'on Spotify (romanized for Hindi songs). Include the original artist, never a cover.',
  'If you do not recognize a real song, return an empty candidates array. Never invent songs.'
].join(' ');

function enabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function parseJson(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/** Returns [{title, artist}] (possibly empty). Never throws. */
async function llmExtract(utterance) {
  if (!enabled()) return [];
  try {
    const res = await axios.post(
      API_URL,
      {
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: String(utterance).slice(0, 300) }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: TIMEOUT_MS
      }
    );
    const text = (res.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJson(text);
    if (!parsed || !Array.isArray(parsed.candidates)) return [];
    return parsed.candidates
      .filter((c) => c && typeof c.title === 'string' && c.title.trim())
      .slice(0, 3)
      .map((c) => ({ title: c.title.trim(), artist: typeof c.artist === 'string' && c.artist.trim() ? c.artist.trim() : null }));
  } catch (err) {
    console.warn('[Akon:llm] extraction skipped:', err.response ? err.response.status : err.message);
    return [];
  }
}

module.exports = { llmExtract, enabled };
