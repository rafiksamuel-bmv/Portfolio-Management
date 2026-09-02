/* Daily portfolio brief.
 *
 * Runs on a Vercel cron (see vercel.json), reads the tracker straight from
 * Supabase and emails the brief. Deliberately dependency-free: Supabase and
 * Resend are both plain REST, so this needs nothing installed.
 *
 * GET /api/daily-brief?preview=1   renders the HTML without sending.
 *
 * Environment (set in Vercel, never in the repo):
 *   SUPABASE_URL                the project URL
 *   SUPABASE_SERVICE_ROLE_KEY   needed because RLS grants only "authenticated"
 *   RESEND_API_KEY              sending key
 *   BRIEF_TO                    recipient (defaults below)
 *   BRIEF_FROM                  verified sender
 *   CRON_SECRET                 set by Vercel; also accepted as ?key= for previews
 */

const DEFAULT_TO = 'rafiksamuel@aucegypt.edu';

/* Who moves each item. The status field already says who holds the ball, so
   the desks fall straight out of it rather than being a second thing to keep
   in step. */
const DESKS = [
  { key: 'Pending legal',      who: 'Mina',  role: 'counsel liaison',
    lead: 'With El-Shawarby. Nothing else moves until the advice lands.' },
  { key: 'Pending company',    who: 'Rafik', role: 'company outreach',
    lead: 'With the companies. Chase, and escalate where it has run long.' },
  { key: 'Pending our action', who: 'Reem',  role: 'decisions & Mr. Mohamed',
    lead: 'Ours to decide. These are the only items no one else is holding.' },
];

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
function latestEntry(history, c) {
  const rows = history.filter(h => h.company === c.company);
  if (!rows.length) return null;
  return rows.slice().sort((a, b) =>
    String(b.entry_date).localeCompare(String(a.entry_date)) ||
    String(b.created_at || '').localeCompare(String(a.created_at || ''))
  )[0];
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

/* ---------- palette ---------- */
const C = {
  maroon: '#7B1F2C', deep: '#5E1621', bright: '#A72A30', gold: '#C9A227',
  page: '#F4F1F1', card: '#FFFFFF', line: '#E5DADB', soft: '#FBF8F8',
  ink: '#1C1517', mid: '#5D5052', faint: '#8B7C7E',
  crit: '#A72A30', critBg: '#F7E5E6', warn: '#8A6510', warnBg: '#F7EEDA',
  calm: '#3F5170', calmBg: '#E6EAF1', ok: '#1D6A48', okBg: '#DFEFE7',
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
export function buildBrief({ companies, history, asOf, today }) {
  const now = today || new Date();
  const todayStr = ymd(now);
  const yesterday = ymd(new Date(now - MS_DAY));

  const byNum = companies.slice().sort((a, b) => (a.num || 0) - (b.num || 0));
  const overdue = byNum.filter(c => overdueDays(now, c) !== null)
                       .sort((a, b) => overdueDays(now, b) - overdueDays(now, a));
  const immediate = byNum.filter(c => c.priority === 'Immediate');
  const moved = history
    .filter(h => h.entry_date >= yesterday)
    .sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)));

  /* ---- top line: state the position, do not editorialise ---- */
  const counts = {};
  DESKS.forEach(d => { counts[d.key] = byNum.filter(c => c.status === d.key).length; });
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

  /* ---- desks ---- */
  function deskBlock(desk) {
    const rows = byNum.filter(c => c.status === desk.key);
    if (!rows.length) {
      return `<tr><td style="padding:0 28px 14px;">
        <div style="border:1px solid ${C.line};border-radius:9px;padding:14px 16px;background:${C.soft};">
          <div style="font-size:14px;font-weight:700;color:${C.ink};">${esc(desk.who)}
            <span style="font-weight:400;color:${C.faint};font-size:12px;">· ${esc(desk.role)}</span></div>
          <div style="font-size:12.5px;color:${C.faint};margin-top:6px;">Nothing on this desk today.</div>
        </div></td></tr>`;
    }
    const items = rows.map(c => {
      const od = overdueLabel(now, c);
      const due = daysFrom(now, c.due);
      return `<tr><td style="padding:12px 0;border-top:1px solid ${C.line};">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:14px;font-weight:700;color:${C.ink};">${esc(c.company)}</td>
          <td align="right" style="font-size:11px;color:${C.faint};font-family:${MONO};">
            ${c.owner ? 'owner ' + esc(c.owner) : ''}${c.due ? ' · due ' + esc(c.due) : ''}
            ${due !== null && due <= 7 ? ` <span style="color:${C.crit};font-weight:700;">${due < 0 ? Math.abs(due) + 'd late' : due + 'd'}</span>` : ''}
          </td></tr></table>
        ${od ? `<div style="font-size:11.5px;color:${C.crit};font-weight:600;margin-top:3px;">${esc(od)}</div>` : ''}
        ${c.legal_req && desk.key === 'Pending legal'
          ? `<div style="font-size:12.5px;color:${C.mid};margin-top:6px;">
               <b style="color:${C.ink};">The ask:</b> ${esc(c.legal_req)}</div>` : ''}
        <div style="font-size:12.5px;color:${C.mid};margin-top:6px;">
          <b style="color:${C.ink};">To close:</b></div>
        <div style="font-size:12.5px;color:${C.mid};margin-top:2px;">${bullets(c.next_action, C.faint)}</div>
      </td></tr>`;
    }).join('');

    return `<tr><td style="padding:0 28px 14px;">
      <div style="border:1px solid ${C.line};border-radius:9px;overflow:hidden;">
        <div style="background:${C.soft};padding:12px 16px;border-bottom:1px solid ${C.line};">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:14px;font-weight:700;color:${C.ink};">${esc(desk.who)}
              <span style="font-weight:400;color:${C.faint};font-size:12px;">· ${esc(desk.role)}</span></td>
            <td align="right">${pill(rows.length + ' item' + (rows.length === 1 ? '' : 's'),
                                     ...statusTone(desk.key).slice(0, 2))}</td>
          </tr></table>
          <div style="font-size:12px;color:${C.faint};margin-top:4px;">${esc(desk.lead)}</div>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 16px 4px;">${items}</table>
      </div></td></tr>`;
  }

  /* ---- what moved ---- */
  const movedBlock = moved.length
    ? moved.map(h => `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:12.5px;font-weight:700;color:${C.ink};">${esc(h.company || 'General')}</td>
          <td align="right" style="font-size:11px;color:${C.faint};font-family:${MONO};">
            ${esc(dmy(h.entry_date))}${h.source ? ' · ' + esc(h.source) : ''}</td>
        </tr></table>
        <div style="font-size:12.5px;color:${C.mid};margin-top:3px;">${bullets(h.entry, C.faint)}</div>
      </td></tr>`).join('')
    : `<tr><td style="padding:10px 0;font-size:12.5px;color:${C.faint};">
         Nothing logged since yesterday.</td></tr>`;

  /* ---- roster ---- */
  const roster = byNum.map(c => {
    const [fg, bg] = statusTone(c.status);
    const od = overdueDays(now, c);
    const last = latestEntry(history, c);
    return `<tr>
      <td style="padding:10px 8px 10px 0;border-top:1px solid ${C.line};vertical-align:top;width:120px;">
        <div style="font-size:13px;font-weight:700;color:${C.ink};">${esc(c.company)}</div>
        <div style="font-size:10.5px;color:${C.faint};margin-top:2px;">${esc(c.bucket || '')}</div>
      </td>
      <td style="padding:10px 8px;border-top:1px solid ${C.line};vertical-align:top;width:132px;">
        ${pill(c.status || '—', fg, bg)}
        <div style="font-size:10.5px;color:${C.faint};margin-top:4px;">${esc(c.next_trigger || '—')}</div>
      </td>
      <td style="padding:10px 8px;border-top:1px solid ${C.line};vertical-align:top;width:96px;
                 font-family:${MONO};font-size:11px;color:${C.mid};">
        ${esc(dmy(effMaturity(c)))}
        ${od !== null ? `<div style="color:${C.crit};font-weight:700;margin-top:2px;">
            ${Math.floor(od / 30.44) >= 1 ? Math.floor(od / 30.44) + 'mo late' : od + 'd late'}</div>` : ''}
      </td>
      <td style="padding:10px 0 10px 8px;border-top:1px solid ${C.line};vertical-align:top;
                 font-size:12px;color:${C.mid};">
        ${last ? `<div style="font-size:10.5px;color:${C.faint};font-family:${MONO};margin-bottom:2px;">
                    ${esc(dmy(last.entry_date))}${last.source ? ' · ' + esc(last.source) : ''}</div>
                  ${bullets(last.entry, C.faint)}`
               : `<span style="color:${C.faint};">No history logged.</span>`}
      </td></tr>`;
  }).join('');

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
<title>BMV Portfolio Brief</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.ink};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:22px 12px;">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:${C.card};
       border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(28,21,23,.08);">

  <tr><td style="background:${C.maroon};padding:22px 28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
                color:${C.gold};">BM Ventures</div>
    <div style="font-size:22px;font-weight:700;color:#fff;margin-top:5px;">Portfolio Brief</div>
    <div style="font-size:12.5px;color:rgba(255,255,255,.82);margin-top:3px;">
      ${esc(longDate(now))}${asOf ? ` · tracker as of ${esc(asOf)}` : ''}</div>
  </td></tr>

  <tr><td style="padding:22px 28px 4px;">
    <div style="font-size:15px;line-height:1.55;color:${C.ink};font-weight:600;">${esc(topline)}</div>
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

  ${section('Moved since yesterday', moved.length ? `${moved.length} entr${moved.length === 1 ? 'y' : 'ies'} logged` : '')}
  <tr><td style="padding:0 28px;"><table width="100%" cellpadding="0" cellspacing="0">${movedBlock}</table></td></tr>

  ${section('Desks', 'Grouped by who holds the ball, not by who owns the relationship')}
  ${DESKS.map(deskBlock).join('')}

  ${section('Clocks', 'Past maturity, and reviews due inside seven days')}
  <tr><td style="padding:0 28px;"><table width="100%" cellpadding="0" cellspacing="0">${clocks}</table></td></tr>

  ${section('Every company', 'Status, what converts it, the governing maturity, and the last thing logged')}
  <tr><td style="padding:0 28px 8px;"><table width="100%" cellpadding="0" cellspacing="0">${roster}</table></td></tr>

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

  return { html, subject, topline, counts, overdue: overdue.length, moved: moved.length };
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
  const asOf = (settings.find(s => s.key === 'asOf') || {}).value;
  return { companies, history, asOf: typeof asOf === 'string' ? asOf : '' };
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
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    const supplied = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
    if (supplied !== CRON_SECRET) return res.status(401).send('Unauthorized');
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  let brief;
  try {
    const data = await loadTracker(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    brief = buildBrief({ ...data, today: new Date() });
  } catch (err) {
    return res.status(502).send(`Could not build the brief: ${err.message}`);
  }

  if (preview) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(brief.html);
  }

  if (!RESEND_API_KEY) return res.status(500).send('RESEND_API_KEY is not set.');

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: BRIEF_FROM || 'BMV Portfolio <onboarding@resend.dev>',
      to: [BRIEF_TO || DEFAULT_TO],
      subject: brief.subject,
      html: brief.html,
    }),
  });
  if (!send.ok) return res.status(502).send(`Resend ${send.status}: ${await send.text()}`);

  return res.status(200).json({
    sent: true, to: BRIEF_TO || DEFAULT_TO, subject: brief.subject,
    counts: brief.counts, overdue: brief.overdue, moved: brief.moved,
  });
}
