/*  pull-meta.js — fetch daily Meta ad figures straight from the Marketing API.
 *
 *  Daily granularity matters: with a figure for every single day, any week,
 *  month or custom range is an exact sum. Nothing is estimated or apportioned.
 *
 *  Token: read from meta-token.txt (first line) or the META_TOKEN environment
 *  variable. It is never printed, never written to the data file, and never
 *  leaves this machine except in the call to Meta.
 *
 *  Usage:  node pull-meta.js            pull from config.firstDay to today
 *          node pull-meta.js --check    pull, verify, report, write nothing
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const CHECK_ONLY = process.argv.includes('--check');

/* ---------- token ---------- */
function readToken() {
  if (process.env.META_TOKEN && process.env.META_TOKEN.trim()) return process.env.META_TOKEN.trim();
  const f = path.join(DIR, 'meta-token.txt');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))[0];
    if (t) return t;
  }
  console.error('\nNo access token found.');
  console.error('Put it on the first line of:  ' + path.join(DIR, 'meta-token.txt'));
  console.error('or set the META_TOKEN environment variable. See SETUP.md.\n');
  process.exit(2);
}

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parse = s => { const p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); };
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function today() { const n = new Date(); return ymd(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 12))); }
function weekStartOf(s) { const d = parse(s); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1); return ymd(d); }

/* ---------- http ---------- */
function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let j; try { j = JSON.parse(body); } catch (e) { return rej(new Error('Meta returned something that is not JSON (HTTP ' + r.statusCode + ')')); }
        if (j.error) {
          const e = j.error;
          let hint = '';
          if (e.code === 190) hint = '  -> the token is expired or invalid. Generate a new one (SETUP.md).';
          if (e.code === 10 || e.code === 200) hint = '  -> the token lacks ads_read permission for this ad account.';
          if (e.code === 17 || e.code === 4) hint = '  -> Meta is rate limiting. Wait a few minutes and run again.';
          return rej(new Error('Meta API error ' + e.code + ': ' + e.message + hint));
        }
        res(j);
      });
    }).on('error', rej);
  });
}

/* ---------- pull ---------- */
async function pullDaily(token, since, until) {
  const fields = ['campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'actions', 'date_start'].join(',');
  let url = 'https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId + '/insights'
    + '?level=campaign&time_increment=1&limit=500'
    + '&fields=' + encodeURIComponent(fields)
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&access_token=' + encodeURIComponent(token);

  const out = [];
  let page = 0;
  while (url) {
    const j = await getJson(url);
    (j.data || []).forEach(r => out.push(r));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
    if (++page > 60) throw new Error('too many pages from Meta — aborting rather than looping');
  }
  /* Meta fault (seen Oct 21, 2026): the day-by-day breakdown can come back with
     spend "0" on every row while a single-date question returns the real
     amount. If every row says $0 but ads clearly ran, ask for each day on its
     own instead — same figures, just one question per day. */
  const spent = out.reduce((a, r) => a + (+r.spend || 0), 0);
  const tot = await getJson('https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId + '/insights?level=account&fields=spend'
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until })) + '&access_token=' + encodeURIComponent(token));
  const whole = +((tot.data && tot.data[0] && tot.data[0].spend) || 0);
  if (Math.abs(whole - spent) > 0.02) {   /* (includes excluded campaigns on both sides, so they must agree) */
    console.log('note: Meta returned $0 spend in its day-by-day breakdown — asking for each day separately');
    const days = [...new Set(out.map(r => r.date_start))].sort();
    const fixed = [];
    for (const d of days) {
      const u = 'https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId + '/insights?level=campaign&limit=500'
        + '&fields=' + encodeURIComponent('campaign_id,campaign_name,spend,impressions,reach,actions')
        + '&time_range=' + encodeURIComponent(JSON.stringify({ since: d, until: d })) + '&access_token=' + encodeURIComponent(token);
      const j = await getJson(u);
      (j.data || []).forEach(r => fixed.push(Object.assign(r, { date_start: d })));
      await new Promise(r => setTimeout(r, 120));
    }
    return fixed;
  }
  return out;
}

function leadsFrom(actions) {
  if (!Array.isArray(actions)) return { n: 0, type: null };
  for (const want of CFG.leadActionTypes) {
    const hit = actions.find(a => a.action_type === want);
    if (hit) return { n: Number(hit.value) || 0, type: want };
  }
  return { n: 0, type: null };
}

