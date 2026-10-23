/*  build-from-data.js — turn meta-data.json into the finished offline file.
 *
 *  Reads the daily figures pulled from Meta, writes them into the tracker as
 *  the current week plus a full week-by-week history, then embeds the fonts so
 *  the result opens anywhere with no internet.
 *
 *  Any client counts already recorded in the tracker are preserved: this script
 *  never overwrites them, because Meta does not know about them.
 *
 *  Usage:  node build-from-data.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const DATA = JSON.parse(fs.readFileSync(path.join(DIR, 'meta-data.json'), 'utf8'));

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parse = s => { const p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); };
const today = () => { const n = new Date(); return ymd(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 12))); };
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const short = s => { const d = parse(s); return M[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const weekLabel = w => 'Sat ' + short(w.start) + ' – Fri ' + short(w.end);
const money = v => '$' + Number(v).toFixed(2);

/* stable document id per campaign */
const ids = Object.assign({}, CFG.campaignIds);
function idFor(name) {
  if (ids[name]) return ids[name];
  const slug = 'meta_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28);
  ids[name] = slug;
  return slug;
}

/* previously built file — read first, so campaigns and hand-entered values survive */
const trackerPath0 = path.join(DIR, 'Marketing Pillar Tracker.html');
const existing = {};
const previousNames = [];
if (fs.existsSync(trackerPath0)) {
  const m = fs.readFileSync(trackerPath0, 'utf8').match(/var SEED_ROWS=(\[[\s\S]*?\]);\s*\nvar SEED_SNAPS=/);
  if (m) {
    try {
      JSON.parse(m[1]).forEach(r => { existing[r.id] = r; if (r.name) previousNames.push(r.name); });
    } catch (e) { console.log('note: could not read previous seeds (' + e.message + ') — starting clean'); }
  }
}

/* Every campaign we know about. Meta returns NO rows for a campaign that has
 * never spent — a brand new or in-review one — so those must be carried over
 * from the config and the previous build or they would silently disappear. */
const allNames = [];
const addName = n => { if (n && allNames.indexOf(n) < 0) allNames.push(n); };
DATA.weeks.forEach(w => Object.keys(w.campaigns).forEach(addName));
Object.keys(CFG.campaignIds).forEach(addName);
previousNames.forEach(addName);

const t = today();
const complete = DATA.weeks.filter(w => w.end < t);
const current = DATA.weeks.filter(w => w.end >= t)[0] || null;

/* ---- history snapshots ---- */
const snaps = complete.map(w => {
  const rows = {};
  allNames.forEach(n => {
    const c = w.campaigns[n] || { spent: 0, leads: 0 };
    rows[idFor(n)] = { name: n, spent: +c.spent.toFixed(2), leads: c.leads, clients: 0 };
  });
  return {
    id: 'wk_' + w.start.replace(/-/g, ''),
    label: 'Week of ' + weekLabel(w),
    periodStart: w.start, periodEnd: w.end,
    takenAt: w.end + 'T12:00:00.000Z',
    count: allNames.length,
    rows,
    totals: { budget: 0, spent: +w.spent.toFixed(2), leads: w.leads, clients: 0 }
  };
});

/* ---- current-week rows ---- */
const prev = complete[complete.length - 1] || null;
function lifetimeOf(name) {
  let s = 0, l = 0;
  DATA.weeks.forEach(w => { const c = w.campaigns[name]; if (c) { s += c.spent; l += c.leads; } });
  return { spent: s, leads: l };
}
/* the first day this campaign actually spent anything — its real start date */
function firstRanOf(name) {
  const days = Object.keys(DATA.days).sort();
  for (const d of days) {
    const c = DATA.days[d] && DATA.days[d][name];
    if (c && (+c.spent || 0) > 0) return d;
  }
  return '';
}
const trackerPath = trackerPath0;

