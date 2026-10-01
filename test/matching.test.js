// Run with: npm test  (no network, no Spotify credentials)
//
// Exercises the REAL backend pipeline (parse -> queries -> search -> filter -> rank
// -> confidence gate) against a MOCK Spotify catalog. The mock search is a crude
// stand-in for Spotify's relevance ranking, so a pass here proves the logic, not
// live Spotify behaviour — verify the QA list in README.md against the real API.

const { resolveSong } = require('../backend/music/resolver');
const { extractIntent } = require('../shared/intent');
const { tokenize, phonetic } = require('../backend/music/text');

let id = 0;
const T = (name, artists, popularity, album) => ({
  id: `t${++id}`,
  uri: `spotify:track:t${id}`,
  name,
  artists: [].concat(artists).map((n) => ({ name: n })),
  album: { name: album || name, images: [] },
  popularity
});

const CATALOG = [
  T('Stronger', 'Kanye West', 82, 'Graduation'),
  T("Stronger (What Doesn't Kill You)", 'Kelly Clarkson', 75),
  T('Stronger', 'Britney Spears', 65),
  T('Stronger (Made Famous By Kanye West)', 'Karaoke Hit Factory', 5),
  T('Stronger - Tribute to Kanye West', 'Kanye West Tribute Band', 2),
  T('Stronger - Live', 'Kanye West', 30),
  T('Ye Tune Kya Kiya', ['Javed Bashir', 'Pritam'], 60, 'Once Upon A Time In Mumbai Dobara!'),
  T('Kya Kiya', 'Some Indie Artist', 20),
  T('Tune Jo Na Kaha', 'Mohit Chauhan', 55),
  T('Kesariya (From "Brahmastra")', ['Pritam', 'Arijit Singh', 'Amitabh Bhattacharya'], 80, 'Kesariya (From "Brahmastra")'),
  T('Kesariya - Lofi Flip', 'Lofi Guy', 30),
  T('Kesariya Dance Mix', ['Pritam', 'Arijit Singh'], 45),
  T('Believer', 'Imagine Dragons', 88, 'Evolve'),
  T('Believer (Kaskade Remix)', ['Imagine Dragons', 'Kaskade'], 40),
  T('Shape of You', 'Ed Sheeran', 90, '÷'),
  T('Shape of You (Acoustic)', 'Ed Sheeran', 40),
  T('Shape of You (Karaoke Version)', 'Sing2Piano', 3),
  T('Stand By Me', 'Ben E. King', 78),
  T('Stand', 'R.E.M.', 50),
  T('Tum Hi Ho', ['Mithoon', 'Arijit Singh'], 75, 'Aashiqui 2'),
  T('Kal Ho Naa Ho', ['Shankar-Ehsaan-Loy', 'Sonu Nigam'], 70),
  T('The Power', 'SNAP!', 70),
  T('POWER', 'Kanye West', 72),
  T('Love Song', 'Sara Bareilles', 60),
  T('Love Story', 'Taylor Swift', 80),
  T('Live Forever', 'Oasis', 65),
  T('Smack That', ['Akon', 'Eminem'], 75),
  T('Lonely', 'Akon', 70),
  T('Obscure Song (Karaoke Version)', 'Karaoke Kings', 1)
];

const phon = (s) => tokenize(s).map(phonetic);
const hay = (t) => phon(`${t.name} ${t.artists.map((a) => a.name).join(' ')}`);

