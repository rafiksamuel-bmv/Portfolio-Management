import { Doc, wrap as wrapLines } from '../lib/pdf.js';

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
/* chases is the old status-driven channel. deps is the same idea expressed in
   the dependency field the deck introduced, which names who an item actually
   waits on rather than inferring it from status. deps wins where a company has
   one; chases still covers anything not yet tagged. */
const DESKS = [
  { who: 'Mina',  role: 'counsel liaison', chases: 'Pending legal',
    deps: ['Legal Counsel'], chaseLabel: 'With counsel',
    lead: 'Work tagged to Mina, and everything sitting with El-Shawarby.' },
  { who: 'Rafik', role: 'company outreach', chases: 'Pending company',
    deps: ['Founders / Company'], chaseLabel: 'With the companies',
    lead: 'Work tagged to Rafik, and everything sitting with the companies.' },
  { who: 'Reem',  role: 'decisions & Mr. Mohamed', chases: null,
    deps: ['Co-Investor (Misr Capital)', 'Internal — ISV / Board'],
    chaseLabel: 'With Misr Capital or the Board',
    lead: 'Calls to make, and anything that needs Mr. Mohamed.' },
];

/* What a chase line is headed. Reem runs two channels, so labelling the group
   by the desk put "WITH MISR CAPITAL OR THE BOARD" over Settle, which is with
   ISV internally and not with Misr Capital at all. The heading comes from the
   company's own dependency; desk.chaseLabel is only the fallback for a company
   that reached the desk through `status` and has no dependency set. */
const CHASE_LABEL = {
  'Founders / Company':         'With the companies',
  'Legal Counsel':              'With counsel',
  'Internal — ISV / Board':     'With ISV or the Board',
  'Co-Investor (Misr Capital)': 'With Misr Capital',
};

/* Who a decision now sits with. Derived from dependency rather than stored,
   the same way the status deck derives its card pill. */
const AWAIT = {
  'Founders / Company':         'Awaiting the company',
  'Legal Counsel':              'Awaiting counsel',
  'Internal — ISV / Board':     'Awaiting Board',
  'No Dependency':              'Ready to proceed',
  'Co-Investor (Misr Capital)': 'Awaiting Misr Capital',
};

/* A short human opening, so the brief starts like a note from a colleague
   rather than a report header. Varies by weekday so it does not read canned. */
function greeting(now) {
  const day = now.getUTCDay();
  if (day === 0) return 'Good morning. Start of the week.';
  if (day === 4) return 'Good morning. Last working day of the week.';
  return 'Good morning.';
}

/* ---------- dates ---------- */
const MS_DAY = 86400000;
function ymd(d) { return d.toISOString().slice(0, 10); }
/* maturity_date and extended_to are real DATE columns and arrive as ISO, but
   `due` is a free-text field the team writes as "30 Sep 2026" or
   "31 Dec 2026 (FRA)". Parsing only ISO meant every daysFrom(now, c.due) came
   back null, so the DUE column never lit up and "due inside a week" could not
   fire at all. Accept both, the way parseLoose() does in the app. */
