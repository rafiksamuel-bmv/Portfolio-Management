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
 *   PDFSHIFT_API_KEY            optional; attaches a PDF when set
 *   CRON_SECRET                 set by Vercel; also accepted as ?key= for previews
 */

const DEFAULT_TO = 'rafiksamuel@aucegypt.edu';

/* Desks come from `owner`, not from `status`. The two answer different
   questions: status is who holds the ball (us, counsel, or the company), owner
   is which of us has to move it. They are independent -- an item Reem has
   asked Mina to send to Shawarby is "Pending our action" sitting on Mina's
   desk, which a status-derived desk could not express. */
const DESKS = [
  { who: 'Mina',  role: 'counsel liaison',
    lead: 'Everything that goes to or comes back from El-Shawarby.' },
  { who: 'Rafik', role: 'company outreach',
    lead: 'Everything that goes to or comes back from the companies.' },
  { who: 'Reem',  role: 'decisions & Mr. Mohamed',
    lead: 'Calls to make, and anything that needs Mr. Mohamed.' },
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

  function deskItem(c) {
    const od = overdueLabel(now, c);
    const due = daysFrom(now, c.due);
    const hot = due !== null && due <= 7;
    const last = latestEntry(history, c);
    const actions = toLines(c.next_action);
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

  function deskBlock(desk) {
    const rows = byNum.filter(c => (c.owner || '').trim() === desk.who);
    const head = `
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:17px;font-weight:700;color:${C.ink};letter-spacing:-.01em;">
          ${esc(desk.who)}
          <span style="font-weight:400;color:${C.faint};font-size:12.5px;">
            · ${esc(desk.role)}</span></td>
        <td align="right">${pill(rows.length ? rows.length + (rows.length === 1 ? ' item' : ' items')
                                              : 'clear',
                                 rows.length ? C.maroon : C.ok,
                                 rows.length ? C.page : C.okBg)}</td>
      </tr></table>
      <div style="font-size:12px;color:${C.faint};margin-top:4px;">${esc(desk.lead)}</div>`;

    if (!rows.length) {
      return `<tr><td style="padding:0 28px 16px;">
        <div style="border:1px solid ${C.line};border-radius:10px;padding:15px 18px;
                    background:${C.soft};">${head}
          <div style="font-size:13px;color:${C.faint};margin-top:10px;">
            Nothing waiting on ${esc(desk.who)} today.</div>
        </div></td></tr>`;
    }

    return `<tr><td style="padding:0 28px 16px;">
      <div style="border:1px solid ${C.line};border-radius:10px;overflow:hidden;">
        <div style="background:${C.soft};padding:14px 18px;border-bottom:1px solid ${C.line};">
          ${head}</div>
        <table width="100%" cellpadding="0" cellspacing="0"
               style="padding:0 18px 6px;">${rows.map(deskItem).join('')}</table>
      </div></td></tr>`;
  }

  /* Nothing should fall off the brief because its owner is blank or is
     somebody other than the three desks. */
  function orphanBlock() {
    const named = DESKS.map(d => d.who);
    const rows = byNum.filter(c => named.indexOf((c.owner || '').trim()) === -1);
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
            No owner set, so nobody is holding these. Set an owner in the tracker.</div>
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
      ${esc(longDate(now))}${lastEdited ? ` · last edited ${esc(lastEdited)}` : ''}</div>
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

  /* PDF is optional. Without a key the email still goes as HTML, which is
     what most clients render best anyway. */
  let attachments;
  let pdfNote = 'not configured';
  if (process.env.PDFSHIFT_API_KEY) {
    try {
      const pdf = await toPdf(brief.html, process.env.PDFSHIFT_API_KEY);
      attachments = [{
        filename: `portfolio-brief-${ymd(new Date())}.pdf`,
        content: Buffer.from(pdf).toString('base64'),
      }];
      pdfNote = 'attached';
    } catch (err) {
      pdfNote = `failed: ${err.message}`;   // never block the email on the PDF
    }
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

/* HTML to PDF via PDFShift. Swapping providers means changing this one
   function: everything else deals in HTML. */
async function toPdf(html, key) {
  const res = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source: html, landscape: false, format: 'A4', margin: '12mm' }),
  });
  if (!res.ok) throw new Error(`PDFShift ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}
