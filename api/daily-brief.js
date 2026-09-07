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

/* The one line of context under a desk row. issue_title is the curated version
   of what the newest entry's first line was only ever approximating, so prefer
   it and fall back for any company that has not been given one yet. */
function issueLine(c, last) {
  const t = String(c.issue_title || '').trim();
  if (t) return t;
  return last ? String(last.entry).split('\n')[0].replace(/^[•\-]\s*/, '') : '';
}

/* What goes under a desk row. latest_status is what actually happened and is
   what a brief is for; issue_title only names the topic, so it is the fallback,
   and the newest history entry the fallback of last resort. */
function statusLine(c, last) {
  const s = String(c.latest_status || '').trim();
  return s || issueLine(c, last);
}

/* next_action is written as "• " bullet lines. */
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
     actually looking for. The standing totals live at the foot. */
  const counts = {};
  ['Pending legal', 'Pending company', 'Pending our action'].forEach(k => {
    counts[k] = byNum.filter(c => c.status === k).length; });
  const decided = byNum.filter(c => String(c.decision || '').trim());
  const movedReal = moved.filter(h => h.source !== DONE_SRC);
  const movedDone = moved.filter(h => h.source === DONE_SRC);

  /* Most pressing first: priority band, then the nearest due date. Deliberately
     NOT how far past maturity a note is -- that is the standing fact at the
     foot, and using it here put the same 14-month-old company at the top of
     all three desks. */
  const PRI_RANK = { 'Immediate': 0, 'Near-Term': 1, 'Postponed': 2, 'No Action': 3 };
  function pressing(a, b) {
    const ra = PRI_RANK[a.priority], rb = PRI_RANK[b.priority];
    const da = daysFrom(now, a.due), db = daysFrom(now, b.due);
    return (ra === undefined ? 9 : ra) - (rb === undefined ? 9 : rb)
        || (da === null ? 9999 : da) - (db === null ? 9999 : db)
        || String(a.company).localeCompare(String(b.company));
  }
  /* And no two desks open on the same company where that can be avoided: three
     lines about Zammit is the repetition this opening exists to replace. */
  const taken = {};
  const firstThings = DESKS.map(desk => {
    const { mine } = deskRows(desk);
    if (!mine.length) return null;
    const ranked = mine.slice().sort((x, y) => pressing(x.c, y.c));
    const pick = ranked.find(m => !taken[m.c.company]) || ranked[0];
    taken[pick.c.company] = 1;
    return {
      who: desk.who,
      company: pick.c.company,
      action: pick.acts[0],
      why: statusLine(pick.c, latestEntry(history, pick.c)),
      rest: mine.length - 1,
    };
  }).filter(Boolean);

  const totalActions = DESKS.reduce((n, d) => n + deskRows(d).mine.length, 0);
  const waitingOn = decided
    .map(c => String(AWAIT[c.dependency] || '').replace(/^Awaiting /, ''))
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  const andList = xs => xs.length < 2 ? (xs[0] || '')
    : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const topline =
    `${totalActions} action${totalActions === 1 ? '' : 's'} across `
  + `${firstThings.length} desk${firstThings.length === 1 ? '' : 's'}.`
  + (decided.length
      ? ` ${decided.length} decision${decided.length === 1 ? ' is' : 's are'} settled`
        + `${waitingOn.length ? `, waiting on ${andList(waitingOn)}` : ''}.`
      : '')
  + (movedReal.length
      ? ` ${movedReal.length} update${movedReal.length === 1 ? '' : 's'} logged in three days.`
      : ' Nothing logged in three days.');

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

  /* A grid row, not a block. Company, where it stands in one line, the actions
     that are this person's, and the date -- everything else lives in the
     tracker and was making the brief too long to read at 7am. */
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
      const dep = String(c.dependency || '').trim();
      return dep ? (desk.deps || []).indexOf(dep) > -1
                 : (desk.chases ? c.status === desk.chases : false);
    });
    return { mine, chasing };
  }

  /* A company can sit on several desks with different work, which is the
     point. What must not repeat with it is the metadata: the lateness badge,
     the status pill and the due date were being reprinted on every copy, and
     between them they were most of the brief's length. Maturity now lives in
     one standing line at the foot, the status pill is implied by the desk you
     are reading, and the due date appears only when it is actually near. */
  function gridRow(c, actions, i) {
    const due = daysFrom(now, c.due);
    const hot = due !== null && due <= 7;
    const zebra = i % 2 ? C.soft : 'transparent';
    const ctx = statusLine(c, latestEntry(history, c));
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
        ${ctx ? `<div style="font-size:10.5px;color:${C.faint};line-height:1.4;
          margin-top:3px;">${esc(ctx.slice(0, 150))}</div>` : ''}
      </td>
      <td valign="top" align="right" bgcolor="${zebra}" width="92"
          style="padding:9px 10px;border-bottom:1px solid ${C.line};background:${zebra};
                 white-space:nowrap;">
        ${hot ? `<div style="font-size:9.5px;font-family:${MONO};color:${C.crit};
             font-weight:700;">${esc(c.due)}</div>` : ''}
      </td>
    </tr>`;
  }

  const gridHead = `<tr>
    <td style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
        letter-spacing:.08em;color:${C.faint};border-bottom:1.5px solid ${C.line};">COMPANY</td>
    <td style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
        letter-spacing:.08em;color:${C.faint};border-bottom:1.5px solid ${C.line};">WHAT TO DO</td>
    <td align="right" style="padding:0 10px 5px;font-size:8.5px;font-family:${MONO};font-weight:700;
        letter-spacing:.08em;color:${C.faint};border-bottom:1.5px solid ${C.line};">DUE</td>
  </tr>`;

  function deskBlock(desk) {
    const { mine, chasing } = deskRows(desk);
    if (!mine.length && !chasing.length) return '';
    /* rows is an array: interpolating it directly would join it with commas,
       which rendered as a stray "," between every row of every desk. */
    const grid = rows => `<table width="100%" cellpadding="0" cellspacing="0"
        style="margin-top:4px;">${gridHead}${rows.join('')}</table>`;
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
      ${chasing.length ? `
        <div style="font-size:8.5px;font-family:${MONO};font-weight:700;letter-spacing:.08em;
             color:${C.faint};margin-top:12px;">${
          (desk.chaseLabel || 'Waiting').toUpperCase()} · ${chasing.length}</div>
        ${grid(chasing.map((c, i) => gridRow(c, [], i)))}` : ''}
    </td></tr>`;
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
     These were invisible: the topline counted "ours to decide" from status, so
     it read 0 on the day two decisions were actually made. */
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

  /* ---- standing risks ----
     Nine notes past maturity is real but it has not changed in 14 months. It
     was a red badge on every desk row AND a section of its own, so the loudest
     thing in the brief was also the least new. Once, at the foot. */
  const dueSoon = byNum
    .map(c => ({ c, d: daysFrom(now, c.due) }))
    .filter(x => x.d !== null && x.d <= 7)
    .sort((a, b) => a.d - b.d);
  const noExtNames = overdue.filter(c => !c.extended_to).map(c => c.company);
  const standing = [
    noExtNames.length
      ? `<b style="color:${C.crit};">${noExtNames.length} note${noExtNames.length === 1 ? '' : 's'} past maturity</b> with no signed extension — ${esc(noExtNames.join(', '))}.`
      : 'Every note is within term or covered by a signed extension.',
    dueSoon.length
      ? `<b>Due inside a week:</b> ${esc(dueSoon.map(x => `${x.c.company} (${x.c.due})`).join(', '))}.`
      : '',
  ].filter(Boolean).map(t =>
    `<div style="font-size:12px;color:${C.mid};line-height:1.6;">${t}</div>`).join('');

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
    <table width="100%" cellpadding="0" cellspacing="0">
      ${firstThings.map(f => `<tr>
        <td valign="top" width="66" style="padding:9px 10px 9px 0;border-top:1px solid ${C.line};
            font-size:13px;font-weight:700;color:${C.crit};white-space:nowrap;">${esc(f.who)}</td>
        <td valign="top" style="padding:9px 0;border-top:1px solid ${C.line};">
          <div style="font-size:13.5px;font-weight:600;color:${C.ink};line-height:1.45;">${
            esc(f.action)}</div>
          <div style="font-size:11px;color:${C.faint};line-height:1.5;margin-top:3px;">
            <b style="color:${C.mid};">${esc(f.company)}</b>${
              f.why ? ' · ' + esc(f.why.slice(0, 120)) : ''}</div>
        </td>
        <td valign="top" align="right" width="74" style="padding:9px 0 9px 10px;
            border-top:1px solid ${C.line};font-size:10.5px;color:${C.faint};
            white-space:nowrap;">${f.rest ? '+' + f.rest + ' more' : ''}</td>
      </tr>`).join('')}
    </table>
  </td></tr>

  ${section(usingFallback ? 'Most recent activity' : 'What moved',
      usingFallback
        ? 'Nothing logged in the last three days, so here are the latest entries on file'
        : `${movedReal.length} entr${movedReal.length === 1 ? 'y' : 'ies'} in the last three days`)}
  <tr><td style="padding:0 28px 6px;"><table width="100%" cellpadding="0" cellspacing="0">${movedBlock}</table>${tickedLine}</td></tr>

  ${decided.length ? `${section('Decided, awaiting sign-off',
      'Settled on our side — what each one is waiting on')}
  <tr><td style="padding:0 28px 6px;"><table width="100%" cellpadding="0" cellspacing="0">${decidedBlock}</table></td></tr>` : ''}

  ${section('Your morning', 'What each of us is holding, and what to do about it')}
  ${DESKS.map(deskBlock).join('')}${orphanBlock()}

  ${section('Standing', 'Unchanged risk, stated once')}
  <tr><td style="padding:0 28px 6px;">${standing}</td></tr>

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
  const forCompany = c => {
    const last = latestEntry(history, c);
    const due = daysFrom(now, c.due);
    const od = overdueLabel(now, c);
    return {
      company: c.company, status: c.status,
      meta: `${effMaturity(c) ? 'matures ' + dmy(effMaturity(c)) : 'no maturity'}`
            + `${od ? '  -  ' + od : ''}`,
      metaShort: (() => {
        const days = overdueDays(now, c);
        if (days === null) return effMaturity(c) ? dmy(effMaturity(c)) : '-';
        const mo = Math.floor(days / 30.44);
        return mo >= 1 ? mo + 'mo late' : days + 'd late';   /* 0mo late reads as nothing */
      })(),
      overdue: !!od,
      stands: statusLine(c, last),
      standsWhen: last ? dmy(last.entry_date) + (last.source ? '  -  ' + last.source : '') : '',
      ask: (c.legal_req && c.status === 'Pending legal') ? c.legal_req : '',
      due: c.due ? 'due ' + c.due + (due !== null && due <= 7
            ? '  -  ' + (due < 0 ? Math.abs(due) + ' days late' : due === 0 ? 'today' : due + ' days')
            : '') : 'no date set',
      dueHot: due !== null && due <= 7,
      actions: toLines(c.next_action),
      done: doneRecent(history, c).map(h =>
        String(h.entry).replace(/^Completed:\s*/, '') + '  (' + dmy(h.entry_date) + ')'),
    };
  };
  const pdfDesks = DESKS.map(desk => {
    const { mine, chasing } = deskRows(desk);
    return {
      who: desk.who, role: desk.role,
      chaseLabel: desk.chaseLabel || 'Waiting',
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
    now, lastEdited, topline, greeting: greeting(now), firstThings, summary,
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
export function briefPdf({ now, lastEdited, topline, greeting, firstThings, summary,
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

  /* The counts that used to sit here said nothing about what to do. Open on
     the one thing each desk has to move, and why it is stuck. */
  d.y += 4;
  (firstThings || []).forEach(f => d.keepTogether(() => {
    d.textAt(f.who.toUpperCase(), d.margin, d.y, { size: 7, bold: true, colour: P.crit });
    d.y += 11;
    d.para(f.action, { size: 10.5, bold: true, colour: P.ink, after: 3 });
    d.para(f.company + (f.why ? '  -  ' + f.why : '')
             + (f.rest ? '   (+' + f.rest + ' more)' : ''),
           { size: 8.5, colour: P.faint, after: 11 });
  }));

  /* ----------------------------------------------------- the desks ---- */
  /* A grid, matching the email. Columns are fixed so the eye can run down
     them; each row is measured and kept whole. */
  const COL = { co: 0, act: 118, right: d.innerWidth };
  const gridHeader = () => {
    d.textAt('COMPANY', d.margin, d.y, { size: 6.5, bold: true, colour: P.faint });
    d.textAt('WHAT TO DO', d.margin + COL.act, d.y, { size: 6.5, bold: true, colour: P.faint });
    d.textRight('STATUS / DUE', R, d.y, { size: 6.5, bold: true, colour: P.faint });
    d.y += 9;
    d.rect(d.margin, d.y, d.innerWidth, 1, P.line);
    d.y += 6;
  };

  const gridRow = (c, i) => d.keepTogether(() => {
    const [fg, bg] = tone(c.status);
    const top = d.y;
    const actW = COL.right - COL.act - 104;
    /* measure the tallest column first so the zebra covers the whole row */
    const bodyLines = (c.actions.length ? c.actions : ['-'])
      .reduce((n, a) => n + wrapCount(a, actW, 9, true), 0);
    const standsLines = c.stands ? wrapCount(c.stands, actW, 7.5, false) : 0;
    const h = Math.max(26, bodyLines * 12.5 + standsLines * 10 + 12);
    if (i % 2) d.rect(d.margin - 4, top - 4, d.innerWidth + 8, h + 6, P.card);

    d.textAt(c.company, d.margin, d.y, { size: 9.5, bold: true, colour: P.ink });
    d.textAt(c.metaShort, d.margin, d.y + 12, { size: 6.5,
             colour: c.overdue ? P.crit : P.faint });
    d.chip(c.status || '-', top - 2, R, fg, bg, 6.5);
    d.textRight(c.due || 'no date', R, top + 14,
                { size: 6.5, colour: c.dueHot ? P.crit : P.faint, bold: c.dueHot });

    const save = d.y;
    d.y = top;
    (c.actions.length ? c.actions : ['-']).forEach(a => {
      d.para(a, { size: 9, bold: true, colour: P.ink, indent: COL.act,
                  width: COL.act + actW, after: 1 });
    });
    if (c.stands) d.para(c.stands, { size: 7.5, colour: P.faint, indent: COL.act,
                                     width: COL.act + actW, after: 0 });
    d.y = Math.max(d.y, save) + 8;
  });
  /* How many lines will this wrap to? Cheap enough to ask twice. */
  const wrapCount = (t, w, size, bold) => wrapLines(t, bold, size, w).length;

  desks.concat(orphans ? [orphans] : []).forEach(desk => {
    const act = desk.mine.length;
    section(desk.who,
      `${desk.role}. `
      + (act ? `${act} ${act === 1 ? 'item needs' : 'items need'} ${desk.who}'s action today.`
             : `Nothing needs ${desk.who}'s action today.`)
      + (desk.waiting.length
        ? ` ${desk.waiting.length} more ${desk.waiting.length === 1 ? 'sits' : 'sit'} with `
          + `${desk.who === 'Mina' ? 'counsel' : 'the companies'}.`
        : ''));

    if (act) { gridHeader(); desk.mine.forEach((c, i) => gridRow(c, i)); }
    else d.para('Nothing is waiting on ' + desk.who + ' right now.',
                { size: 9, colour: P.faint, after: 6 });

    if (desk.waiting.length) {
      d.y += 10;
      d.textAt((desk.chaseLabel || 'Waiting').toUpperCase() + ' - ' + desk.waiting.length,
               d.margin, d.y, { size: 6.5, bold: true, colour: P.faint });
      d.y += 11;
      gridHeader();
      desk.waiting.forEach((c, i) => gridRow(c, i));
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
