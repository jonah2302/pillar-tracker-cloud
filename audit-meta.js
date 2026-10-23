/* Full audit: every figure inside the built tracker file vs Meta, queried fresh.
 *
 * Reads the numbers straight out of "Meta Ads Tracker - OFFLINE.html" (what you
 * actually open) and asks Meta separately — one question per period, never
 * re-using the daily pull — for:
 *   - lifetime (date_preset=maximum), to catch any spend before the first day
 *   - every single day, per campaign
 *   - every Saturday–Friday week, per campaign (incl. the saved History weeks)
 *   - every calendar month, per campaign
 *   - the current week (what "This week" shows)
 *   - 25 random date ranges
 *   - lead names per campaign per day vs Meta's lead count
 * Spend must match to the cent and leads exactly. Today is still spending, so
 * anything that includes today is compared with a fresh pull made just before.
 *
 *   node audit-meta.js            -> prints the report, exit 1 on any mismatch
 *   node audit-meta.js --json F   -> also writes the expected figures to F
 *                                    (used by the in-browser page test) */
const fs = require('fs'), path = require('path'), https = require('https');
const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const tok = fs.readFileSync(path.join(DIR, 'meta-token.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))[0];
const LEAD = (CFG.leadActionTypes || ['onsite_conversion.lead_grouped'])[0];
const EXCL = new Set(CFG.excludeCampaigns || []);

/* ---- what the tracker file holds ---- */
const html = fs.readFileSync(path.join(DIR, 'Meta Ads Tracker - OFFLINE.html'), 'utf8');
const grab = name => JSON.parse(html.match(new RegExp('var ' + name + '=(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\});\\s*\\n'))[1]);
const ROWS = grab('SEED_ROWS'), SNAPS = grab('SEED_SNAPS'), DAYS = grab('SEED_DAYS');
const LEADS = JSON.parse(fs.readFileSync(path.join(DIR, 'leads.json'), 'utf8')).byCampaign;
const nameOfId = {}; ROWS.forEach(r => nameOfId[r.id] = r.name);

function fileRange(a, b) {               // what the page sums for a date range
  const by = {}; let s = 0, l = 0;
  Object.keys(DAYS).forEach(d => {
    if (d < a || d > b) return;
    Object.keys(DAYS[d]).forEach(nm => {
      const c = DAYS[d][nm]; s += c.spent; l += c.leads;
      by[nm] = by[nm] || { spent: 0, leads: 0 }; by[nm].spent += c.spent; by[nm].leads += c.leads;
    });
  });
  Object.values(by).forEach(v => v.spent = +v.spent.toFixed(2));
  return { spent: +s.toFixed(2), leads: l, by };
}
function namesIn(a, b) {
  const by = {}; let n = 0;
  Object.entries(LEADS).forEach(([nm, list]) => list.forEach(x => {
    if (x.date >= a && x.date <= b) { by[nm] = (by[nm] || 0) + 1; n++; }
  }));
  return { n, by };
}

/* ---- Meta ---- */
const get = u => new Promise((res, rej) => https.get(u, r => {
  let s = ''; r.on('data', d => s += d);
  r.on('end', () => { try { const j = JSON.parse(s); j.error ? rej(new Error(j.error.message)) : res(j); } catch (e) { rej(e); } });
}).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Meta briefly limits busy accounts ("request limit reached") — wait and retry */
const get0 = get;
async function getRetry(u) {
  for (let i = 0; ; i++) {
    try { return await get0(u); }
    catch (e) { if (i >= 5 || !/limit|too many|try again/i.test(e.message)) throw e; await sleep(60000 * (i + 1)); }
  }
}
async function meta(range) {             // range = {since,until} or 'maximum'
  let u = 'https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId + '/insights?level=campaign&limit=500'
    + '&fields=campaign_name,spend,actions,date_start,date_stop&access_token=' + encodeURIComponent(tok);
  u += range === 'maximum' ? '&date_preset=maximum' : '&time_range=' + encodeURIComponent(JSON.stringify(range));
  const out = { spent: 0, leads: 0, by: {}, start: null };
  while (u) {
    const j = await getRetry(u);
    (j.data || []).forEach(r => {
      if (EXCL.has(r.campaign_name)) return;
      let l = 0; (r.actions || []).forEach(x => { if (x.action_type === LEAD) l = +x.value; });
      out.spent += +r.spend; out.leads += l;
      out.by[r.campaign_name] = { spent: +(+r.spend).toFixed(2), leads: l };
      if (!out.start || r.date_start < out.start) out.start = r.date_start;
    });
    u = j.paging && j.paging.next; await sleep(150);
  }
  out.spent = +out.spent.toFixed(2);
  return out;
}

/* ---- dates ---- */
const P = s => new Date(s + 'T12:00:00Z'), Y = d => d.toISOString().slice(0, 10);
const add = (s, k) => { const d = P(s); d.setUTCDate(d.getUTCDate() + k); return Y(d); };
const satOf = s => { let d = s; while (P(d).getUTCDay() !== 6) d = add(d, -1); return d; };

(async () => {
  /* Today is still spending while the audit runs, so finished days are checked
     to the cent and today gets its own check (it may trail Meta by the few
     cents spent since the pull, but can never be ahead of it or different). */
  const last = Object.keys(DAYS).sort().pop();
  const tz = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.timeZone || 'America/Edmonton' }).format(new Date());
  const until = last >= tz ? add(tz, -1) : last;          // last FINISHED day
  const clip = e => e > until ? until : e;
  const first = CFG.firstDay;
  let checks = 0, bad = [], expected = { ranges: [] };
  const cmp = (label, mine, theirs, opts) => {
    checks++;
    const ok = mine.spent === theirs.spent && mine.leads === theirs.leads;
    let per = '';
    if (ok && !(opts && opts.noPer)) {                    // per campaign too
      const names = new Set(Object.keys(theirs.by).concat(Object.keys(mine.by || {})));
      names.forEach(nm => {
        const a = (mine.by || {})[nm] || { spent: 0, leads: 0 }, b = theirs.by[nm] || { spent: 0, leads: 0 };
        if (a.spent !== b.spent || a.leads !== b.leads) per += ' ' + nm + ' file $' + a.spent + '/' + a.leads + ' Meta $' + b.spent + '/' + b.leads + ';';
      });
    }
    if (!ok || per) bad.push(label + ': file $' + mine.spent.toFixed(2) + ' ' + mine.leads + ' leads, Meta $' + theirs.spent.toFixed(2) + ' ' + theirs.leads + ' leads' + (per ? ' |' + per : ''));
    return ok && !per;
  };

  // lifetime: nothing before the first day, and every finished day adds up
  const life = await meta('maximum');
  checks++;
  if (life.start && life.start < first) bad.push('Meta has spend from ' + life.start + ', before the tracker starts (' + first + ')');
  const lm = await meta({ since: first, until }), lf = fileRange('0000', until);
  cmp('LIFETIME through ' + until, lf, lm);
  console.log('Lifetime        file $' + lf.spent.toFixed(2) + ' / ' + lf.leads + ' leads   Meta $' + lm.spent.toFixed(2) + ' / ' + lm.leads + ' leads   (finished days to ' + until + '; first Meta day ' + life.start + ')');
  expected.lifetime = { spent: life.spent, leads: life.leads };

  // every day
  let dOk = 0, dN = 0;
  for (let d = first; d <= until; d = add(d, 1)) {
    const m = await meta({ since: d, until: d }); dN++;
    if (cmp('Day ' + d, fileRange(d, d), m)) dOk++;
  }
  console.log('Days            ' + dOk + ' of ' + dN + ' days match, every campaign, to the cent');

  // every week (Sat–Fri), incl. the running one
  let wOk = 0, wN = 0;
  for (let s = satOf(first); s <= until; s = add(s, 7)) {
    const e = add(s, 6), m = await meta({ since: s, until: clip(e) }); wN++;
    if (cmp('Week ' + s + (e > until ? ' (to ' + until + ')' : ''), fileRange(s, clip(e)), m)) wOk++;
    expected.ranges.push({ kind: 'week', from: s, to: e, spent: m.spent, leads: m.leads, by: m.by });
  }
  console.log('Weeks           ' + wOk + ' of ' + wN + ' Saturday–Friday weeks match');

  // saved History weeks (they hold their own copy of the figures)
  let hOk = 0, hN = 0;
  for (const sn of SNAPS.filter(x => x.periodStart)) {
    const m = await meta({ since: sn.periodStart, until: sn.periodEnd > until ? until : sn.periodEnd }); hN++;
    const by = {}; Object.entries(sn.rows || {}).forEach(([id, v]) => { if (+v.spent || +v.leads) by[v.name || nameOfId[id]] = { spent: +(+v.spent).toFixed(2), leads: +v.leads }; });
    const mine = { spent: +(+sn.totals.spent).toFixed(2), leads: +sn.totals.leads, by };
    if (cmp('History ' + sn.periodStart, mine, m)) hOk++;
  }
  console.log('History weeks   ' + hOk + ' of ' + hN + ' saved weeks match');

  // "This week" figures shown on each campaign row (finished days of the week;
  // today's share is checked below)
  const ws = satOf(last), today = last >= tz ? last : null;
  const tf = today ? fileRange(today, today) : { spent: 0, leads: 0, by: {} };
  const rowBy = {}; let rs = 0, rl = 0;
  ROWS.filter(r => r.pillar === 'meta').forEach(r => {
    const t = tf.by[r.name] || { spent: 0, leads: 0 }, s = +(+r.spent - t.spent).toFixed(2), l = +r.leads - t.leads;
    rs += s; rl += l; if (s || l) rowBy[r.name] = { spent: s, leads: l };
  });
  if (ws <= until) {
    const mw = await meta({ since: ws, until });
    cmp('This week (campaign rows, ' + ws + ' to ' + until + ')', { spent: +rs.toFixed(2), leads: rl, by: rowBy }, mw);
    console.log('This week       rows $' + rs.toFixed(2) + ' / ' + rl + ' leads   Meta $' + mw.spent.toFixed(2) + ' / ' + mw.leads + '   (' + ws + ' to ' + until + ')');
  } else { checks++; if (rs || rl) bad.push('This week rows hold figures from before today on a Saturday'); }
  const mwAll = await meta({ since: ws, until: last });
  expected.thisWeek = { from: ws, spent: mwAll.spent, leads: mwAll.leads, by: mwAll.by };

  // today, still running: the file may trail Meta by what was spent since the
  // pull, but must never be ahead of it, and every lead must have its name
  if (today) {
    const mt = await meta({ since: today, until: today }); checks++;
    let prob = '';
    new Set(Object.keys(mt.by).concat(Object.keys(tf.by))).forEach(nm => {
      const a = tf.by[nm] || { spent: 0, leads: 0 }, b = mt.by[nm] || { spent: 0, leads: 0 };
      if (a.spent > b.spent + 0.001 || a.leads > b.leads) prob += ' ' + nm + ' file $' + a.spent + '/' + a.leads + ' is AHEAD of Meta $' + b.spent + '/' + b.leads + ';';
    });
    const nmT = namesIn(today, today); if (nmT.n !== tf.leads) prob += ' ' + nmT.n + ' names for ' + tf.leads + ' leads;';
    if (prob) bad.push('Today ' + today + ':' + prob);
    console.log('Today (running) file $' + tf.spent.toFixed(2) + ' / ' + tf.leads + ' leads   Meta now $' + mt.spent.toFixed(2) + ' / ' + mt.leads +
      (prob ? '   PROBLEM' : '   ok — ' + (mt.spent > tf.spent ? '$' + (mt.spent - tf.spent).toFixed(2) + ' spent since the pull, picked up next run' : 'identical')));
  }

  // calendar months
  for (let m0 = first.slice(0, 7) + '-01'; m0 <= until; ) {
    const nx = Y(new Date(Date.UTC(+m0.slice(0, 4), +m0.slice(5, 7), 1, 12)));
    const e = add(nx, -1);
    if (m0 > until) break;
    const m = await meta({ since: m0, until: clip(e) }), f = fileRange(m0, clip(e));
    const ok = cmp('Month ' + m0.slice(0, 7), f, m);
    console.log(('Month ' + m0.slice(0, 7) + '                ').slice(0, 16) + 'file $' + f.spent.toFixed(2) + ' / ' + f.leads + '   Meta $' + m.spent.toFixed(2) + ' / ' + m.leads + '   ' + (ok ? 'MATCH' : 'MISMATCH') + (e > until ? '   (to ' + until + ')' : ''));
    expected.ranges.push({ kind: 'month', from: m0, to: e, spent: m.spent, leads: m.leads, by: m.by });
    m0 = nx;
  }

  // random ranges
  let seed = 7; const rnd = n => { seed = (seed * 9301 + 49297) % 233280; return Math.floor(seed / 233280 * n); };
  const span = Math.round((P(until) - P(first)) / 864e5);
  let rOk = 0;
  for (let i = 0; i < 25; i++) {
    const a = add(first, rnd(span + 1)), b = add(a, rnd(Math.max(1, Math.round((P(until) - P(a)) / 864e5)) + 1));
    const bb = b > until ? until : b, m = await meta({ since: a, until: bb });
    if (cmp('Range ' + a + '..' + bb, fileRange(a, bb), m)) rOk++;
    expected.ranges.push({ kind: 'custom', from: a, to: bb, spent: m.spent, leads: m.leads, by: m.by });
  }
  console.log('Random ranges   ' + rOk + ' of 25 match');

  // lead names vs counts, per campaign per day
  let nOk = 0, nN = 0;
  for (let d = first; d <= until; d = add(d, 1)) {
    const f = fileRange(d, d), nm = namesIn(d, d); nN++;
    let ok = nm.n === f.leads;
    Object.keys(f.by).forEach(c => { if ((nm.by[c] || 0) !== f.by[c].leads) ok = false; });
    if (ok) nOk++; else bad.push('Names ' + d + ': ' + nm.n + ' names, ' + f.leads + ' leads ' + JSON.stringify(nm.by));
    checks++;
  }
  console.log('Lead names      ' + nOk + ' of ' + nN + ' days: every lead counted has its name, under the right campaign');

  // Active / Paused on every campaign row = Meta's on/off switch right now
  const sj = await getRetry('https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId +
    '/campaigns?limit=200&fields=name,effective_status,ads.limit(100){effective_status}&access_token=' + encodeURIComponent(tok));
  const onNow = {}; (sj.data || []).forEach(c => onNow[c.name] = c.effective_status === 'ACTIVE' && ((c.ads && c.ads.data) || []).some(a => a.effective_status === 'ACTIVE'));
  let sOk = 0, sN = 0;
  ROWS.filter(r => r.pillar === 'meta' && r.name in onNow).forEach(r => {
    sN++; checks++;
    const want = onNow[r.name] ? 'live' : 'paused';
    if ((r.status === 'live' ? 'live' : 'paused') === want) sOk++;
    else bad.push('Status ' + r.name + ': tracker says ' + (r.status === 'live' ? 'Active' : 'Paused') + ', Meta says ' + (want === 'live' ? 'Active' : 'Paused'));
  });
  console.log('Active / Paused ' + sOk + ' of ' + sN + ' campaigns match Meta (running: ' + (Object.keys(onNow).filter(n => onNow[n] && !EXCL.has(n)).join(', ') || 'none') + ')');

  console.log('\n' + checks + ' checks, ' + bad.length + ' mismatch' + (bad.length === 1 ? '' : 'es'));
  bad.forEach(b => console.log('  MISMATCH ' + b));
  const ji = process.argv.indexOf('--json');
  if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(expected));
  process.exitCode = bad.length ? 1 : 0;
})().catch(e => { console.log('ERROR', e.message); process.exitCode = 1; });