const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseDate(s) {
  const t = String(s || '');
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const loose = /^\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(t);
  if (loose) {
    const i = MON.indexOf(loose[2].toLowerCase());
    if (i >= 0) return new Date(Date.UTC(+loose[3], i, +loose[1]));
  }
  return null;
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

/* next_action is written as "• " bullet lines, but people type what their
   keyboard gives them. Strip * and the other common bullets too: a line typed
   "*Reem: ..." kept its asterisk, so parseAction saw the owner as "*Reem",
   matched nobody, and quietly delivered Reem's action to the company's owner
   instead. One character sent the work to the wrong desk. */
function toLines(text) {
  return String(text || '').split('\n')
    .map(l => l.replace(/^[•\-*·▪‣o]\s*/i, '').trim()).filter(Boolean);
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

  /* ---- the opening ----
     This used to be counts: 12 companies, 9 past maturity, 7 with counsel. All
     true, none of it a reason to do anything, and the same numbers most
     mornings. The brief opens instead with the one thing on each desk that
     matters most today and why it is stuck, which is what a 7am reader is
     actually looking for. */
  const counts = {};
  ['Pending legal', 'Pending company', 'Pending our action'].forEach(k => {
    counts[k] = byNum.filter(c => c.status === k).length; });
  const decided = byNum.filter(c => String(c.decision || '').trim());
  const movedReal = moved.filter(h => h.source !== DONE_SRC);
  const movedDone = moved.filter(h => h.source === DONE_SRC);

  /* Nothing sits above the desks. Counting the work is not the same as saying
     what it is. totalActions survives only for the subject line, where a
     number does earn its place. */
  const totalActions = DESKS.reduce((n, d) => n + deskRows(d).mine.length, 0);

  const section = (title, sub) =>
    `<tr><td style="padding:26px 28px 8px;">
       <div style="font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
                   color:${C.bright};">${esc(title)}</div>
       ${sub ? `<div style="font-size:12.5px;color:${C.faint};margin-top:3px;">${esc(sub)}</div>` : ''}
     </td></tr>`;

  /* ---- desks ----
     The brief itself. One block per person, and for each company on their
     plate the actions that are theirs. Everything else -- how it stands, what
     closing it looks like, the dates -- lives in the tracker. */
  const label = (text, right) =>
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin:11px 0 3px;"><tr>
       <td style="font-size:9.5px;font-family:${MONO};font-weight:700;letter-spacing:.09em;
                  color:${C.faint};">${esc(text)}</td>
       ${right ? `<td align="right" style="font-size:10px;font-family:${MONO};
                  color:${C.faint};">${right}</td>` : ''}
     </tr></table>`;

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
    const chasing = byNum.filter(c => {
      if (has[c.company]) return false;
      /* The brief is next actions and who owns them. A company nobody has an
         action on has no place in it, however it happens to be tagged. */
      if (!toLines(c.next_action).length) return false;
      const dep = String(c.dependency || '').trim();
      return dep ? (desk.deps || []).indexOf(dep) > -1
                 : (desk.chases ? c.status === desk.chases : false);
    });
    /* Grouped here rather than in either renderer, so the two cannot drift. */
    const order = [], byLabel = {};
    chasing.forEach(c => {
      const label = CHASE_LABEL[String(c.dependency || '').trim()]
                    || desk.chaseLabel || 'Waiting';
      if (!byLabel[label]) { byLabel[label] = []; order.push(label); }
      byLabel[label].push(c.company);
    });
    const chaseGroups = order.map(label => ({ label, companies: byLabel[label] }));
    return { mine, chasing, chaseGroups };
  }

  /* A company can sit on several desks with different work, which is the
     point. What must not repeat with it is the metadata: the lateness badge,
     the status pill and the due date were reprinted on every copy and between
     them were most of the brief's length, along with the line of context that
     sat under the actions. A row is two things: the company, and what that
     person has to do about it. */
  function gridRow(c, actions, i) {
    const zebra = i % 2 ? C.soft : 'transparent';
    return `<tr>
      <td valign="top" bgcolor="${zebra}" width="118" style="padding:9px 10px;
          border-bottom:1px solid ${C.line};background:${zebra};">
        <div style="font-size:12.5px;font-weight:700;color:${C.ink};">${esc(c.company)}</div>
      </td>
      <td valign="top" bgcolor="${zebra}" style="padding:9px 10px;border-bottom:1px solid ${C.line};
          background:${zebra};">
        ${(actions || []).map(a =>
          `<div style="font-size:12.5px;color:${C.ink};font-weight:600;line-height:1.45;
                margin-bottom:3px;">${esc(a)}</div>`).join('')
          || `<div style="font-size:12px;color:${C.faint};">—</div>`}
      </td>
    </tr>`;
  }

  const gridHead = `<tr>
    <td style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
        letter-spacing:.08em;color:${C.faint};border-bottom:1.5px solid ${C.line};">COMPANY</td>
    <td style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
        letter-spacing:.08em;color:${C.faint};border-bottom:1.5px solid ${C.line};">WHAT TO DO</td>
    <td align="right" style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
  </tr>`;

  /* rows is an array: interpolating it directly would join it with commas,
     which rendered as a stray "," between every row of every desk. Shared with
     the Unassigned block below, which has to render the same way. */
  const grid = rows => `<table width="100%" cellpadding="0" cellspacing="0"
      style="margin-top:4px;">${gridHead}${rows.join('')}</table>`;

  function deskBlock(desk) {
    const { mine, chasing, chaseGroups } = deskRows(desk);
    if (!mine.length && !chasing.length) return '';
    return `<tr><td style="padding:0 28px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:700;color:${C.ink};padding-bottom:2px;">
          ${esc(desk.who)}
          <span style="font-weight:400;color:${C.faint};font-size:11.5px;">
            · ${esc(desk.role)}</span></td>
        <td align="right">${mine.length
          ? pill(mine.length + ' to act', C.crit, C.critBg)
          : pill(chasing.length ? 'chasing only' : 'clear', C.ok, C.okBg)}</td>
      </tr></table>
      ${mine.length ? grid(mine.map((m, i) => gridRow(m.c, m.acts, i))) : ''}
      ${chaseGroups.map(g => `
        <div style="font-size:11.5px;color:${C.faint};margin-top:12px;line-height:1.5;">
          <span style="font-family:${MONO};font-weight:700;letter-spacing:.08em;
                font-size:8.5px;">${esc(g.label.toUpperCase())}</span>
          &nbsp;${esc(g.companies.join(', '))}</div>`).join('')}
    </td></tr>`;
  }

  /* ---- what moved ----
     Split the tick-box entries out. "Completed: chase the founders" is a task
     coming off a list, not the position changing, and on a normal day they
     outnumber the real entries and bury them. */
  const movedBlock = movedReal.map((h, i) => {
    const zebra = i % 2 ? C.soft : 'transparent';
    return `<tr>
      <td valign="top" bgcolor="${zebra}" width="86" style="padding:6px 8px;background:${zebra};
          border-bottom:1px solid ${C.line};font-size:9.5px;font-family:${MONO};
          color:${C.faint};white-space:nowrap;">${esc(dmy(h.entry_date))}</td>
      <td valign="top" bgcolor="${zebra}" width="96" style="padding:6px 8px;background:${zebra};
          border-bottom:1px solid ${C.line};font-size:11.5px;font-weight:700;color:${C.ink};
          white-space:nowrap;">${esc(h.company || 'General')}</td>
      <td valign="top" bgcolor="${zebra}" style="padding:6px 8px;background:${zebra};
          border-bottom:1px solid ${C.line};font-size:11.5px;color:${C.mid};line-height:1.45;">${
        esc(String(h.entry).split('\n')[0].replace(/^[•\-]\s*/, '')).slice(0, 150)}</td>
    </tr>`;
  }).join('')
  || `<tr><td style="padding:8px 0;font-size:12px;color:${C.faint};">
        Nothing logged since the last brief.</td></tr>`;
  const tickedLine = movedDone.length
    ? `<div style="font-size:11px;color:${C.faint};padding:8px 8px 0;">Also ticked off: ${
        esc(movedDone.map(h => h.company).filter((v, i, a) => a.indexOf(v) === i).join(', '))
      } · ${movedDone.length} action${movedDone.length === 1 ? '' : 's'}.</div>`
    : '';

  /* ---- decisions taken ----
     These used to be invisible: nothing in the brief said a decision had been
     reached, and the summary that once sat at the top counted "ours to decide"
     from status, so it read 0 on the day two decisions were actually made. */
  const decidedBlock = decided.map(c => `<tr>
      <td valign="top" width="118" style="padding:8px 10px 8px 0;border-bottom:1px solid ${C.line};
          font-size:12.5px;font-weight:700;color:${C.ink};">${esc(c.company)}</td>
      <td valign="top" style="padding:8px 0;border-bottom:1px solid ${C.line};">
        <div style="font-size:12.5px;color:${C.ink};line-height:1.45;">${esc(c.decision)}</div>
        ${c.decision_next ? `<div style="font-size:11px;color:${C.faint};margin-top:3px;">${
          esc(c.decision_next)}</div>` : ''}
      </td>
      <td valign="top" align="right" width="118" style="padding:8px 0 8px 10px;
          border-bottom:1px solid ${C.line};white-space:nowrap;">${
        pill(AWAIT[c.dependency] || 'agreed', C.ok, C.okBg)}</td>
    </tr>`).join('');

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
  </td></tr>

  ${section('Your morning', 'What each of us is holding, and what to do about it')}
  ${DESKS.map(deskBlock).join('')}

  ${decided.length ? `${section('Decided, awaiting sign-off',
      'Settled on our side — what each one is waiting on')}
  <tr><td style="padding:0 28px 6px;"><table width="100%" cellpadding="0" cellspacing="0">${decidedBlock}</table></td></tr>` : ''}

  <tr><td style="padding:26px 28px 0;">
    <div style="border-top:2px solid ${C.line};padding-top:14px;font-size:10px;
         font-family:${MONO};font-weight:700;letter-spacing:.14em;color:${C.faint};">
      ANNEX</div>
    <div style="font-size:11px;color:${C.faint};margin-top:3px;">
      The record behind the desks above. Nothing here needs doing today.</div>
  </td></tr>

  ${section(usingFallback ? 'Most recent activity' : 'What moved',
      usingFallback
        ? 'Nothing logged in the last three days, so here are the latest entries on file'
        : `${movedReal.length} entr${movedReal.length === 1 ? 'y' : 'ies'} in the last three days`)}
  <tr><td style="padding:0 28px 6px;"><table width="100%" cellpadding="0" cellspacing="0">${movedBlock}</table>${tickedLine}</td></tr>


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
    + `${totalActions} action${totalActions === 1 ? '' : 's'}`
    + (movedReal.length ? ` · ${movedReal.length} moved` : '')
    + (decided.length ? ` · ${decided.length} decided` : '');

  /* The same content the HTML shows, as plain data, so the PDF is laid out
     from the brief rather than converted from its markup. */
  /* Only what the PDF renders. It used to carry the maturity label, the status
     and the due date as well, all of which came off the desk rows with the
     Standing section. */
  const forCompany = c => ({
    company: c.company,
    actions: toLines(c.next_action),
  });

  const pdfDesks = DESKS.map(desk => {
    const { mine, chasing, chaseGroups } = deskRows(desk);
    return {
      who: desk.who, role: desk.role,
      chaseLabel: desk.chaseLabel || 'Waiting',
      mine:    mine.map(m => ({ ...forCompany(m.c), actions: m.acts })),
      /* A chasing row is a company this person has no action on -- that is what
         puts it in this list. The PDF used to print everyone else's action
         lines here, prefix and all, where the email printed nothing. */
      waiting: chasing.map(c => ({ ...forCompany(c), actions: [] })),
      chaseGroups,
    };
  });
  const pdfData = {
    now, lastEdited, greeting: greeting(now),
    desks: pdfDesks,
    moved: movedReal.map(h => ({
      company: h.company || 'General',
      when: dmy(h.entry_date) + (h.source ? '  -  ' + h.source : ''),
      entry: String(h.entry).replace(/^[•\-]\s*/, ''),
    })),
    ticked: movedDone.length
      ? movedDone.map(h => h.company).filter((v, i, a) => a.indexOf(v) === i).join(', ')
        + '  -  ' + movedDone.length + ' action' + (movedDone.length === 1 ? '' : 's')
      : '',
    decided: decided.map(c => ({
      company: c.company, decision: c.decision, next: c.decision_next || '',
      pill: AWAIT[c.dependency] || 'agreed',
    })),
  };

  /* The email carries the PDF and this, not the HTML: enough for the phone
     preview to be useful, and nothing to read twice. */
  const text = [
    greeting(now),
    'Your portfolio brief is attached.',
  ].join('\n\n');

  return { html, text, subject, counts, pdfData,
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
/* The floor under the morning brief: company, then that company's raw
   next_action lines straight off the row, with no formatting logic in between.
   It exists because buildBrief throwing used to mean the cron returned 502 and
   nobody was sent anything or told anything -- a data edit could silently cost
   the whole morning. Keep this dependency-free and defensive: it is the thing
   that runs when everything else has already gone wrong. */
export function fallbackBrief(companies, err, now) {
  let body = 'No open actions are recorded.';
  try {
    const blocks = (companies || []).map(c => {
      const acts = String((c && c.next_action) || '').split('\n')
        .map(l => l.replace(/^[•\-]\s*/, '').trim()).filter(Boolean);
      const name = (c && c.company) || 'Unnamed';
      return acts.length ? name + '\n' + acts.map(a => '  - ' + a).join('\n') : '';
    }).filter(Boolean);
    if (blocks.length) body = blocks.join('\n\n');
  } catch (e) { body = 'The tracker could not be read either: ' + e.message; }
  return {
    reduced: true,
    subject: `Portfolio Brief — ${dmy(ymd(now))} · reduced`,
    text: [
      'The brief could not be built this morning, so this is the raw list of',
      'open actions from the tracker.',
      '',
      body,
      '',
      'What went wrong: ' + ((err && err.message) || String(err)),
    ].join('\n'),
  };
}

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
  let data;
  try {
    data = await loadTracker(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  } catch (err) {
    return res.status(502).send(`Could not read the tracker: ${err.message}`);
  }

  let brief;
  try {
    brief = buildBrief({ ...data, today: now0 });
  } catch (err) {
    /* ?preview and ?pdf are a person looking at it, so show them the error.
       A scheduled send must not go quiet: fall back to the raw actions so the
       brief still arrives and the failure is visible in it. */
    if (preview || url.searchParams.get('pdf') === '1') {
      return res.status(502).send(`Could not build the brief: ${err.message}`);
    }
    brief = fallbackBrief(data && data.companies, err, now0);
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
  let pdfNote;
  if (brief.reduced) {
    pdfNote = 'skipped: reduced brief';          /* there is nothing to lay out */
  } else {
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
  }

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: BRIEF_FROM || 'BMV Portfolio <onboarding@resend.dev>',
      to: [BRIEF_TO || DEFAULT_TO],
      subject: brief.subject,
      /* PDF only. The HTML is the fallback for the case where the PDF failed
         to build -- a brief in the wrong format beats no brief at all. */
      ...(attachments ? { text: brief.text, attachments }
                      : { text: brief.text, ...(brief.html ? { html: brief.html } : {}) }),
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
export function briefPdf({ now, lastEdited, greeting,
  ticked, decided,
                           desks, moved }) {
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
  /* Sections used to take a page each. Now that the desks are grids that is
     mostly white space, so they flow, breaking only when a section would start
     with too little room beneath it to be worth reading. */
  const section = (title, blurb, opts = {}) => {
    if (started) { d.y += 14; d.room(opts.needs || 150); }
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

  /* No executive summary. It restated in four labelled blocks what the rest of
     the page already says, and pushed the first actual instruction below the
     fold. The brief opens on the one thing each desk has to move and why it is
     stuck. */
  /* ----------------------------------------------------- the desks ---- */
  /* A grid, matching the email. Columns are fixed so the eye can run down
     them; each row is measured and kept whole. */
  const COL = { co: 0, act: 118, right: d.innerWidth };
  const gridHeader = () => {
    d.textAt('COMPANY', d.margin, d.y, { size: 6.5, bold: true, colour: P.faint });
    d.textAt('WHAT TO DO', d.margin + COL.act, d.y, { size: 6.5, bold: true, colour: P.faint });
    d.y += 9;
    d.rect(d.margin, d.y, d.innerWidth, 1, P.line);
    d.y += 6;
  };

  /* Same trim as the email: the lateness badge repeated a fact that is in the
     Standing annex, and the status chip repeats the desk you are reading. The
     context line under the actions went with them. */
  const gridRow = (c, i) => d.keepTogether(() => {
    const top = d.y;
    const actW = COL.right - COL.act - 104;
    /* measure the tallest column first so the zebra covers the whole row */
    const bodyLines = (c.actions.length ? c.actions : ['-'])
      .reduce((n, a) => n + wrapCount(a, actW, 9, true), 0);
    const h = Math.max(26, bodyLines * 12.5 + 12);
    if (i % 2) d.rect(d.margin - 4, top - 4, d.innerWidth + 8, h + 6, P.card);

    d.textAt(c.company, d.margin, d.y, { size: 9.5, bold: true, colour: P.ink });

    const save = d.y;
    d.y = top;
    (c.actions.length ? c.actions : ['-']).forEach(a => {
      d.para(a, { size: 9, bold: true, colour: P.ink, indent: COL.act,
                  width: COL.act + actW, after: 1 });
    });
    d.y = Math.max(d.y, save) + 8;
  });
  /* How many lines will this wrap to? Cheap enough to ask twice. */
  const wrapCount = (t, w, size, bold) => wrapLines(t, bold, size, w).length;

  desks.forEach(desk => {
    const act = desk.mine.length;
    section(desk.who, (
      `${desk.role}. `
      + (act ? `${act} ${act === 1 ? 'item needs' : 'items need'} ${desk.who}'s action today.`
             : `Nothing needs ${desk.who}'s action today.`)
      /* The channels are named on the lines below, one per dependency. Naming
         one of them here got it wrong for the other: Reem runs two. */
      + (desk.waiting.length
        ? ` ${desk.waiting.length} more ${desk.waiting.length === 1 ? 'sits' : 'sit'} `
          + 'with someone else.'
        : '')));

    if (act) { gridHeader(); desk.mine.forEach((c, i) => gridRow(c, i)); }
    else if (!desk.waiting.length) {
      d.para('Nothing is waiting on ' + desk.who + ' right now.',
             { size: 9, colour: P.faint, after: 6 });
    }

    /* A chasing row has nothing to put under WHAT TO DO -- having no action for
       this person is what puts the company in this list -- so it was a table of
       dashes. One line naming them says the same thing. */
    (desk.chaseGroups || []).forEach(g => d.keepTogether(() => {
      d.y += 10;
      d.textAt(g.label.toUpperCase(), d.margin, d.y,
               { size: 6.5, bold: true, colour: P.faint });
      d.para(g.companies.join(', '),
             { size: 9, colour: P.mid, indent: COL.act, width: d.innerWidth, after: 4 });
    }));
  });

  /* --------------------------------------------------- decisions ---- */
  if ((decided || []).length) {
    section('Decided, awaiting sign-off',
      'Settled on our side. What each one is now waiting on.');
    decided.forEach(x => d.keepTogether(() => {
      d.rule(P.line, { after: 8 });
      d.textAt(x.company, d.margin, d.y, { size: 9.5, bold: true, colour: P.ink });
      d.textRight(x.pill, R, d.y, { size: 7.5, bold: true, colour: P.gold });
      d.y += 13;
      d.para(x.decision, { size: 9.5, colour: P.ink, after: 3 });
      if (x.next) d.para(x.next, { size: 8.5, colour: P.faint, after: 4 });
    }));
  }

  /* ---------------------------------------------------------- annex ---- */
  /* The record, not the work. It sits behind the desks because nothing in it
     needs doing today -- the brief proper is what each person has to move. */
  d.room(180);
  d.y += 18;
  d.rect(d.margin, d.y, d.innerWidth, 2, P.line);
  d.y += 12;
  d.textAt('ANNEX', d.margin, d.y, { size: 10, bold: true, colour: P.faint });
  d.y += 14;
  d.para('The record behind the desks above. Nothing here needs doing today.',
         { size: 8.5, colour: P.faint, after: 4 });
  started = false;

  /* ------------------------------------------------- what moved ---- */
  if ((moved || []).length) {
    section('What moved',
      `Every entry logged across the portfolio in the last three days, newest first, `
      + `${moved.length} in all. This is the record behind the desks above.`);
    moved.forEach(m => d.keepTogether(() => {
      d.rule(P.line, { after: 8 });
      d.textAt(m.company, d.margin, d.y, { size: 9.5, bold: true, colour: P.ink });
      d.textRight(m.when, R, d.y, { size: 7.5, colour: P.faint });
      d.y += 13;
      d.para(m.entry, { size: 9, colour: P.mid, after: 4 });
    }));
    if (ticked) d.para('Also ticked off: ' + ticked + '.',
                       { size: 8.5, colour: P.faint, after: 4 });
  }


  return d.toBuffer((doc, page, total) => {
    doc.textAt('BM Ventures  -  Portfolio Brief  -  ' + longDate(now),
               doc.margin, doc.h - 30, { size: 7, colour: P.faint });
    doc.textRight(page + ' / ' + total, doc.w - doc.margin, doc.h - 30,
                  { size: 7, colour: P.faint });
  });
}