const rows = allNames.map(name => {
  const c = (current && current.campaigns[name]) || { spent: 0, leads: 0, impressions: 0, reach: 0 };
  const life = lifetimeOf(name);
  const cpl = c.leads ? c.spent / c.leads : null;
  const lcpl = life.leads ? life.spent / life.leads : null;
  const running = c.spent > 0;
  /* Active / Paused is Meta's own on/off switch (pull-meta.js), never guessed from spend */
  const st = (DATA.statuses || {})[name];
  const live = st ? st.running : running;
  const bits = [];
  bits.push('THIS WEEK (' + (current ? weekLabel(current) : 'no current week') + ', still running — figures through ' + short(t) + ').');
  if (running) {
    bits.push('Spent ' + money(c.spent) + ' for ' + c.leads + ' lead' + (c.leads === 1 ? '' : 's') +
      (cpl ? ' at ' + money(cpl) + ' each' : ' — no leads yet') + '.');
    bits.push('Impressions ' + Math.round(c.impressions).toLocaleString() + ', reach ' + Math.round(c.reach).toLocaleString() + '.');
  } else {
    bits.push('No delivery this week.');
  }
  bits.push('Lifetime ' + money(life.spent) + ' / ' + life.leads + ' lead' + (life.leads === 1 ? '' : 's') +
    (lcpl ? ' = ' + money(lcpl) + ' each' : '') + '.');
  bits.push('Pulled from the Meta Marketing API on ' + short(t) + ', ' + t.slice(0, 4) + '.');

  return {
    id: idFor(name), pillar: 'meta', segment: 'prospect', name: name,
    about: '', status: live ? 'live' : 'paused',
    start: current ? current.start : t, end: current ? current.end : t,
    firstRan: firstRanOf(name),
    source: (CFG.defaultSource || ''),
    leadList: '',
    leadRecords: [],
    ageRange: '', gender: 'All', leadAges: '', ageSpend: '', audience: '', areas: 'Alberta',
    budget: 0, spent: +c.spent.toFixed(2), leads: c.leads,
    clients: 0, clientNotes: '', notes: bits.join(' ')
  };
});

/* lead names pulled from the forms, matched to their campaign */
let LEADS = {};
try {
  const lp = path.join(DIR, 'leads.json');
  if (fs.existsSync(lp)) LEADS = (JSON.parse(fs.readFileSync(lp, 'utf8')).byCampaign) || {};
} catch (e) { console.log('note: leads.json unreadable (' + e.message + ')'); }
rows.forEach(r => {
  const found = LEADS[r.name];
  if (!found) return;
  const prior = {};
  const was = existing[r.id];
  if (was && Array.isArray(was.leadRecords))
    was.leadRecords.forEach(x => { if (x.id) prior[x.id] = x; });
  /* keep the quality tag and agent the user set; refresh everything else */
  r.leadRecords = found.map(L => ({
    id: L.id, name: L.name, date: L.date, time: L.time || '',
    agent: (prior[L.id] && prior[L.id].agent) || L.agent || '',
    quality: (prior[L.id] && prior[L.id].quality) || 'new'
  }));
});
/* Agents come from Sierra (agents.json, keyed by Meta lead id). Sierra is the
 * source of truth for who a lead went to. */
let AGENTS = {};
try {
  const ap = path.join(DIR, 'agents.json');
  if (fs.existsSync(ap)) AGENTS = JSON.parse(fs.readFileSync(ap, 'utf8'));
} catch (e) { console.log('note: agents.json unreadable (' + e.message + ')'); }
rows.forEach(r => (r.leadRecords || []).forEach(x => {
  const a = AGENTS[x.id];
  if (!a) return;
  if (a.agent) x.agent = a.agent;
  x.sierra = a.status;
}));

/* Carry over everything Meta does not know about: client counts, the notes
 * about who closed, the creative description, and any demographic detail
 * entered by hand. Meta owns spend and leads; the user owns the rest. */
rows.forEach(r => {
  const e = existing[r.id];
  if (!e) return;
  if (e.clients) r.clients = e.clients;
  if (e.clientNotes) r.clientNotes = e.clientNotes;
  if (e.about) r.about = e.about;
  if (e.areas) r.areas = e.areas;
  if (e.segment) r.segment = e.segment;
  if (e.budget) r.budget = e.budget;
  if (e.ageSpend) { r.ageSpend = e.ageSpend; r.leadAges = e.leadAges || ''; }
  if (e.gender) r.gender = e.gender;
  /* Meta knows none of these — whatever was typed in wins */
  if (e.source) r.source = e.source;
  if (e.leadList) r.leadList = e.leadList;
  /* Fresh names from leads.json always win; the earlier merge already kept
   * each lead's tag and agent. Only fall back to the old list if Meta could
   * not be read this time. */
  if ((!r.leadRecords || !r.leadRecords.length) && Array.isArray(e.leadRecords) && e.leadRecords.length)
    r.leadRecords = e.leadRecords;
  if (e.firstRan && !r.firstRan) r.firstRan = e.firstRan;
});

