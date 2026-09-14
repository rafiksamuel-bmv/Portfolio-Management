/* The status deck: does the action map put every action in the right column?
 *
 *   node test/deck.cjs
 *
 * The deck lives in index.html, a browser page, so the parts under test are
 * lifted out of it verbatim and run here. It checks the rules the deck shares
 * with the brief -- ownership by tag, falling back to the company's owner, and
 * whatever bullet was typed -- plus the deck's own shape: a cover and two
 * slides, and no company in the action map that nobody has an action on.
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
return { deckSlides: deckSlides, dkActionsByPerson: dkActionsByPerson };
`;
global.TextEncoder = require('util').TextEncoder;

const co = (company, owner, nextAction, extra) => Object.assign(
  { company, owner, nextAction, priority: 'Immediate', issueTitle: 'A title.',
    latestStatus: 'Where it stands.', closure: 'The outcome.' }, extra || {});

const COMPANIES = [
  co('Tagged',   'Rafik', '• Reem: decide it\n• Mina, Rafik: draft it'),
  co('Untagged', 'Mina',  '• Chase the courier'),
  co('Star',     'Rafik', '*Reem: typed with an asterisk'),
  co('NoSpace',  'Rafik', '•Reem: bullet with no space'),
  co('Obtain',   'Rafik', 'Obtain the signed letter'),
  co('Stranger', 'Hisham','• Nobody we know owns this'),
  co('Quiet',    'Rafik', ''),
];

const { deckSlides, dkActionsByPerson } =
  new Function('STATE', harness)({ companies: COMPANIES,
    lists: { priority: ['Immediate', 'Near-Term', 'Postponed', 'No Action'] } });

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${name.padEnd(46)} ${ok ? 'ok' : 'FAILED'}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const cols = c => dkActionsByPerson(COMPANIES.find(x => x.company === c));

const t = cols('Tagged').byPerson;
check('a tag decides the column',
  t.Reem.length === 1 && t.Mina.length === 1 && t.Rafik.length === 1,
  JSON.stringify(t));
check('an untagged line goes to the company owner', cols('Untagged').byPerson.Mina.length === 1);
check('"*Reem:" is Reem\'s, not the owner\'s',
  cols('Star').byPerson.Reem.length === 1 && cols('Star').byPerson.Rafik.length === 0);
check('"•Reem:" with no space is Reem\'s', cols('NoSpace').byPerson.Reem.length === 1);
check('stripping a bullet keeps the first letter',
  cols('Obtain').byPerson.Rafik[0] === '• Obtain the signed letter',
  JSON.stringify(cols('Obtain').byPerson.Rafik[0]));
check('an unowned line is counted, not silently lost', cols('Stranger').unowned === 1);

const slides = deckSlides();
check('a cover and two slides', slides.length === 3, `${slides.length} slides`);
check('slide 2 carries the targeted outcome',
  /DETAILED STATUS/.test(slides[1]) && /TARGETED OUTCOME/.test(slides[1]) && /The outcome\./.test(slides[1]));
check('slide 3 is the action map, by person',
  /ACTION MAP/.test(slides[2]) && /REEM/.test(slides[2]) && /MINA/.test(slides[2]) && /RAFIK/.test(slides[2]));
check('a company with no action is not on the map', !/>Quiet</.test(slides[2]));
check('the unowned line is named on the map', /no owner and is not shown/.test(slides[2]));
check('the old slides are gone', !/CLASSIFICATION|DECISIONS/.test(slides.join('')));

console.log(failed ? `\n${failed} FAILED` : '\ndeck holds');
process.exit(failed ? 1 : 0);