// Crude Spotify stand-in: field filters are substring filters; free text ranks by
// word hits, then popularity. Returns at most 10 like the real endpoint.
async function mockSearch(q) {
  const field = q.match(/^track:"([^"]*)" artist:"([^"]*)"$/);
  let items;
  if (field) {
    const tq = phon(field[1]).join(' ');
    const aq = phon(field[2]).join(' ');
    items = CATALOG.filter(
      (t) => phon(t.name).join(' ').includes(tq) && phon(t.artists.map((a) => a.name).join(' ')).join(' ').includes(aq)
    );
  } else {
    const qt = phon(q);
    // Prefix matching approximates Spotify's search-as-you-type tolerance ("believe" -> "Believer").
    items = CATALOG.map((t) => ({ t, hits: qt.filter((w) => hay(t).some((h) => h === w || (w.length >= 4 && h.startsWith(w)))).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.t.popularity - a.t.popularity)
      .map((x) => x.t);
  }
  return items.slice(0, 10);
}

const noLlm = { enabled: () => false };
const fakeLlm = (answers) => ({ enabled: () => true, extract: async (text) => answers[text] || [] });
const LYRIC = 'that song that goes i got the power';

const cases = [
  // [query, expect, opts]
  ['stronger by kanye west', { play: 'Stronger', artist: 'Kanye West' }],
  ['stronger kanye west', { play: 'Stronger', artist: 'Kanye West' }],
  ['kanye west stronger', { play: 'Stronger', artist: 'Kanye West' }],
  ['stronger by kelly clarkson', { play: "Stronger (What Doesn't Kill You)", artist: 'Kelly Clarkson' }],
  ['stronger', { play: 'Stronger', artist: 'Kanye West', hasAlternatives: true }],
  ['ye tune kya kiya', { play: 'Ye Tune Kya Kiya' }],
  ['ye kesariya wala gaana', { play: 'Kesariya (From "Brahmastra")' }],
  ['kesariya wala gaana', { play: 'Kesariya (From "Brahmastra")' }],
  ['arijit singh ka kesariya', { play: 'Kesariya (From "Brahmastra")' }],
  ['kesaria', { play: 'Kesariya (From "Brahmastra")' }],
  ['kesariya lofi', { play: 'Kesariya - Lofi Flip' }],
  ['believer', { play: 'Believer', artist: 'Imagine Dragons' }],
  ['believe her', { play: 'Believer', artist: 'Imagine Dragons' }], // ASR slip
  ['believer remix', { play: 'Believer (Kaskade Remix)' }],
  ['shape of you', { play: 'Shape of You', artist: 'Ed Sheeran' }],
  ['stand by me', { play: 'Stand By Me' }],
  ['stand by me by ben e king', { play: 'Stand By Me' }],
  ['tum hi ho', { play: 'Tum Hi Ho' }],
  ['kal ho na ho', { play: 'Kal Ho Naa Ho' }],
  ['live forever by oasis', { play: 'Live Forever' }],
  ['love song', { play: 'Love Song' }],
  ['lonely by akon', { play: 'Lonely', artist: 'Akon' }],
  ['stronger karaoke', { play: 'Stronger (Made Famous By Kanye West)' }],
  ['cassarea', { play: 'Kesariya (From "Brahmastra")' }, { alternatives: ['kesariya'] }],
  // Must NOT play:
  ['obscure song by nobody', { notPlay: true }], // only a karaoke version exists
  ['what time is it', { notPlay: true }, { implicit: true }],
  [LYRIC, { notPlay: true }], // lyric fragment, no LLM configured
  // LLM proposes, ranking verifies:
  [LYRIC, { play: 'The Power', artist: 'SNAP!' }, { llm: fakeLlm({ [LYRIC]: [{ title: 'The Power', artist: 'SNAP!' }] }) }],
  [LYRIC, { notPlay: true }, { llm: fakeLlm({ [LYRIC]: [{ title: 'A Song That Does Not Exist', artist: 'Nobody' }] }) }]
];

const intentCases = [
  ['pause', 'pause'], ['pause the music', 'pause'], ['stop', 'pause'], ['gaana band karo', 'pause'],
  ['resume', 'resume'], ['play', 'resume'], ['continue', 'resume'], ['play some music', 'resume'],
  ['next', 'next'], ['next song', 'next'], ['skip this song', 'next'], ['play next', 'next'],
  ['play the next one', 'next'], ['agla gaana', 'next'], ['change the song', 'next'],
  ['previous', 'previous'], ['go back', 'previous'], ['previous song', 'previous'], ['pichla gaana', 'previous'],
  ['volume up', 'volume_up'], ['turn it up', 'volume_up'], ['louder please', 'volume_up'], ['awaaz badhao', 'volume_up'],
  ['volume down', 'volume_down'], ['quieter', 'volume_down'], ['volume kam karo', 'volume_down'],
  ['set volume to 40', 'volume_set'], ['volume 80 percent', 'volume_set'], ['mute', 'mute'],
  ['option two', 'select_option'], ['the second one', 'select_option'], ['dusra wala', 'select_option'],
  ['wrong song', 'reject'], ['not this one', 'reject'],
  ['play stronger by kanye west', 'play_song'], ['play turn up the music', 'play_song'],
  ['kesariya bajao', 'play_song'], ['ye tune kya kiya bajao', 'play_song'], ['can you play believer please', 'play_song'],
  ['play stop crying your heart out', 'play_song'], ['kesariya', 'play_song']
];

(async () => {
  let fails = 0;
  for (const [query, expect, opts = {}] of cases) {
    const r = await resolveSong(
      { query, alternatives: opts.alternatives || [], implicit: !!opts.implicit },
      { search: mockSearch, llm: opts.llm || noLlm }
    );
    let pass;
    if (expect.notPlay) pass = r.action !== 'play';
    else {
      pass = r.action === 'play' && r.track.name === expect.play && (!expect.artist || r.track.artists.includes(expect.artist));
      if (expect.hasAlternatives) pass = pass && r.alternatives.length > 0;
    }
    if (!pass) fails++;
    const got = r.track
      ? `${r.track.name} — ${r.track.artists.join(', ')} (${r.track.score})`
      : (r.options || []).map((o) => `${o.name} (${o.score})`).join(' | ') || '-';
    console.log(`${pass ? 'PASS' : 'FAIL'}  "${query}"${opts.llm ? ' [llm]' : ''} -> ${r.action}: ${got}`);
    if (!pass) console.log('      top:', JSON.stringify(r.debug.top.slice(0, 3)), '\n      readings:', r.debug.readings);
  }

  console.log('');
  for (const [text, type] of intentCases) {
    const i = extractIntent(text);
    const pass = i.type === type;
    if (!pass) fails++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  intent "${text}" -> ${JSON.stringify(i)}`);
  }

  console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(fails ? 1 : 0);
})();