(async () => {
  const token = readToken();
  const since = CFG.firstDay, until = today();
  console.log('Account   : ' + CFG.accountName + ' (' + CFG.accountId + ')');
  console.log('Range     : ' + since + ' to ' + until);
  console.log('Pulling daily figures from the Meta Marketing API...\n');

  const raw = await pullDaily(token, since, until);
  console.log('rows returned: ' + raw.length);

  const excluded = new Set(CFG.excludeCampaigns);
  const days = {};            // date -> campaignName -> {spent, leads, impressions, reach}
  const seenActionTypes = {};
  let skipped = 0;

  raw.forEach(r => {
    const name = r.campaign_name;
    if (excluded.has(name)) { skipped++; return; }
    const d = r.date_start;
    const L = leadsFrom(r.actions);
    if (L.type) seenActionTypes[L.type] = (seenActionTypes[L.type] || 0) + 1;
    (days[d] = days[d] || {});
    const slot = days[d][name] = days[d][name] || { spent: 0, leads: 0, impressions: 0, reach: 0, campaignId: r.campaign_id };
    slot.spent += Number(r.spend) || 0;
    slot.leads += L.n;
    slot.impressions += Number(r.impressions) || 0;
    slot.reach += Number(r.reach) || 0;
  });

  console.log('excluded rows (' + CFG.excludeCampaigns.join(', ') + '): ' + skipped);
  console.log('lead action types seen: ' + (Object.keys(seenActionTypes).length
    ? Object.entries(seenActionTypes).map(([k, v]) => k + ' x' + v).join(', ')
    : 'NONE — leads will all read zero, check leadActionTypes in config.json'));

  /* ---------- roll into Saturday weeks ---------- */
  const weeks = {};
  Object.keys(days).sort().forEach(d => {
    const w = weekStartOf(d);
    const bucket = weeks[w] = weeks[w] || { start: w, end: addDays(w, 6), campaigns: {}, spent: 0, leads: 0 };
    Object.entries(days[d]).forEach(([name, v]) => {
      const c = bucket.campaigns[name] = bucket.campaigns[name] || { spent: 0, leads: 0, impressions: 0, reach: 0 };
      c.spent += v.spent; c.leads += v.leads; c.impressions += v.impressions; c.reach += v.reach;
      bucket.spent += v.spent; bucket.leads += v.leads;
    });
  });
  const weekList = Object.values(weeks).sort((a, b) => a.start.localeCompare(b.start));

  console.log('\n--- weeks (Sat-Fri) ---');
  weekList.forEach(w => {
    const done = w.end < today();
    console.log('  ' + w.start + ' .. ' + w.end + '  $' + w.spent.toFixed(2).padStart(8)
      + '  ' + String(w.leads).padStart(3) + ' leads  '
      + (w.leads ? '$' + (w.spent / w.leads).toFixed(2) : '    -') + (done ? '' : '   <- in progress'));
  });

  /* ---------- reconcile against figures read from Ads Manager by hand ---------- */
  console.log('\n--- check against Ads Manager figures recorded on ' + CFG.knownGood.asOf + ' ---');
  let bad = 0;
  Object.entries(CFG.knownGood.weeks).forEach(([start, want]) => {
    const got = weeks[start];
    if (!got) { console.log('  MISSING  week ' + start); bad++; return; }
    const ds = Math.abs(got.spent - want.spent), dl = got.leads - want.leads;
    const ok = ds < 0.02 && dl === 0;
    if (!ok) bad++;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + start
      + '  api $' + got.spent.toFixed(2) + '/' + got.leads
      + '   manual $' + want.spent.toFixed(2) + '/' + want.leads
      + (ok ? '' : '   <-- MISMATCH'));
  });

  const total = weekList.reduce((a, w) => ({ spent: a.spent + w.spent, leads: a.leads + w.leads }), { spent: 0, leads: 0 });
  console.log('\n  API total   $' + total.spent.toFixed(2) + '  ' + total.leads + ' leads');
  console.log('  Manual total $' + CFG.knownGood.lifetime.spent.toFixed(2) + '  ' + CFG.knownGood.lifetime.leads + ' leads  (as of ' + CFG.knownGood.asOf + ', may be lower if days have passed)');

  if (bad) {
    console.log('\n' + bad + ' WEEK(S) DO NOT MATCH.');
    console.log('Nothing has been written. Most likely the lead action type is wrong —');
    console.log('check "lead action types seen" above against leadActionTypes in config.json.');
    process.exit(1);
  }
  console.log('\nEvery recorded week matches the API exactly.');

  if (CHECK_ONLY) { console.log('\n--check given: nothing written.'); return; }

  /* Active / Paused straight from Meta's on/off switches: a campaign counts as
     running only if the campaign AND at least one of its ads are ACTIVE. (Spend
     alone is not enough — a campaign paused mid-week still shows that week's spend.) */
  const st = await getJson('https://graph.facebook.com/' + CFG.apiVersion + '/act_' + CFG.accountId +
    '/campaigns?limit=200&fields=name,effective_status,ads.limit(100){effective_status}&access_token=' + encodeURIComponent(token));
  const statuses = {};
  (st.data || []).forEach(c => {
    const adOn = ((c.ads && c.ads.data) || []).some(a => a.effective_status === 'ACTIVE');
    statuses[c.name] = { campaign: c.effective_status, running: c.effective_status === 'ACTIVE' && adOn };
  });
  console.log('running now: ' + (Object.keys(statuses).filter(n => statuses[n].running && CFG.excludeCampaigns.indexOf(n) < 0).join(', ') || 'none'));

  const out = {
    pulledAt: new Date().toISOString(),
    account: CFG.accountId,
    range: { since, until },
    statuses,
    days,
    weeks: weekList
  };
  fs.writeFileSync(path.join(DIR, 'meta-data.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('written: meta-data.json  (' + Object.keys(days).length + ' days, ' + weekList.length + ' weeks)');
})().catch(e => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1); });
