/* The status deck: does the action map put every action in the right column,
 * and does a long tracker carry on to another slide instead of running off one?
 *
 *   node test/deck.cjs
 *
 * The deck lives in lib/deck.js, shared by the Export button and the morning
 * email. This checks the rules the deck shares with the brief -- ownership by
 * tag, falling back to the company's owner, and whatever bullet was typed --
 * plus the deck's own shape: a cover, the detailed status, then the action
 * map, each on as many slides as its rows need, at a fixed 10pt, no company in
 * the action map that nobody has an action on, and the email's WHAT MOVED
 * slide only when it is asked for. Last, that index.html actually uses it.
 */
const fs = require('fs');
const path = require('path');

/* lib/deck.js is a plain script that hangs BMVDeck on the global, which is
   how both the page and the email load it. Load it the same way here. */
new Function(fs.readFileSync(path.join(__dirname, '..', 'lib', 'deck.js'), 'utf8'))();
const D = globalThis.BMVDeck;
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const co = (company, owner, nextAction, extra) => Object.assign(
  { company, owner, nextAction, priority: 'Immediate', issueTitle: 'A title.',
    latestStatus: 'Where it stands.', closure: 'The outcome.' }, extra || {});
const load = companies => ({ deckSlides: opts => D.slides(companies, opts) });
const dkActionsByPerson = D.actionsByPerson, dkPages = D.pages, DK_BOTTOM = D.BOTTOM;

const COMPANIES = [
  co('Tagged',   'Rafik', '• Reem: decide it\n• Mina, Rafik: draft it'),
  co('Untagged', 'Mina',  '• Chase the courier'),
  co('Star',     'Rafik', '*Reem: typed with an asterisk'),
  co('NoSpace',  'Rafik', '•Reem: bullet with no space'),
  co('Obtain',   'Rafik', 'Obtain the signed letter'),
  co('Stranger', 'Hisham','• Nobody we know owns this'),
  co('Quiet',    'Rafik', ''),
];

const { deckSlides } = load(COMPANIES);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${name.padEnd(50)} ${ok ? 'ok' : 'FAILED'}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const cols = c => dkActionsByPerson(COMPANIES.find(x => x.company === c));

