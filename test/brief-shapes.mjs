/* Does the brief survive the shapes the tracker can actually be in?
 *
 *   node test/brief-shapes.mjs
 *
 * Editing the tracker must never be able to stop the morning brief. It did
 * once: clearing a company's last next_action left it on no desk at all, and
 * the Unassigned block called a deskItem() that had never existed, so
 * buildBrief threw and the cron sent nothing to anybody.
 *
 * Every case below is a state a person can put the tracker into from the app
 * in a few clicks. Run this after touching desk routing, the grid, or anything
 * that reads a company field. It exits non-zero on the first failure.
 */
import { buildBrief, briefPdf, fallbackBrief } from '../api/daily-brief.js';

const TODAY = new Date(Date.UTC(2026, 8, 7));

/* A small tracker that exercises each routing path: one company per desk, one
   decided, one with no dependency at all. */
const COMPANIES = [
  { id: 'c1', num: 1, company: 'Alpha', priority: 'Immediate', owner: 'Mina',
    due: '1 Sep 2026', maturity_date: '2025-06-14', ccy: 'USD', invested: 125000,
    status: 'Pending legal', dependency: 'Legal Counsel',
    issue_title: 'A legal question.', latest_status: 'Waiting on counsel.',
    next_action: '• Mina: Chase counsel.', closure: 'Close it.',
    legal_next: 'YES', legal_req: 'An opinion.', updated_at: '2026-09-06T09:00:00Z' },
  { id: 'c2', num: 2, company: 'Beta', priority: 'Near-Term', owner: 'Rafik',
    due: '30 Sep 2026', maturity_date: '2026-12-27', ccy: 'EGP', invested: 14000000,
    status: 'Pending company', dependency: 'Founders / Company',
    issue_title: 'A company question.', latest_status: 'Waiting on the founders.',
    next_action: '• Rafik: Chase the founders.\n• Reem: Decide after that.',
    closure: 'Close it.', legal_next: 'NO', updated_at: '2026-09-06T09:00:00Z' },
  { id: 'c3', num: 3, company: 'Gamma', priority: 'No Action', owner: 'Rafik',
    due: '31 Oct 2026 (Q3)', maturity_date: '', ccy: 'USD', invested: 125000,
    status: 'Pending company', dependency: 'No Dependency',
    issue_title: 'No critical issue ongoing.', latest_status: '',
    next_action: '• Rafik: Keep monitoring.', closure: 'Support where we can.',
    legal_next: 'NO', updated_at: '2026-09-06T09:00:00Z' },
  { id: 'c4', num: 4, company: 'Delta', priority: 'Immediate', owner: 'Reem',
    due: '2 Sep 2026', maturity_date: '2026-03-02', ccy: 'USD', invested: 250000,
    status: 'Pending our action', dependency: 'Internal — ISV / Board',
    issue_title: 'A decision.', latest_status: 'Decided, waiting on the Board.',
    next_action: '• Reem: Present it.', closure: 'Close it.', legal_next: 'NO',
    decision: 'Decided to proceed.', decision_next: 'Next: to the Board.',
    updated_at: '2026-09-06T09:00:00Z' },
];

const HISTORY = [
  { entry_date: '2026-09-06', company: 'Alpha', entry: 'Counsel replied.',
    source: 'Counsel opinion', created_at: '2026-09-06T09:00:00Z' },
  { entry_date: '2026-09-06', company: 'Beta', entry: 'Completed: chased them',
    source: 'Action completed', created_at: '2026-09-06T10:00:00Z' },
];

const clone = o => JSON.parse(JSON.stringify(o));
const strip = (cos, f) => cos.map(c => ({ ...c, [f]: '' }));

const CASES = {
  'baseline':                    [COMPANIES, HISTORY],
  /* the one that actually broke: a company left on no desk */
  'one company loses its action':[COMPANIES.map(c =>
                                    c.company === 'Gamma' ? { ...c, next_action: '' } : c), HISTORY],
  'every company loses actions': [strip(COMPANIES, 'next_action'), HISTORY],
  'actions and dependencies go': [strip(strip(COMPANIES, 'next_action'), 'dependency'), HISTORY],
  'no dependencies at all':      [strip(COMPANIES, 'dependency'), HISTORY],
  'no statuses at all':          [strip(COMPANIES, 'status'), HISTORY],
  'no owners at all':            [strip(COMPANIES, 'owner'), HISTORY],
  'no issue titles':             [strip(COMPANIES, 'issue_title'), HISTORY],
  'no latest_status':            [strip(COMPANIES, 'latest_status'), HISTORY],
  'no due dates':                [strip(COMPANIES, 'due'), HISTORY],
  'no history':                  [COMPANIES, []],
  'only tick-box history':       [COMPANIES, HISTORY.map(h => ({ ...h, source: 'Action completed' }))],
  'history for a ghost company': [COMPANIES, [{ entry_date: '2026-09-06', company: 'Ghost',
                                                entry: 'x', source: 'y' }]],
  'history entry is null':       [COMPANIES, [{ entry_date: '2026-09-06', company: 'Alpha',
                                                entry: null, source: null }]],
  'no companies at all':         [[], HISTORY],
  'one company only':            [[COMPANIES[0]], HISTORY],
  'company is a bare name':      [[{ company: 'Solo' }], []],
  'every field null':            [COMPANIES.map(c => Object.fromEntries(
                                    Object.keys(c).map(k => [k, k === 'company' ? c.company : null]))), HISTORY],
  'unknown priority':            [COMPANIES.map(c => ({ ...c, priority: 'Whenever' })), HISTORY],
  'action prefixed Note:':       [COMPANIES.map(c => ({ ...c, next_action: 'Note: not an owner' })), HISTORY],
  'action tagged to a stranger': [COMPANIES.map(c => ({ ...c, next_action: 'Bob: do a thing' })), HISTORY],
  'a very long action':          [COMPANIES.map(c => ({ ...c, next_action: '• Mina: ' + 'x'.repeat(4000) })), HISTORY],
  'decided but no dependency':   [COMPANIES.map(c => ({ ...c, dependency: '' })), HISTORY],
};