/* ---- rebuild ---- */
execFileSync(process.execPath, ['build-standalone.js'], { cwd: DIR, stdio: 'inherit' });

let html = fs.readFileSync(trackerPath, 'utf8');
const re = /var SEED_ROWS=\[[\s\S]*?\];\s*\nvar SEED_SNAPS=\[[\s\S]*?\];/;
if (!re.test(html)) throw new Error('seed block not found in Marketing Pillar Tracker.html');
const excludedNames = new Set(CFG.excludeCampaigns || []);
/* every day's figures — months and custom date ranges are summed from these */
const dayKeys = Object.keys(DATA.days).sort();
const seedDays = {};
dayKeys.forEach(d => {
  const o = {};
  Object.keys(DATA.days[d] || {}).forEach(nm => {
    const c = DATA.days[d][nm] || {};
    if (excludedNames.has(nm)) return;
    o[nm] = { id: idFor(nm), spent: +(+c.spent || 0).toFixed(2), leads: +c.leads || 0 };
  });
  seedDays[d] = o;
});
/* the same daily figures, one file per month, for the Claude link's "daily" collection */
const dailyDir = path.join(DIR, 'daily-db');
if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir);
const byMonth = {};
Object.keys(seedDays).forEach(d => { const m = d.slice(0, 7); (byMonth[m] = byMonth[m] || {})[d] = seedDays[d]; });
Object.keys(byMonth).forEach(m => fs.writeFileSync(path.join(dailyDir, m + '.json'), JSON.stringify({ month: m, days: byMonth[m], pulledAt: DATA.pulledAt || '' })));
/* Sierra follow-up figures (sierra-sync.js) — counts and times only */
let SIERRA = null;
try {
  const sp = path.join(DIR, 'sierra.json');
  if (fs.existsSync(sp)) {
    const S = JSON.parse(fs.readFileSync(sp, 'utf8'));
    /* agents left out of the Whole team table (config.json: sierraHideAgents) */
    const hide = new Set(CFG.sierraHideAgents || []), team = {};
    Object.entries(S.team || {}).forEach(([k, t]) => { team[k] = Object.assign({}, t, { agents: (t.agents || []).filter(g => !hide.has(g.name)) }); });
    SIERRA = { pulledAt: S.pulledAt, leads: S.leads, other: S.other || {}, team, hide: CFG.sierraHideAgents || [] };
    /* every call by day/agent/lead, and Sierra's accountability numbers by day —
       the Whole team table adds these up for whatever dates are picked */
    if (S.calls) {
      SIERRA.calls = {}; Object.entries(S.calls).forEach(([k, v]) => { if (!hide.has(k.split('|')[1])) SIERRA.calls[k] = v; });
      SIERRA.callsFrom = S.callsFrom;
    }
    if (S.days) {
      SIERRA.days = {}; Object.entries(S.days).forEach(([d, rows]) => { SIERRA.days[d] = rows.filter(g => !hide.has(g[0])); });
    }
    /* Sierra API (sierra-api.js, every 15 min from Windows): new leads and agent
       changes show up right away. Leads the hourly check has not read yet are
       marked "pending" — their calls/texts/emails are confirmed next hour. */
    const ap = path.join(DIR, 'sierra-api.json');
    if (fs.existsSync(ap)) {
      const A = JSON.parse(fs.readFileSync(ap, 'utf8'));
      if (Date.now() - Date.parse(A.at) < 36 * 3600e3) {
        const zero = () => ({ calls: { out: 0, in: 0, talk: 0 }, texts: { out: 0, in: 0 }, emails: { out: 0, in: 0 }, first: '', last: '', by: {} });
        Object.entries(A.meta || {}).forEach(([id, sid]) => {
          const cur = SIERRA.leads[id], a = A.leads[sid] || {};
          if (!cur || cur.status !== 'ok') SIERRA.leads[id] = Object.assign({ status: 'ok', sid, agent: a.agent || '', pending: true }, zero());
          else if (a.agent) cur.agent = a.agent;
        });
        const metaSids = new Set(Object.values(SIERRA.leads).map(r => r.sid).filter(Boolean));
        Object.entries(A.leads || {}).forEach(([sid, a]) => {
          if (metaSids.has(+sid) || !a.signup || a.signup.slice(0, 10) < CFG.firstDay) return;
          const cur = SIERRA.other[sid];
          if (!cur) SIERRA.other[sid] = Object.assign({ name: a.name, src: a.src, detail: '', agent: a.agent, signup: a.signup, reg: a.signup.slice(0, 10), pending: true }, zero());
          else { if (a.agent) cur.agent = a.agent; cur.signup = a.signup; cur.reg = a.signup.slice(0, 10); }
        });
        SIERRA.apiAt = A.at;
      }
    }
    fs.writeFileSync(path.join(dailyDir, 'sierra.json'), JSON.stringify(SIERRA));   // for the Claude link
  }
} catch (e) { console.log('note: sierra.json unreadable (' + e.message + ')'); }
html = html.replace(re,
  'var SEED_ROWS=' + JSON.stringify(rows) + ';\n' +
  'var SEED_SNAPS=' + JSON.stringify(snaps) + ';\n' +
  'var SEED_DAYS=' + JSON.stringify(seedDays) + ';' +
  (SIERRA ? '\nvar SEED_SIERRA=' + JSON.stringify(SIERRA).replace(/</g, '\\u003c') + ';' : '') +
  '\nvar SEED_UPDATED=' + JSON.stringify(DATA.pulledAt || '') + ';');