/* slide XML helpers */
const title = s => (s.match(/<a:t>(DETAILED STATUS|ACTION MAP|WHAT MOVED)<\/a:t>/) || [, 'cover'])[1];
const texts = s => [...s.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
const sizeOf = (s, text) => {
  const m = s.match(new RegExp('sz="(\\d+)"[^>]*>(?:(?!</a:rPr>).)*</a:rPr><a:t>' +
                               text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</a:t>'));
  return m ? +m[1] : null;
};
const lowestEdge = s => Math.max(...[...s.matchAll(/<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/g)]
  .map(m => [+m[1], +m[2]])
  .filter(([y]) => y < DK_BOTTOM * 914400)             /* the table, not the footer or note */
  .map(([y, h]) => (y + h) / 914400));

console.log('  who owns what');
const t = cols('Tagged').byPerson;
check('a tag decides the column',
  t.Reem.length === 1 && t.Mina.length === 1 && t.Rafik.length === 1,
  JSON.stringify(t));
check('an untagged line goes to the company owner', cols('Untagged').byPerson.Mina.length === 1);
check('"*Reem:" is Reem\'s, not the owner\'s',
  cols('Star').byPerson.Reem.length === 1 && cols('Star').byPerson.Rafik.length === 0);
check('"•Reem:" with no space is Reem\'s', cols('NoSpace').byPerson.Reem.length === 1);
check('stripping a bullet keeps the first letter',
  cols('Obtain').byPerson.Rafik[0] === 'Obtain the signed letter',
  JSON.stringify(cols('Obtain').byPerson.Rafik[0]));
check('an unowned line is counted, not silently lost', cols('Stranger').unowned === 1);

console.log('\n  a short tracker');
const slides = deckSlides();
check('a cover, the status, then the map', slides.map(title).join() === 'cover,DETAILED STATUS,ACTION MAP',
  slides.map(title).join(' / '));
check('the status carries the targeted outcome',
  /TARGETED OUTCOME/.test(slides[1]) && /The outcome\./.test(slides[1]));
check('the map has a column per person',
  /REEM/.test(slides[2]) && /MINA/.test(slides[2]) && /RAFIK/.test(slides[2]));
check('table text is 10pt, company names 11pt',
  sizeOf(slides[1], 'The outcome.') === 1000 && sizeOf(slides[2], 'Obtain the signed letter') === 1000 &&
  sizeOf(slides[1], 'Tagged') === 1100,
  `outcome ${sizeOf(slides[1], 'The outcome.')}, action ${sizeOf(slides[2], 'Obtain the signed letter')}, company ${sizeOf(slides[1], 'Tagged')}`);
check('actions are real bullets, not a typed "•"',
  /<a:buChar char="•"\/>/.test(slides[2]) && !texts(slides[2]).some(x => /^[•*]/.test(x)));
check('a company with no action is not on the map', !/>Quiet</.test(slides[2]));
check('a company with no action is still in the status', />Quiet</.test(slides[1]));
check('the unowned line is named on the map', /no owner and is not shown/.test(slides[2]));
check('a single slide says nothing about pages', !/ of \d/.test(slides.join('')));
check('the old slides are gone', !/CLASSIFICATION|DECISIONS/.test(slides.join('')));

console.log('\n  pagination');
const P = dkPages([1, 1, 1, 1, 1, 1, 1], 6);
check('rows are balanced, no straggler slide', P.length === 2 && P[0].length === 4 && P[1].length === 3,
  JSON.stringify(P));
check('what fits stays on one slide', dkPages([1, 1, 1], 6).length === 1);
check('no rows is one empty page, not a crash', dkPages([], 6).length === 1);

/* Twenty companies with paragraphs in every cell: more than one slide each. */
const words = n => Array.from({ length: n }, (_, i) => 'word' + (i % 7)).join(' ') + '.';
const LONG = Array.from({ length: 20 }, (_, i) => co('Co' + String(i).padStart(2, '0'), 'Rafik',
  `• Reem: ${words(30)}\n• Mina: ${words(25)}\n• ${words(20)}`,
  { issueTitle: words(18), latestStatus: words(40), closure: words(22) }));
const big = load(LONG).deckSlides();
const order = big.map(title);
const statusPages = big.filter(s => title(s) === 'DETAILED STATUS');
const mapPages = big.filter(s => title(s) === 'ACTION MAP');
check('both tables carry on to more slides', statusPages.length > 1 && mapPages.length > 1,
  order.join(' / '));
check('status pages all come before map pages',
  order.lastIndexOf('DETAILED STATUS') < order.indexOf('ACTION MAP'));
const once = pages => LONG.every(c =>
  pages.reduce((n, s) => n + texts(s).filter(x => x === c.company).length, 0) === 1);
check('every company exactly once in the status', once(statusPages));
check('every company exactly once in the map', once(mapPages));
check('the header repeats on every page',
  statusPages.every(s => /TARGETED OUTCOME/.test(s)) && mapPages.every(s => /RAFIK/.test(s)));
check('pages say "i of n"',
  statusPages.every((s, i) => s.includes(`${i + 1} of ${statusPages.length}`)));
const edges = big.slice(1).map(lowestEdge);
check('no page runs past the bottom of the table area',
  edges.every(e => e <= DK_BOTTOM + 0.02), edges.map(e => e.toFixed(2)).join(' '));
const footers = big.slice(1).map(s => +(s.match(/Legal, Investment &amp; Value Creation\s+(\d+)/) || [])[1]);
check('footers number the slides in order', footers.every((n, i) => n === i + 2), footers.join(' '));
check('the long tracker stays at 10pt', big.slice(1).every(s => {
  const sz = [...s.matchAll(/sz="(\d+)"/g)].map(m => +m[1]);
  return !sz.some(v => v < 800) && sz.includes(1000);
}));

console.log('\n  the morning email\'s extras');
const MOVED = { sub: '2 entries in the last three days',
  rows: [{ company: 'Tagged', date: '14 Sep', entry: '• First line\n* second line', source: 'Email' },
         { company: 'Obtain', date: '13 Sep', entry: 'Obtain moved', source: 'Call' }],
  note: 'Also ticked off: Star  |  1 action' };
const withMoved = deckSlides({ date: '2026-09-15', byDay: true, moved: MOVED });
const last = withMoved[withMoved.length - 1];
check('the email adds WHAT MOVED, last', title(last) === 'WHAT MOVED' &&
  withMoved.map(title).join() === 'cover,DETAILED STATUS,ACTION MAP,WHAT MOVED',
  withMoved.map(title).join(' / '));
check('the Export deck has no WHAT MOVED', !slides.some(s => title(s) === 'WHAT MOVED'));
check('a history entry keeps its lines, bullets off',
  texts(last).includes('First line') && texts(last).includes('second line') &&
  !texts(last).some(x => /^[•*]/.test(x)));
check('ticked-off actions are the note', last.includes('Also ticked off: Star'));
check('its footer carries on the numbering', /Value Creation\s+4</.test(last));
check('the email cover is dated by day', texts(withMoved[0]).some(x => x.startsWith('15 September 2026')),
  texts(withMoved[0]).join(' / '));
check('the Export cover is dated by month',
  texts(deckSlides({ date: '2026-09-15' })[0]).some(x => x.startsWith('September 2026')));
const onlyTicked = deckSlides({ moved: { sub: 's', rows: [], note: 'Also ticked off: A' } });
check('only tick-box history still gets a slide, and says so',
  title(onlyTicked[onlyTicked.length - 1]) === 'WHAT MOVED' &&
  onlyTicked[onlyTicked.length - 1].includes('Nothing logged beyond'));
check('no history at all, no WHAT MOVED slide',
  !deckSlides({ moved: { sub: 's', rows: [], note: '' } }).some(s => title(s) === 'WHAT MOVED'));
const bare = load([co('A', 'Rafik', '')]).deckSlides();
check('an empty action map says so', bare[2].includes('No next actions are recorded.'));
const bytes = D.build(COMPANIES, { moved: MOVED });
const asText = Buffer.from(bytes).toString('latin1');
check('build() gives a .pptx: a ZIP with every slide in it',
  asText.startsWith('PK') && (asText.match(/ppt\/slides\/slide\d+\.xml(?!\.rels)/g) || []).length >= 4 * 2,
  `${bytes.length} bytes`);

console.log('\n  shapes it must survive');
for (const [label, cos] of [
  ['no companies',           []],
  ['every action cleared',   COMPANIES.map(c => ({ ...c, nextAction: '' }))],
  ['every field empty',      COMPANIES.map(c => ({ company: c.company }))],
  ['every field null',       COMPANIES.map(c => Object.fromEntries(Object.keys(c).map(k => [k, null])))],
  ['a null company',         [null, COMPANIES[0]]],
  ['one enormous action',    [co('Huge', 'Rafik', '• ' + words(900))]],
]) {
  let note = '';
  try {
    const s = load(cos).deckSlides({ moved: { sub: 's', rows: [null, { entry: null }], note: '' } });
    if (s.length < 3) note = `${s.length} slides`;
    D.build(cos, {});
  } catch (err) { note = 'THREW: ' + err.message; }
  check(label, !note, note);
}

console.log('\n  index.html uses it');
const app = html.match(/<script id="app">([\s\S]*?)<\/script>/);
check('lib/deck.js loads before the app script',
  html.indexOf('<script src="lib/deck.js"></script>') > -1 &&
  html.indexOf('<script src="lib/deck.js"></script>') < html.indexOf('<script id="app">'));
check('the app keeps no second copy of the deck',
  !/function (dkTables|deckSlides|buildPptx|parseAction|crc32)\b|var (BULLET|CRC_T|DKC)\b/.test(app[1]));
check('Export builds from BMVDeck', /BMVDeck\.build\(visible\(\)/.test(app[1]));
let parses = true;
try { new Function(app[1]); } catch (e) { parses = e.message; }
check('the app script still parses', parses === true, parses === true ? '' : parses);

console.log(failed ? `\n${failed} FAILED` : '\ndeck holds');
process.exit(failed ? 1 : 0);