/* Shapes are not enough on their own: these three all built fine and were
   still wrong in the brief that went out on 8 September. */
function behaviour() {
  const out = [];
  const check = (name, ok, detail) => { out.push([name, ok, detail]); };

  /* An owner prefix must survive whatever bullet character was typed. */
  const bullets = ['•', '*', '-', '·', ''];
  const routed = bullets.map(b => {
    const cos = [{ ...COMPANIES[1], company: 'Bullet', owner: 'Rafik',
                   next_action: `${b}Reem: do the thing` }];
    const b2 = buildBrief({ companies: cos, history: [], today: TODAY });
    const reem = b2.pdfData.desks.find(d => d.who === 'Reem');
    return reem && reem.mine.length === 1;
  });
  check('owner prefix survives any bullet', routed.every(Boolean),
        bullets.map((b, i) => `${JSON.stringify(b || 'none')}:${routed[i] ? 'ok' : 'LOST'}`).join(' '));

  /* The brief is next actions and who owns them. A company nobody has an action
     on does not belong in it -- not on a desk, not as a chase line, not in an
     Unassigned bucket, whatever else it is tagged with. */
  const quiet = { ...COMPANIES[0], company: 'Quiet', next_action: '' };
  for (const [label, extra] of [['no tags at all',   { dependency: '', status: '' }],
                                ['but has a status', { dependency: '', status: 'Pending legal' }],
                                ['but has a dep',    { dependency: 'Legal Counsel', status: '' }]]) {
    const cos = [{ ...quiet, ...extra }, COMPANIES[1]];
    const b3 = buildBrief({ companies: cos, history: [], today: TODAY });
    const inDesks = b3.pdfData.desks.some(d =>
      d.mine.some(m => m.company === 'Quiet') || d.waiting.some(w => w.company === 'Quiet'));
    check(`actionless company is dropped (${label})`,
          !inDesks && !b3.html.includes('Quiet') && !('orphans' in b3.pdfData),
          inDesks ? 'still on a desk' : (b3.html.includes('Quiet') ? 'still in the HTML' : ''));
  }

  return out;
}

let failed = 0;
for (const [name, [companies, history]] of Object.entries(CASES)) {
  let note = 'ok';
  try {
    const b = buildBrief({ companies: clone(companies), history: clone(history), today: TODAY });
    if (!b.html || !b.subject) throw new Error('built an empty brief');
    briefPdf(b.pdfData);
  } catch (err) {
    note = 'THREW: ' + err.message;
    failed++;
  }
  console.log(`  ${name.padEnd(30)} ${note}`);
}

/* The floor: it runs only when everything else has failed, so it has to cope
   with whatever it is handed. */
console.log('\n  fallbackBrief against bad input');
for (const [label, arg] of [['a real tracker', COMPANIES], ['null', null], ['[]', []],
                            ['[null]', [null]], ['a number', 42], ['{}', {}]]) {
  try {
    const f = fallbackBrief(arg, new Error('something broke'), TODAY);
    if (!f.text || !f.subject) throw new Error('empty fallback');
    console.log(`  ${('  ' + label).padEnd(30)} ok`);
  } catch (err) {
    console.log(`  ${('  ' + label).padEnd(30)} THREW: ${err.message}`);
    failed++;
  }
}

console.log('\n  behaviour, not just "it built"');
for (const [name, ok, detail] of behaviour()) {
  console.log(`  ${('  ' + name).padEnd(40)} ${ok ? 'ok' : 'FAILED'}  ${detail}`);
  if (!ok) failed++;
}

console.log(failed ? `\n${failed} FAILED` : '\nall shapes build, all behaviour holds');
process.exit(failed ? 1 : 0);