fs.writeFileSync(trackerPath, html, 'utf8');

const outName = 'Meta Ads Tracker - OFFLINE.html';
fs.copyFileSync(trackerPath, path.join(DIR, outName));
execFileSync(process.execPath, ['embed-fonts.js', outName], { cwd: DIR, stdio: 'inherit' });

/* ---- publish to the shared folder ---- */
/* The same verified file is copied to a synced Drive folder, so the link the
 * team lead has always serves this morning's build. Only ever copied AFTER
 * the offline check below passes. */
const SHARE_DIR = 'G:\\My Drive\\Meta Ads Tracker';
const SHARE_NAME = 'Meta Ads Tracker.html';

/* ---- prove it ---- */
const final = fs.readFileSync(path.join(DIR, outName), 'utf8');
const ext = (final.match(/(?:href|src)="https?:\/\/[^"]+/g) || []);
const curTot = rows.reduce((a, r) => ({ s: a.s + r.spent, l: a.l + r.leads }), { s: 0, l: 0 });
const allTot = DATA.weeks.reduce((a, w) => ({ s: a.s + w.spent, l: a.l + w.leads }), { s: 0, l: 0 });

console.log('\n================ built ================');
console.log('campaigns      : ' + rows.length);
console.log('days of detail  : ' + dayKeys.length);
console.log('weeks in history: ' + snaps.length + (current ? '  (+1 still running)' : ''));
console.log('this week      : ' + money(curTot.s) + '  ' + curTot.l + ' leads'
  + (curTot.l ? '  ' + money(curTot.s / curTot.l) + ' per lead' : ''));
if (prev) console.log('week before    : ' + money(prev.spent) + '  ' + prev.leads + ' leads'
  + (prev.leads ? '  ' + money(prev.spent / prev.leads) + ' per lead' : ''));
console.log('all time       : ' + money(allTot.s) + '  ' + allTot.l + ' leads');
console.log('external refs  : ' + (ext.length ? ext.join(', ') : 'none'));
console.log('file           : ' + path.join(DIR, outName));
if (ext.length) { console.error('\nREFUSED: the file is not fully offline.'); process.exit(1); }

/* Copy to the synced Drive folder only AFTER the offline check passes, so a
 * broken build is never what the shared link serves. */
let shared;
try {
  if (process.argv.includes('--no-share')) {
    shared = 'not copied yet (--no-share: daily-run.js copies it after the audit passes)';
  } else if (fs.existsSync(SHARE_DIR)) {
    fs.copyFileSync(path.join(DIR, outName), path.join(SHARE_DIR, SHARE_NAME));
    shared = path.join(SHARE_DIR, SHARE_NAME);
  } else {
    shared = 'SKIPPED — ' + SHARE_DIR + ' not reachable (Drive not running?)';
  }
} catch (e) { shared = 'FAILED — ' + e.message; }
console.log('shared copy    : ' + shared);
console.log('======================================\n');
