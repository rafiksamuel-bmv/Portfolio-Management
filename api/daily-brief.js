import { Doc } from '../lib/pdf.js';

/* Daily portfolio brief.
 *
 * Runs on a Vercel cron (see vercel.json), reads the tracker straight from
 * Supabase and emails the brief. Deliberately dependency-free: Supabase and
 * Resend are both plain REST, so this needs nothing installed.
 *
 * GET /api/daily-brief?preview=1   renders the HTML without sending.
 * GET /api/daily-brief?pdf=1       returns the PDF without sending.
 *
 * Environment (set in Vercel, never in the repo):
 *   SUPABASE_URL                the project URL
 *   SUPABASE_SERVICE_ROLE_KEY   needed because RLS grants only "authenticated"
 *   RESEND_API_KEY              sending key
 *   BRIEF_TO                    recipient (defaults below)
 *   BRIEF_FROM                  verified sender
 *   SUPABASE_ANON_KEY           optional; lets a signed-in person send from the app
 *   CRON_SECRET                 set by Vercel; also accepted as ?key= for previews
 */

const DEFAULT_TO = 'rafiksamuel@aucegypt.edu';

/* Desks come from `owner`, not from `status`. The two answer different
   questions: status is who holds the ball (us, counsel, or the company), owner
   is which of us has to move it. They are independent -- an item Reem has
   asked Mina to send to Shawarby is "Pending our action" sitting on Mina's
   desk, which a status-derived desk could not express. */
/* A desk is built from two things.
     Your move  -- the next-action lines tagged to that person, whatever the
                   company's status. An untagged line falls to the company's
                   owner, so nothing goes unassigned.
     Chasing    -- the channel each person runs: anything Pending company is
                   Rafik's to chase, anything Pending legal is Mina's. Listed
                   only when that company has no action tagged to them already.
   So one company can sit on two desks with different work, which is the whole
   point: Mina approves Flend's extension notice while Reem and Rafik decide
   the follow-on. */
const DESKS = [
  { who: 'Mina',  role: 'counsel liaison', chases: 'Pending legal',
    lead: 'Work tagged to Mina, and everything sitting with El-Shawarby.' },
  { who: 'Rafik', role: 'company outreach', chases: 'Pending company',
    lead: 'Work tagged to Rafik, and everything sitting with the companies.' },
  { who: 'Reem',  role: 'decisions & Mr. Mohamed', chases: null,
    lead: 'Calls to make, and anything that needs Mr. Mohamed.' },
];

/* A short human opening, so the brief starts like a note from a colleague
   rather than a report header. Varies by weekday so it does not read canned. */
function greeting(now) {
  const day = now.getUTCDay();
  if (day === 0) return 'Good morning. Start of the week — here is where the portfolio stands, '
    + 'and what each of us is holding.';
  if (day === 4) return 'Good morning. End of the week — here is where the portfolio stands, '
    + 'and what is worth closing out before the weekend.';
  return 'Good morning. Here is where the portfolio stands this morning, '
    + 'and what each of us is holding today.';
}

