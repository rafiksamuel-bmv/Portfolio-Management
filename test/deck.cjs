/* The status deck: does the action map put every action in the right column,
 * and does a long tracker carry on to another slide instead of running off one?
 *
 *   node test/deck.cjs
 *
 * The deck lives in index.html, a browser page, so the parts under test are
 * lifted out of it verbatim and run here. It checks the rules the deck shares
 * with the brief -- ownership by tag, falling back to the company's owner, and
 * whatever bullet was typed -- plus the deck's own shape: a cover, the detailed
 * status, then the action map, each on as many slides as its rows need, at a
 * fixed 10pt, and no company in the action map that nobody has an action on.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sc = html.match(/<script id="app">([\s\S]*?)<\/script>/)[1];
const cut = (a, b) => {
  const i = sc.indexOf(a), j = sc.indexOf(b);
  if (i < 0 || j < 0 || j < i) throw new Error(`could not lift ${a} .. ${b} out of index.html`);
  return sc.slice(i, j);
};
const harness = `
${sc.match(/function esc\(s\)\{[\s\S]*?\n  \}/)[0]}
${sc.match(/function today\(\)\{.*?\}/)[0]}
${cut('var PRI_ORDER=', 'function visible()')}
${cut('function actionLines(c)', 'function doneBlock')}
var state = STATE, visible = function(){ return STATE.companies; };
function usdEq(){ return 0; } function parseLoose(){ return null; }
${cut('/* ---------- excel export', '/* ---------- shell ---------- */')}
return { deckSlides: deckSlides, dkActionsByPerson: dkActionsByPerson, dkPages: dkPages,
         DK_BOTTOM: DK_BOTTOM };
`;
global.TextEncoder = require('util').TextEncoder;

const co = (company, owner, nextAction, extra) => Object.assign(
  { company, owner, nextAction, priority: 'Immediate', issueTitle: 'A title.',
    latestStatus: 'Where it stands.', closure: 'The outcome.' }, extra || {});
const LISTS = { priority: ['Immediate', 'Near-Term', 'Postponed', 'No Action'] };
const load = companies => new Function('STATE', harness)({ companies, lists: LISTS });

const COMPANIES = [
  co('Tagged',   'Rafik', '• Reem: decide it\n• Mina, Rafik: draft it'),
  co('Untagged', 'Mina',  '• Chase the courier'),
  co('Star',     'Rafik', '*Reem: typed with an asterisk'),
  co('NoSpace',  'Rafik', '•Reem: bullet with no space'),
  co('Obtain',   'Rafik', 'Obtain the signed letter'),
  co('Stranger', 'Hisham','• Nobody we know owns this'),
  co('Quiet',    'Rafik', ''),
];

const { deckSlides, dkActionsByPerson, dkPages, DK_BOTTOM } = load(COMPANIES);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${name.padEnd(50)} ${ok ? 'ok' : 'FAILED'}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const cols = c => dkActionsByPerson(COMPANIES.find(x => x.company === c));

/* slide XML helpers */
const title = s => (s.match(/<a:t>(DETAILED STATUS|ACTION MAP)<\/a:t>/) || [, 'cover'])[1];
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

console.log('\n  shapes it must survive');
for (const [label, cos] of [
  ['no companies',           []],
  ['every action cleared',   COMPANIES.map(c => ({ ...c, nextAction: '' }))],
  ['every field empty',      COMPANIES.map(c => ({ company: c.company }))],
  ['one enormous action',    [co('Huge', 'Rafik', '• ' + words(900))]],
]) {
  let note = '';
  try {
    const s = load(cos).deckSlides();
    if (s.length < 3) note = `${s.length} slides`;
  } catch (err) { note = 'THREW: ' + err.message; }
  check(label, !note, note);
}

console.log(failed ? `\n${failed} FAILED` : '\ndeck holds');
process.exit(failed ? 1 : 0);