/* ---------- dates ---------- */
const MS_DAY = 86400000;
function ymd(d) { return d.toISOString().slice(0, 10); }
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function daysFrom(today, s) {
  const d = parseDate(s);
  return d ? Math.round((d - today) / MS_DAY) : null;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dmy(s) {
  const d = parseDate(s);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—';
}
function longDate(d) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ---------- tracker rules, mirroring the app ---------- */
function effMaturity(c) { return c.extended_to || c.maturity_date; }
function overdueDays(today, c) {
  const d = daysFrom(today, effMaturity(c));
  return d === null || d >= 0 ? null : Math.abs(d);
}
function overdueLabel(today, c) {
  const days = overdueDays(today, c);
  if (days === null) return null;
  const months = Math.floor(days / 30.44);
  const age = months >= 1 ? `${months} month${months === 1 ? '' : 's'} past maturity`
                          : `${days} days past maturity`;
  return c.extended_to ? `${age} (extended to ${dmy(c.extended_to)})`
                       : `${age}, no signed extension`;
}
const DONE_SRC = 'Action completed';
function historyFor(history, c, withDone) {
  return history
    .filter(h => h.company === c.company && (withDone || h.source !== DONE_SRC))
    .slice().sort((a, b) =>
      String(b.entry_date).localeCompare(String(a.entry_date)) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
}
/* Where it stands is the position, not the last task ticked off, so entries
   logged by the tick box are shown separately rather than as the situation. */
function latestEntry(history, c) { return historyFor(history, c)[0] || null; }
function doneRecent(history, c, n) {
  return history
    .filter(h => h.company === c.company && h.source === DONE_SRC)
    .slice().sort((a, b) =>
      String(b.entry_date).localeCompare(String(a.entry_date)) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    ).slice(0, n || 3);
}

/* next_action and closure are written as "• " bullet lines. */
function toLines(text) {
  return String(text || '').split('\n')
    .map(l => l.replace(/^[•\-]\s*/, '').trim()).filter(Boolean);
}

const PEOPLE = ['Mina', 'Rafik', 'Reem'];
/* An action line may name who owns it: "Mina: draft the notice", or
   "Reem, Rafik: decide the follow-on". Only a prefix made entirely of known
   names counts, so ordinary text like "Note: ..." or "Confirm dilution: ..."
   is left alone rather than being eaten as an owner. */
function parseAction(line) {
  const m = /^([^:]{1,60}):\s*(.+)$/.exec(String(line).trim());
  if (m) {
    const raw = m[1].split(/,|&|\band\b/).map(x => x.trim()).filter(Boolean);
    const named = raw.map(x => PEOPLE.find(p => p.toLowerCase() === x.toLowerCase()))
                     .filter(Boolean);
    if (named.length && named.length === raw.length) {
      return { owners: named, text: m[2].trim() };
    }
  }
  return { owners: [], text: String(line).trim() };
}
/* Who has to do this line: its own tag, else the company's owner. */
function actionOwners(line, company) {
  const a = parseAction(line);
  return a.owners.length ? a.owners : [(company.owner || '').trim()].filter(Boolean);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
/* Situation and action text is written as "• " bullet lines. */
function bullets(text, color) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return `<span style="color:${color};">—</span>`;
  return lines.map(l =>
    `<div style="margin:0 0 4px;">${esc(l.replace(/^[•\-•]\s*/, '• '))}</div>`
  ).join('');
}
function money(v) {
  const n = Number(v);
  if (!v || isNaN(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'm';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/* ---------- palette ----------
   The brief is dark in every client, not "dark if the reader is". Values are
   the app's own dark theme, written as literals: an email cannot carry a media
   query reliably, so the only way to hold one look everywhere is to state it. */
const C = {
  maroon: '#8E2B39', deep: '#5E1621', bright: '#D97A82', gold: '#D9B441',
  page: '#100C0D', card: '#1A1416', line: '#33292B', soft: '#241D1F',
  ink: '#EDE5E6', mid: '#B0A2A4', faint: '#867779',
  crit: '#E88C92', critBg: '#3A1D20', warn: '#D9AE55', warnBg: '#382D14',
  calm: '#93A6C8', calmBg: '#1F2739', ok: '#5FBE92', okBg: '#14301F',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,monospace";

function statusTone(s) {
  if (s === 'Pending our action') return [C.warn, C.warnBg];
  if (s === 'Pending legal')      return [C.calm, C.calmBg];
  if (s === 'On track')           return [C.ok,   C.okBg];
  return [C.mid, C.soft];
}
function pill(text, fg, bg) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;`
       + `background:${bg};color:${fg};font-size:11px;font-weight:700;`
       + `white-space:nowrap;">${esc(text)}</span>`;
}

/* ---------- per-company timeline ----------
   Horizontal: each milestone is a column, its top border forming the track.
   Segmented borders rather than one absolute-positioned line, because email
   clients do not honour negative margins or absolute positioning. */
function timeline(c, history, now) {
  const past = historyFor(history, c).slice(0, 3).reverse();   // oldest first
  const [fg, bg] = statusTone(c.status);
  const od = overdueLabel(now, c);
  const dueIn = daysFrom(now, c.due);
  const actions = toLines(c.next_action);
  const closure = toLines(c.closure);
  const hot = dueIn !== null && dueIn <= 7;

  const nodes = past.map(h => ({
    label: dmy(h.entry_date),
    sub: h.source || '',
    body: String(h.entry).split('\n')[0].replace(/^[•\-]\s*/, ''),
    color: C.faint, track: C.line, strong: false,
  }));

  nodes.push({
    label: 'NEXT',
    sub: c.due ? (hot ? `${c.due} · ${dueIn < 0 ? Math.abs(dueIn) + 'd late' : dueIn === 0 ? 'today' : 'in ' + dueIn + 'd'}`
                      : c.due) : 'no date set',
    body: actions.length ? actions[0] : 'No next action recorded.',
    extra: actions.length > 1 ? `+${actions.length - 1} more` : '',
    color: hot ? C.crit : C.warn, track: hot ? C.crit : C.gold, strong: true,
  });

  nodes.push({
    label: 'CLOSE',
    sub: 'what done looks like',
    body: closure.length ? closure.join(' ') : 'Not defined yet.',
    color: closure.length ? C.ok : C.faint,
    track: closure.length ? C.ok : C.line,
    strong: true, muted: !closure.length,
  });

  const w = Math.floor(100 / nodes.length);
  const cells = nodes.map((n, i) => `
    <td width="${w}%" valign="top" style="padding:0 ${i === nodes.length - 1 ? 0 : 8}px 0 0;">
      <div style="font-size:10px;font-family:${MONO};font-weight:${n.strong ? '700' : '400'};
                  color:${n.color};letter-spacing:.04em;white-space:nowrap;
                  overflow:hidden;text-overflow:ellipsis;">${esc(n.label)}</div>
      <div style="font-size:9.5px;font-family:${MONO};color:${C.faint};margin:1px 0 6px;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(n.sub)}</div>
      <div style="border-top:3px solid ${n.track};padding-top:8px;">
        <div style="font-size:11.5px;line-height:1.45;
                    color:${n.muted ? C.faint : (n.strong ? C.ink : C.mid)};
                    font-weight:${n.strong && !n.muted ? '600' : '400'};">${esc(n.body).slice(0, 260)}</div>
        ${n.extra ? `<div style="font-size:10px;color:${C.faint};margin-top:3px;">${esc(n.extra)}</div>` : ''}
      </div>
    </td>`).join('');

  return `<tr><td style="padding:0 28px 14px;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid ${C.line};border-radius:10px;">
      <tr><td style="padding:13px 16px 11px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:15px;font-weight:700;color:${C.ink};">${esc(c.company)}
            <span style="font-size:11px;font-weight:400;color:${C.faint};">
              · ${esc(c.bucket || '')}${c.owner ? ' · ' + esc(c.owner) : ''}</span></td>
          <td align="right">${pill(c.status || '—', fg, bg)}</td>
        </tr></table>
        <div style="font-size:10.5px;font-family:${MONO};color:${C.faint};margin-top:4px;">
          ${esc(c.next_trigger || 'no trigger set')} ·
          ${effMaturity(c) ? 'matures ' + esc(dmy(effMaturity(c))) : 'no maturity'}
          ${od ? ` · <span style="color:${C.crit};font-weight:700;">${esc(od)}</span>` : ''}
        </div>
      </td></tr>
      <tr><td style="padding:2px 16px 15px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
      </td></tr>
    </table></td></tr>`;
}

/* ============================ the brief ============================ */
export function buildBrief({ companies, history, today }) {
  const now = today || new Date();
  const todayStr = ymd(now);
  /* A 24-hour window goes blank whenever yesterday was quiet, which is exactly
     when you still want to see where things stand. Look back three days, and
     fall back to the most recent entries rather than showing nothing. */
  const LOOKBACK_DAYS = 3;
  const since = ymd(new Date(now - LOOKBACK_DAYS * MS_DAY));

  const byNum = companies.slice().sort((a, b) => (a.num || 0) - (b.num || 0));
  /* Newest edit across the tracker, which is what the header now carries
     instead of the separately-maintained asOf setting. */
  const lastEdited = (() => {
    const stamps = companies.map(c => c.updated_at || c.last_updated).filter(Boolean).sort();
    return stamps.length ? dmy(String(stamps[stamps.length - 1]).slice(0, 10)) : '';
  })();
  const overdue = byNum.filter(c => overdueDays(now, c) !== null)
                       .sort((a, b) => overdueDays(now, b) - overdueDays(now, a));
  const immediate = byNum.filter(c => c.priority === 'Immediate');
  const sortByDate = (a, b) =>
    String(b.entry_date).localeCompare(String(a.entry_date)) ||
    String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const recent = history.filter(h => h.entry_date >= since).sort(sortByDate);
  const usingFallback = recent.length === 0;
  const moved = usingFallback ? history.slice().sort(sortByDate).slice(0, 5) : recent;

  /* ---- top line: state the position, do not editorialise ---- */
  const counts = {};
  ['Pending legal', 'Pending company', 'Pending our action'].forEach(k => {
    counts[k] = byNum.filter(c => c.status === k).length; });
  const topline =
    `${counts['Pending legal']} with counsel, ${counts['Pending company']} with the companies, `
  + `${counts['Pending our action']} ours to decide. `
  + `${overdue.length} of ${byNum.length} notes are past maturity`
  + `${overdue.filter(c => !c.extended_to).length ? `, ${overdue.filter(c => !c.extended_to).length} with no signed extension` : ''}.`;

  const stats = [
    ['Companies', String(byNum.length), C.ink],
    ['Past maturity', String(overdue.length), overdue.length ? C.crit : C.ok],
    ['With counsel', String(counts['Pending legal']), C.calm],
    ['With companies', String(counts['Pending company']), C.mid],
    ['Immediate', String(immediate.length), immediate.length ? C.crit : C.ok],
  ];

  const section = (title, sub) =>
    `<tr><td style="padding:26px 28px 8px;">
       <div style="font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
                   color:${C.bright};">${esc(title)}</div>
       ${sub ? `<div style="font-size:12.5px;color:${C.faint};margin-top:3px;">${esc(sub)}</div>` : ''}
     </td></tr>`;

  /* ---- desks ----
     The centre of the brief. One block per person, and for each company on
     their plate: where it stands, what they do about it, and what closing it
     looks like. Everything a person needs is in their own block, so nobody
     has to cross-reference another section to know their morning. */
  const label = (text, right) =>
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin:11px 0 3px;"><tr>
       <td style="font-size:9.5px;font-family:${MONO};font-weight:700;letter-spacing:.09em;
                  color:${C.faint};">${esc(text)}</td>
       ${right ? `<td align="right" style="font-size:10px;font-family:${MONO};
                  color:${C.faint};">${right}</td>` : ''}
     </tr></table>`;

  function deskItem(c, onlyActions) {
    const od = overdueLabel(now, c);
    const due = daysFrom(now, c.due);
    const hot = due !== null && due <= 7;
    const last = latestEntry(history, c);
    const actions = onlyActions || toLines(c.next_action).map(l => parseAction(l).text);
    const closure = toLines(c.closure);
    const [fg, bg] = statusTone(c.status);

    const dueRight = c.due
      ? `due ${esc(c.due)}${hot ? ` · <b style="color:${C.crit};">${
          due < 0 ? Math.abs(due) + ' days late' : due === 0 ? 'today' : due + ' days'}</b>` : ''}`
      : 'no date set';

    return `<tr><td style="padding:15px 0 17px;border-top:1px solid ${C.line};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:700;color:${C.ink};">${esc(c.company)}</td>
        <td align="right">${pill(c.status || '—', fg, bg)}</td>
      </tr></table>
      <div style="font-size:10.5px;font-family:${MONO};color:${C.faint};margin-top:4px;">
        ${effMaturity(c) ? 'matures ' + esc(dmy(effMaturity(c))) : 'no maturity'}
        ${od ? ` · <span style="color:${C.crit};font-weight:700;">${esc(od)}</span>` : ''}
      </div>

      ${label('WHERE IT STANDS', last
          ? `${esc(dmy(last.entry_date))}${last.source ? ' · ' + esc(last.source) : ''}` : '')}
      <div style="font-size:13px;line-height:1.55;color:${C.mid};">${
        last ? esc(String(last.entry).split('\n')[0].replace(/^[•\-]\s*/, ''))
             : `<span style="color:${C.faint};">Nothing logged yet.</span>`}</div>

      ${(() => {
        const done = doneRecent(history, c);
        return done.length
          ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:7px;">${
              done.map(h => `<tr>
                <td width="14" valign="top" style="font-size:12px;color:${C.ok};
                    font-weight:700;padding:1px 0 0;">&#10003;</td>
                <td style="font-size:12px;line-height:1.5;color:${C.faint};padding-bottom:3px;">${
                  esc(String(h.entry).replace(/^Completed:\s*/, ''))}
                  <span style="font-family:${MONO};font-size:10px;"> · ${esc(dmy(h.entry_date))}</span>
                </td></tr>`).join('')}</table>`
          : '';
      })()}

      ${c.legal_req && c.status === 'Pending legal'
        ? label('THE ASK') + `<div style="font-size:12.5px;line-height:1.5;color:${C.mid};">${
            esc(c.legal_req)}</div>` : ''}

      ${label('WHAT TO DO', dueRight)}
      ${actions.length
        ? `<table width="100%" cellpadding="0" cellspacing="0">${actions.map(a =>
            `<tr><td width="14" valign="top" style="font-size:13px;color:${C.gold};
                     font-weight:700;padding:1px 0 0;">&#9656;</td>
                 <td style="font-size:13px;line-height:1.55;color:${C.ink};
                     font-weight:600;padding-bottom:4px;">${esc(a)}</td></tr>`).join('')}
           </table>`
        : `<div style="font-size:13px;color:${C.faint};">No next action recorded.</div>`}

      ${closure.length
        ? label('CLOSING THIS') + `<div style="font-size:12px;line-height:1.5;color:${C.faint};">${
            esc(closure.join(' '))}</div>`
        : ''}
    </td></tr>`;
  }

  /* One place that decides what lands on a desk, so the email and the PDF
     cannot drift apart. */
  function deskRows(desk) {
    const mine = [];
    byNum.forEach(c => {
      const acts = toLines(c.next_action)
        .map(l => ({ text: parseAction(l).text, owners: actionOwners(l, c) }))
        .filter(a => a.owners.indexOf(desk.who) > -1);
      if (acts.length) mine.push({ c, acts: acts.map(a => a.text) });
    });
    const has = {}; mine.forEach(m => { has[m.c.company] = 1; });
    const chasing = desk.chases
      ? byNum.filter(c => c.status === desk.chases && !has[c.company])
      : [];
    return { mine, chasing };
  }

  /* Parked with counsel or the company: on this person's desk, but not their
     move today. Kept short so it cannot be confused with work to do. */
  function waitingRow(c) {
    const last = latestEntry(history, c);
    const [fg, bg] = statusTone(c.status);
    return `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:13px;font-weight:700;color:${C.mid};">${esc(c.company)}</td>
        <td align="right">${pill(c.status || '—', fg, bg)}</td>
      </tr></table>
      <div style="font-size:12px;color:${C.faint};margin-top:3px;line-height:1.5;">${
        last ? esc(String(last.entry).split('\n')[0].replace(/^[•\-]\s*/, '')).slice(0, 150)
             : 'Nothing logged yet.'}</div>
    </td></tr>`;
  }

  function deskBlock(desk) {
    const { mine, chasing } = deskRows(desk);
    const rows = mine.map(m => m.c).concat(chasing);
    const head = `
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:17px;font-weight:700;color:${C.ink};letter-spacing:-.01em;">
          ${esc(desk.who)}
          <span style="font-weight:400;color:${C.faint};font-size:12.5px;">
            · ${esc(desk.role)}</span></td>
        <td align="right">${(() => {
          const act = mine.length;
          return act ? pill(act + ' to act', C.crit, C.critBg)
                     : pill(chasing.length ? 'chasing only' : 'clear', C.ok, C.okBg);
        })()}</td>
      </tr></table>
      <div style="font-size:12px;color:${C.faint};margin-top:4px;">${esc(desk.lead)}</div>`;


    const subhead = (text, colour) =>
      `<tr><td style="padding:13px 0 2px;">
         <div style="font-size:9.5px;font-family:${MONO};font-weight:700;letter-spacing:.09em;
                     color:${colour};">${esc(text)}</div></td></tr>`;

    return `<tr><td style="padding:0 28px 16px;">
      <div style="border:1px solid ${C.line};border-radius:10px;overflow:hidden;">
        <div style="background:${C.soft};padding:14px 18px;border-bottom:1px solid ${C.line};">
          ${head}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 18px 6px;">
          ${mine.length
            ? subhead(`YOUR MOVE · ${mine.length}`, C.bright)
              + mine.map(m => deskItem(m.c, m.acts)).join('')
            : subhead('YOUR MOVE · NONE', C.faint)
              + `<tr><td style="padding:8px 0 2px;font-size:12.5px;color:${C.faint};">
                   Nothing is waiting on ${esc(desk.who)} right now.</td></tr>`}
          ${chasing.length
            ? subhead(`${desk.who === 'Mina' ? 'WITH COUNSEL' : 'WITH THE COMPANIES'}`
                      + ` · ${chasing.length}`, C.faint)
              + chasing.map(waitingRow).join('')
            : ''}
        </table>
      </div></td></tr>`;
  }

  /* Nothing should fall off the brief because its owner is blank or is
     somebody other than the three desks. */
  function orphanBlock() {
    const seen = {};
    DESKS.forEach(d => {
      const r = deskRows(d);
      r.mine.forEach(m => { seen[m.c.company] = 1; });
      r.chasing.forEach(c => { seen[c.company] = 1; });
    });
    const rows = byNum.filter(c => !seen[c.company]);
    if (!rows.length) return '';
    return `<tr><td style="padding:0 28px 16px;">
      <div style="border:1px solid ${C.line};border-radius:10px;overflow:hidden;">
        <div style="background:${C.soft};padding:14px 18px;border-bottom:1px solid ${C.line};">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:17px;font-weight:700;color:${C.ink};">Unassigned</td>
            <td align="right">${pill(rows.length + (rows.length === 1 ? ' item' : ' items'),
                                     C.warn, C.warnBg)}</td>
          </tr></table>
          <div style="font-size:12px;color:${C.faint};margin-top:4px;">
            These reached no desk: no action is tagged to anyone and the status
            does not put them with counsel or a company.</div>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0"
               style="padding:0 18px 6px;">${rows.map(deskItem).join('')}</table>
      </div></td></tr>`;
  }

  /* ---- what moved ---- */
  const movedBlock = moved.map(h => `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:12.5px;font-weight:700;color:${C.ink};">${esc(h.company || 'General')}</td>
          <td align="right" style="font-size:11px;color:${C.faint};font-family:${MONO};">
            ${esc(dmy(h.entry_date))}${h.source ? ' · ' + esc(h.source) : ''}</td>
        </tr></table>
        <div style="font-size:12.5px;color:${C.mid};margin-top:3px;">${bullets(h.entry, C.faint)}</div>
      </td></tr>`).join('');

  /* ---- clocks ---- */
  const dueSoon = byNum
    .map(c => ({ c, d: daysFrom(now, c.due) }))
    .filter(x => x.d !== null && x.d <= 7)
    .sort((a, b) => a.d - b.d);
  const clockRows = [
    ...overdue.map(c => [c.company, overdueLabel(now, c), true]),
    ...dueSoon.map(x => [x.c.company,
      `review ${x.d < 0 ? Math.abs(x.d) + ' days overdue' : x.d === 0 ? 'due today' : 'due in ' + x.d + ' days'} (${x.c.due})`,
      x.d <= 0]),
  ];
  const clocks = clockRows.length
    ? clockRows.map(([co, txt, hot]) => `<tr>
        <td style="padding:7px 0;border-top:1px solid ${C.line};font-size:12.5px;
                   font-weight:700;color:${C.ink};width:130px;">${esc(co)}</td>
        <td style="padding:7px 0;border-top:1px solid ${C.line};font-size:12.5px;
                   color:${hot ? C.crit : C.mid};">${esc(txt)}</td></tr>`).join('')
    : `<tr><td style="padding:8px 0;font-size:12.5px;color:${C.faint};">Nothing overdue or due this week.</td></tr>`;

  const html =
`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>BMV Portfolio Brief</title>
<style>
  :root { color-scheme: dark; supported-color-schemes: dark; }
  /* Outlook and Gmail invert colours in their own dark modes. These stop the
     ground being flipped back to white under the light text. */
  [data-ogsc] .ground, [data-ogsb] .ground { background: ${C.page} !important; }
  [data-ogsc] .panel,  [data-ogsb] .panel  { background: ${C.card} !important; }
  [data-ogsc] .ink,    [data-ogsc] .ink *  { color: ${C.ink} !important; }
  @media (prefers-color-scheme: light) {
    .ground { background: ${C.page} !important; }
    .panel  { background: ${C.card} !important; }
  }
</style></head>
<body class="ground" bgcolor="${C.page}"
      style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.ink};">
<table width="100%" cellpadding="0" cellspacing="0" class="ground" bgcolor="${C.page}"
       style="background:${C.page};padding:22px 12px;">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" class="panel ink" bgcolor="${C.card}"
       style="max-width:680px;background:${C.card};border-radius:12px;overflow:hidden;
              border:1px solid ${C.line};">

  <tr><td bgcolor="${C.deep}" style="background:${C.deep};padding:26px 28px 24px;
             border-bottom:2px solid ${C.maroon};">
    <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;
                color:${C.gold};">BM Ventures &middot; Strategic Ventures</div>
    <div style="font-size:26px;font-weight:700;color:#fff;margin-top:7px;
                letter-spacing:-.01em;">Portfolio Brief</div>
    <div style="font-size:13.5px;color:#fff;opacity:.9;margin-top:6px;font-weight:600;">
      ${esc(longDate(now))}</div>
    <div style="font-size:11.5px;font-family:${MONO};color:${C.gold};opacity:.85;margin-top:9px;">
      Prepared by Rafik for internal review${lastEdited ? ` &middot; tracker last edited ${esc(lastEdited)}` : ''}</div>
  </td></tr>

  <tr><td style="padding:24px 28px 6px;">
    <div style="font-size:14px;line-height:1.65;color:${C.mid};">${esc(greeting(now))}</div>
    <div style="font-size:16px;line-height:1.6;color:${C.ink};font-weight:600;
                margin-top:10px;">${esc(topline)}</div>
  </td></tr>

  <tr><td style="padding:16px 28px 4px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${stats.map(([label, val, col]) => `<td align="center" style="padding:10px 4px;background:${C.soft};
          border:1px solid ${C.line};border-radius:8px;">
        <div style="font-size:20px;font-weight:700;color:${col};font-family:${MONO};">${esc(val)}</div>
        <div style="font-size:10px;color:${C.faint};text-transform:uppercase;letter-spacing:.06em;
                    margin-top:2px;">${esc(label)}</div></td>
        <td width="6"></td>`).join('').replace(/<td width="6"><\/td>$/, '')}
    </tr></table>
  </td></tr>

  ${section(usingFallback ? 'Most recent activity' : 'Moved in the last three days',
      usingFallback
        ? 'Nothing logged in the last three days, so here are the latest entries on file'
        : `${moved.length} entr${moved.length === 1 ? 'y' : 'ies'} logged`)}
  <tr><td style="padding:0 28px;"><table width="100%" cellpadding="0" cellspacing="0">${movedBlock}</table></td></tr>

  ${section('Your morning', 'What each person is holding, where it stands, and what to do about it')}
  ${DESKS.map(deskBlock).join('')}${orphanBlock()}

  ${section('Clocks', 'Past maturity, and reviews due inside seven days')}
  <tr><td style="padding:0 28px;"><table width="100%" cellpadding="0" cellspacing="0">${clocks}</table></td></tr>

  ${section('Every company', 'What happened, what is due next, and what closing the position looks like')}
  ${byNum.map(c => timeline(c, history, now)).join('')}

  <tr><td style="padding:18px 28px 24px;border-top:1px solid ${C.line};">
    <div style="font-size:11.5px;color:${C.faint};line-height:1.6;">
      Generated from the tracker. Latest Situation is the newest History entry for each company,
      and past maturity is computed from the extension date where one was countersigned,
      otherwise the original maturity.
    </div>
  </td></tr>

</table>
<div style="font-size:11px;color:${C.faint};margin-top:12px;">BM Ventures · Innovation &amp; Strategic Ventures Sector</div>
</td></tr></table></body></html>`;

  const subject = `Portfolio Brief — ${dmy(todayStr)} · `
    + `${counts['Pending legal']} legal · ${counts['Pending company']} company · `
    + `${counts['Pending our action']} ours`
    + (overdue.length ? ` · ${overdue.length} past maturity` : '');

  /* The same content the HTML shows, as plain data, so the PDF is laid out
     from the brief rather than converted from its markup. */
  const forCompany = c => {
    const last = latestEntry(history, c);
    const due = daysFrom(now, c.due);
    const od = overdueLabel(now, c);
    return {
      company: c.company, status: c.status,
      meta: `${effMaturity(c) ? 'matures ' + dmy(effMaturity(c)) : 'no maturity'}`
            + `${od ? '  -  ' + od : ''}`,
      overdue: !!od,
      stands: last ? String(last.entry).split('\n')[0].replace(/^[•\-]\s*/, '') : '',
      standsWhen: last ? dmy(last.entry_date) + (last.source ? '  -  ' + last.source : '') : '',
      ask: (c.legal_req && c.status === 'Pending legal') ? c.legal_req : '',
      due: c.due ? 'due ' + c.due + (due !== null && due <= 7
            ? '  -  ' + (due < 0 ? Math.abs(due) + ' days late' : due === 0 ? 'today' : due + ' days')
            : '') : 'no date set',
      dueHot: due !== null && due <= 7,
      actions: toLines(c.next_action),
      done: doneRecent(history, c).map(h =>
        String(h.entry).replace(/^Completed:\s*/, '') + '  (' + dmy(h.entry_date) + ')'),
      closure: toLines(c.closure).join(' '),
    };
  };
  const pdfDesks = DESKS.map(desk => {
    const { mine, chasing } = deskRows(desk);
    return {
      who: desk.who, role: desk.role,
      chaseLabel: desk.who === 'Mina' ? 'With counsel'
                : desk.who === 'Rafik' ? 'With the companies' : 'Waiting',
      mine:    mine.map(m => ({ ...forCompany(m.c), actions: m.acts })),
      waiting: chasing.map(forCompany),
    };
  });
  /* Anything that reached no desk at all still has to be visible. */
  const onADesk = {};
  DESKS.forEach(d => {
    const { mine, chasing } = deskRows(d);
    mine.forEach(m => { onADesk[m.c.company] = 1; });
    chasing.forEach(c => { onADesk[c.company] = 1; });
  });
  const orphanRows = byNum.filter(c => !onADesk[c.company]);
  /* An executive summary earns its space only if it says what the reader would
     otherwise have to assemble: the exposure, what is late, and who owes what.
     All three fall out of data already gathered above. */
  const noExt = overdue.filter(c => !c.extended_to);
  const lateOrDue = byNum
    .map(c => ({ c, d: daysFrom(now, c.due) }))
    .filter(x => x.d !== null && x.d <= 7)
    .sort((a, b) => a.d - b.d);
  const exposure = ccy => byNum
    .filter(c => c.ccy === ccy && overdueDays(now, c) !== null && !c.extended_to)
    .reduce((n, c) => n + (Number(c.invested) || 0), 0);
  const summary = [
    ['Position', topline],
    ['Past maturity', noExt.length
      ? `${noExt.length} of ${byNum.length} notes sit past maturity with no signed extension`
        + `${exposure('USD') ? `, USD ${money(exposure('USD'))} of principal` : ''}`
        + `${exposure('EGP') ? ` and EGP ${money(exposure('EGP'))}` : ''}`
        + `. ${noExt.slice(0, 5).map(c => c.company).join(', ')}`
        + `${noExt.length > 5 ? ' and others' : ''}.`
      : 'Every note is either within term or covered by a signed extension.'],
    ['Due inside a week', lateOrDue.length
      ? lateOrDue.slice(0, 5).map(x => `${x.c.company} (${x.d < 0 ? Math.abs(x.d) + 'd late'
          : x.d === 0 ? 'today' : x.d + 'd'})`).join(', ') + '.'
      : 'Nothing falls due in the next seven days.'],
    ['Desks', DESKS.map(dk => {
        const { mine, chasing } = deskRows(dk);
        return `${dk.who} ${mine.length ? mine.length + ' to act'
                : chasing.length ? 'chasing only' : 'clear'}`;
      }).join(', ') + '.'],
  ];

  const pdfData = {
    now, lastEdited, topline, greeting: greeting(now), stats, summary,
    desks: pdfDesks,
    orphans: orphanRows.length
      ? { who: 'Unassigned', role: 'on nobody\'s desk', chaseLabel: 'Unassigned',
          mine: [], waiting: orphanRows.map(forCompany) }
      : null,
    moved: moved.map(h => ({
      company: h.company || 'General',
      when: dmy(h.entry_date) + (h.source ? '  -  ' + h.source : ''),
      entry: String(h.entry).replace(/^[•\-]\s*/, ''),
    })),
  };

  return { html, subject, topline, counts, pdfData,
           overdue: overdue.length, moved: moved.length };
}

/* ---------- data ---------- */
async function fetchTable(url, key, table, query) {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function loadTracker(url, key) {
  const [companies, history, settings] = await Promise.all([
    fetchTable(url, key, 'companies', 'select=*&order=num'),
    fetchTable(url, key, 'history', 'select=*&order=entry_date.desc&limit=400'),
    fetchTable(url, key, 'settings', 'select=*'),
  ]);
  return { companies, history };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY, BRIEF_TO, BRIEF_FROM, CRON_SECRET,
  } = process.env;

  const url = new URL(req.url, 'http://localhost');
  const preview = url.searchParams.get('preview') === '1';

  // Vercel cron sends the secret as a bearer token; previews may pass ?key=.
  /* Three ways in: the cron's bearer secret, ?key= for a browser preview, or a
     signed-in person's Supabase session, which is how the Send button in the
     app works. The app is a public static page and cannot hold CRON_SECRET, so
     it presents the session token it already has and the token is verified
     against Supabase here. */
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    const bearer = auth.replace(/^Bearer\s+/i, '');
    const supplied = bearer || url.searchParams.get('key') || '';
    let ok = supplied === CRON_SECRET;
    if (!ok && bearer) ok = await isSignedIn(bearer, SUPABASE_URL,
                                             process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY);
    if (!ok) return res.status(401).send('Unauthorized');
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  const now0 = new Date();
  let brief;
  try {
    const data = await loadTracker(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    brief = buildBrief({ ...data, today: now0 });
  } catch (err) {
    return res.status(502).send(`Could not build the brief: ${err.message}`);
  }

  if (url.searchParams.get('pdf') === '1') {
    const buf = briefPdf(brief.pdfData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="portfolio-brief-${ymd(now0)}.pdf"`);
    return res.status(200).send(buf);
  }
  if (preview) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(brief.html);
  }

  if (!RESEND_API_KEY) return res.status(500).send('RESEND_API_KEY is not set.');

  /* The PDF is built here, so it needs no key and cannot fail because an
     external service is down. If it throws anyway, the email still goes. */
  let attachments;
  let pdfNote = 'attached';
  try {
    const bytes = briefPdf(brief.pdfData);
    attachments = [{
      filename: `portfolio-brief-${ymd(new Date())}.pdf`,
      content: bytes.toString('base64'),
      content_type: 'application/pdf',
    }];
    pdfNote = `attached (${bytes.length} bytes)`;
  } catch (err) {
    attachments = undefined;
    pdfNote = `failed: ${err.message}`;
  }

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: BRIEF_FROM || 'BMV Portfolio <onboarding@resend.dev>',
      to: [BRIEF_TO || DEFAULT_TO],
      subject: brief.subject,
      html: brief.html,
      ...(attachments ? { attachments } : {}),
    }),
  });
  if (!send.ok) return res.status(502).send(`Resend ${send.status}: ${await send.text()}`);

  return res.status(200).json({
    sent: true, to: BRIEF_TO || DEFAULT_TO, subject: brief.subject, pdf: pdfNote,
    counts: brief.counts, overdue: brief.overdue, moved: brief.moved,
  });
}

/* Is this a real, current Supabase session? Asking Supabase rather than
   decoding the JWT here, so an expired or revoked token is refused. */
async function isSignedIn(token, supabaseUrl, apikey) {
  if (!supabaseUrl || !apikey) return false;
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch { return false; }
}

/* The brief as a PDF, laid out rather than converted.
   Written here for the same reason the Excel export is: it needs no service,
   no key and no dependency, and the daily job cannot fail because somebody
   else's API is down. It carries the same content in the same order as the
   email, in the same dark identity. */
export function briefPdf({ now, lastEdited, topline, greeting, stats, summary,
                           desks, moved, orphans }) {
  const P = {
    page: '#100C0D', card: '#1A1416', line: '#33292B', soft: '#241D1F',
    ink: '#EDE5E6', mid: '#B0A2A4', faint: '#867779',
    maroon: '#8E2B39', deep: '#5E1621', gold: '#D9B441',
    crit: '#E88C92', critBg: '#3A1D20', warn: '#D9AE55', warnBg: '#382D14',
    calm: '#93A6C8', calmBg: '#1F2739', ok: '#5FBE92', okBg: '#14301F',
  };
  const tone = st => st === 'Pending our action' ? [P.warn, P.warnBg]
                  : st === 'Pending legal'      ? [P.calm, P.calmBg]
                  : st === 'On track'           ? [P.ok,   P.okBg]
                  : [P.mid, P.soft];

  const d = new Doc({ margin: 44, background: P.page });
  const R = d.margin + d.innerWidth;
  let started = false;

  /* Every section opens the same way, on its own page: a rule, its name, and a
     line or two saying what it is for, so the document explains itself to
     someone reading it for the first time. */
  const section = (title, blurb, opts = {}) => {
    if (started && opts.newPage !== false) d.newPage();
    started = true;
    d.rect(d.margin, d.y, d.innerWidth, 2, P.maroon);
    d.y += 12;
    d.textAt(title.toUpperCase(), d.margin, d.y, { size: 10, bold: true, colour: P.gold });
    d.y += 15;
    d.para(blurb, { size: 8.5, colour: P.faint, after: 12 });
  };

  /* --------------------------------------------------------- page 1 ---- */
  d.rect(0, 0, d.w, 116, P.deep);
  d.rect(0, 114, d.w, 2, P.maroon);
  d.y = 26;
  d.textAt('BM VENTURES - STRATEGIC VENTURES', d.margin, d.y, { size: 8, bold: true, colour: P.gold });
  d.y += 15;
  d.textAt('Portfolio Brief', d.margin, d.y, { size: 22, bold: true, colour: '#FFFFFF' });
  d.y += 29;
  d.textAt(longDate(now), d.margin, d.y, { size: 11, bold: true, colour: '#FFFFFF' });
  d.y += 15;
  d.textAt('Prepared by Rafik for internal review'
           + (lastEdited ? '  -  tracker last edited ' + lastEdited : ''),
           d.margin, d.y, { size: 8, colour: P.gold });
  d.y = 142;

  d.para(greeting, { size: 10, colour: P.mid, after: 16 });

  section('Executive summary',
    'The position in one view: what the portfolio looks like this morning, what is '
  + 'past its maturity date, what falls due inside the week, and who is holding '
  + 'work. Everything after this section is the detail behind it.',
    { newPage: false });

  (summary || []).forEach(([label, text]) => d.keepTogether(() => {
    d.textAt(label.toUpperCase(), d.margin, d.y, { size: 7, bold: true, colour: P.faint });
    d.y += 11;
    d.para(text, { size: 10, colour: P.ink, after: 11 });
  }));

  d.y += 4;
  const colW = d.innerWidth / stats.length;
  d.keepTogether(() => {
    stats.forEach(([label, value, colour], i) => {
      const x = d.margin + colW * i;
      d.rect(x, d.y, colW - 6, 40, P.card);
      d.textAt(value, x + 10, d.y + 8,  { size: 15, bold: true, colour });
      d.textAt(label.toUpperCase(), x + 10, d.y + 27, { size: 6.5, bold: true, colour: P.faint });
    });
    d.y += 46;
  });

  /* ----------------------------------------------------- the desks ---- */
  const companyBlock = (c, compact) => {
    const [fg, bg] = tone(c.status);
    d.rule(P.line, { after: 9 });
    d.chip(c.status || '-', d.y - 1, R, fg, bg);
    d.textAt(c.company, d.margin, d.y, { size: compact ? 10.5 : 12, bold: true,
                                         colour: compact ? P.mid : P.ink });
    d.y += compact ? 15 : 17;
    if (!compact) d.para(c.meta, { size: 7.5, colour: c.overdue ? P.crit : P.faint, after: 5 });
    if (c.stands) {
      if (!compact) {
        d.textAt('WHERE IT STANDS', d.margin, d.y, { size: 6.8, bold: true, colour: P.faint });
        if (c.standsWhen) d.textRight(c.standsWhen, R, d.y, { size: 6.8, colour: P.faint });
        d.y += 10;
      }
      d.para(c.stands, { size: compact ? 8.5 : 9.5, colour: compact ? P.faint : P.mid,
                         after: compact ? 4 : 7 });
    }
    if (compact) return;
    if (c.ask) {
      d.textAt('THE ASK', d.margin, d.y, { size: 6.8, bold: true, colour: P.faint });
      d.y += 10;
      d.para(c.ask, { size: 9, colour: P.mid, after: 7 });
    }
    d.textAt('WHAT TO DO', d.margin, d.y, { size: 6.8, bold: true, colour: P.faint });
    if (c.due) d.textRight(c.due, R, d.y, { size: 6.8, colour: c.dueHot ? P.crit : P.faint,
                                            bold: c.dueHot });
    d.y += 11;
    if (c.actions.length) {
      c.actions.forEach(a => {
        d.textAt('>', d.margin, d.y, { size: 9.5, bold: true, colour: P.gold });
        d.para(a, { size: 9.5, bold: true, colour: P.ink, indent: 12, after: 2 });
      });
      d.y += 4;
    } else d.para('No next action recorded.', { size: 9.5, colour: P.faint, after: 6 });
    if (c.done.length) {
      c.done.forEach(t => {
        d.textAt('+', d.margin, d.y, { size: 8.5, bold: true, colour: P.ok });
        d.para(t, { size: 8.5, colour: P.faint, indent: 12, after: 1 });
      });
      d.y += 4;
    }
    if (c.closure) {
      d.textAt('CLOSING THIS', d.margin, d.y, { size: 6.8, bold: true, colour: P.ok });
      d.y += 10;
      d.para(c.closure, { size: 8.5, colour: P.faint, after: 4 });
    }
    d.y += 4;
  };

  desks.concat(orphans ? [orphans] : []).forEach(desk => {
    const act = desk.mine.length;
    section(desk.who,
      `${desk.role}. `
      + (act ? `${act} ${act === 1 ? 'item needs' : 'items need'} ${desk.who}'s action today.`
             : `Nothing needs ${desk.who}'s action today.`)
      + (desk.waiting.length
        ? ` ${desk.waiting.length} more ${desk.waiting.length === 1 ? 'sits' : 'sit'} with `
          + `${desk.who === 'Mina' ? 'counsel' : 'the companies'}, listed after -- `
          + 'nothing to do unless they go quiet.'
        : ''));

    d.textAt(act ? 'YOUR MOVE - ' + act : 'YOUR MOVE - NONE', d.margin, d.y,
             { size: 7, bold: true, colour: act ? P.crit : P.faint });
    d.y += 12;
    if (act) desk.mine.forEach(c => d.keepTogether(() => companyBlock(c, false)));
    else d.para('Nothing is waiting on ' + desk.who + ' right now.',
                { size: 9, colour: P.faint, after: 4 });

    if (desk.waiting.length) {
      d.y += 8;
      d.keepTogether(() => {
        d.textAt((desk.chaseLabel || 'Waiting').toUpperCase() + ' - ' + desk.waiting.length,
                 d.margin, d.y,
                 { size: 7, bold: true, colour: P.faint });
        d.y += 12;
      });
      desk.waiting.forEach(c => d.keepTogether(() => companyBlock(c, true)));
    }
  });

  /* -------------------------------------------------- what moved ---- */
  if (moved.length) {
    section('Moved in the last three days',
      'Every entry logged across the portfolio in the last three days, newest first, '
      + `${moved.length} in all. This is the raw record; the desks above are what to `
      + 'do about it.');
    moved.forEach(m => d.keepTogether(() => {
      d.rule(P.line, { after: 8 });
      d.textAt(m.company, d.margin, d.y, { size: 9.5, bold: true, colour: P.ink });
      d.textRight(m.when, R, d.y, { size: 7.5, colour: P.faint });
      d.y += 13;
      d.para(m.entry, { size: 9, colour: P.mid, after: 4 });
    }));
  }

  return d.toBuffer((doc, page, total) => {
    doc.textAt('BM Ventures  -  Portfolio Brief  -  ' + longDate(now),
               doc.margin, doc.h - 30, { size: 7, colour: P.faint });
    doc.textRight(page + ' / ' + total, doc.w - doc.margin, doc.h - 30,
                  { size: 7, colour: P.faint });
  });
}
