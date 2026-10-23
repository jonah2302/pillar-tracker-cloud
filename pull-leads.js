/*  pull-leads.js — fetch the actual people who filled in your lead forms.
 *
 *  Leads are read straight off each ad. That needs only leads_retrieval plus
 *  ad-account access, and every lead arrives already tied to its ad and
 *  campaign — so a name can never land under the wrong campaign.
 *
 *  PRIVACY: only the name and the submission date are kept. Phone numbers and
 *  email addresses are discarded — this file gets emailed and synced to a
 *  shared Drive, and contact details belong in Sierra. Set keepContact:true in
 *  config.json to override, but think first.
 *
 *  Quality tags and agents set in the tracker are never touched by this script.
 *
 *  Usage:  node pull-leads.js          fetch and write leads.json
 *          node pull-leads.js --check  fetch and report, write nothing
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const CHECK = process.argv.includes('--check');
const KEEP_CONTACT = !!CFG.keepContact;

function token() {
  if (process.env.META_TOKEN && process.env.META_TOKEN.trim()) return process.env.META_TOKEN.trim();
  const f = path.join(DIR, 'meta-token.txt');
  const t = fs.existsSync(f) && fs.readFileSync(f, 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))[0];
  if (t) return t;
  console.error('\nNo access token found. See SETUP.md.\n');
  process.exit(2);
}
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      const c = [];
      r.on('data', x => c.push(x));
      r.on('end', () => {
        let j; try { j = JSON.parse(Buffer.concat(c).toString()); }
        catch (e) { return rej(new Error('Meta returned something that is not JSON')); }
        if (j.error) {
          const e = j.error;
          let hint = '';
          if (e.code === 190) hint = '  -> token expired or invalid.';
          if (e.code === 10 || e.code === 200 || e.code === 299) hint = '  -> token needs leads_retrieval.';
          return rej(new Error('Meta API error ' + e.code + ': ' + e.message + hint));
        }
        res(j);
      });
    }).on('error', rej);
  });
}
async function all(url) {
  const out = []; let guard = 0;
  while (url) {
    const j = await get(url);
    (j.data || []).forEach(x => out.push(x));
    url = j.paging && j.paging.next;
    if (++guard > 60) break;
  }
  return out;
}
/* Meta stamps leads in UTC; the account reports in its own zone. Date each
 * lead in the account's zone so it falls in the same day — and week — Meta
 * counts it in. */
let ACCOUNT_TZ = 'UTC';
function localDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (isNaN(d)) return String(iso).slice(0, 10);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ACCOUNT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
/* "YYYY-MM-DDTHH:MM" in the account's zone — when the form was sent, so the
   Sierra tab can measure how fast an agent first reached out */
function localTime(iso) {
  const d = new Date(String(iso || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (isNaN(d)) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ACCOUNT_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day') + 'T' + g('hour') + ':' + g('minute');
}
function fieldMap(fd) {
  const m = {};
  (fd || []).forEach(f => { m[(f.name || '').toLowerCase()] = (f.values || [])[0] || ''; });
  return m;
}
function nameOf(fd) {
  const m = fieldMap(fd);
  const full = m['full_name'] || m['full name'] || m['name'] || '';
  if (full) return full.trim();
  const joined = ((m['first_name'] || m['first name'] || '') + ' ' +
                  (m['last_name'] || m['last name'] || '')).trim();
  if (joined) return joined;
  for (const k in m) if (k.indexOf('name') >= 0 && m[k]) return m[k].trim();
  return '';
}

(async () => {
  const T = token(), V = CFG.apiVersion, q = encodeURIComponent;
  const excluded = new Set(CFG.excludeCampaigns || []);

  try {
    const acct = await get('https://graph.facebook.com/' + V + '/act_' + CFG.accountId +
      '?fields=timezone_name&access_token=' + q(T));
    if (acct.timezone_name) ACCOUNT_TZ = acct.timezone_name;
  } catch (e) { console.log('note: could not read account time zone, using UTC'); }
  console.log('Account time zone: ' + ACCOUNT_TZ);
  console.log('Reading leads off every ad in ' + CFG.accountName + '...');
  const ads = await all('https://graph.facebook.com/' + V + '/act_' + CFG.accountId +
    '/ads?fields=id,name,campaign{name}&limit=200&access_token=' + q(T));
  console.log('ads: ' + ads.length);

  const byCampaign = {};
  const seen = new Set();
  let total = 0, unnamed = 0, skipped = 0;

  for (const ad of ads) {
    const camp = (ad.campaign && ad.campaign.name) || '(campaign unknown)';
    if (excluded.has(camp)) { skipped++; continue; }
    let leads = [];
    try {
      leads = await all('https://graph.facebook.com/' + V + '/' + ad.id +
        '/leads?fields=id,created_time,field_data&limit=200&access_token=' + q(T));
    } catch (e) { console.log('  ' + camp + ': ' + e.message); continue; }

    leads.forEach(L => {
      if (seen.has(L.id)) return;          // never count a lead twice
      seen.add(L.id);
      const nm = nameOf(L.field_data);
      if (!nm) unnamed++;
      const rec = { id: L.id, name: nm || 'Unnamed lead',
        date: localDate(L.created_time), time: localTime(L.created_time), ad: ad.name || '', agent: '', quality: 'new' };
      if (KEEP_CONTACT) {
        const m = fieldMap(L.field_data);
        rec.email = m['email'] || '';
        rec.phone = m['phone_number'] || m['phone'] || '';
      }
      (byCampaign[camp] = byCampaign[camp] || []).push(rec);
      total++;
    });
  }

  console.log('leads found: ' + total +
    (unnamed ? '  (' + unnamed + ' with no name field)' : '') +
    (skipped ? '  (' + skipped + ' excluded ad skipped)' : ''));
  console.log('contact details: ' + (KEEP_CONTACT ? 'KEPT' : 'discarded — names and dates only'));

  console.log('\n--- by campaign ---');
  Object.keys(byCampaign).sort().forEach(c => {
    const l = byCampaign[c];
    l.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    console.log('  ' + c.padEnd(34) + String(l.length).padStart(3));
  });

  let mismatch = 0;
  if (fs.existsSync(path.join(DIR, 'meta-data.json'))) {
    const D = JSON.parse(fs.readFileSync(path.join(DIR, 'meta-data.json'), 'utf8'));
    const counted = {};
    D.weeks.forEach(w => Object.keys(w.campaigns).forEach(c => {
      counted[c] = (counted[c] || 0) + (w.campaigns[c].leads || 0);
    }));
    console.log('\n--- names found vs leads Meta counted ---');
    Object.keys(counted).sort().forEach(c => {
      const got = (byCampaign[c] || []).length, want = counted[c];
      if (got !== want) mismatch++;
      console.log('  ' + (got === want ? 'ok  ' : (got < want ? 'FEW ' : 'MANY')) + '  ' +
        c.padEnd(34) + got + ' named / ' + want + ' counted');
    });
  }

  if (CHECK) { console.log('\n--check given: nothing written.'); return; }
  fs.writeFileSync(path.join(DIR, 'leads.json'),
    JSON.stringify({ pulledAt: new Date().toISOString(), byCampaign }, null, 2), 'utf8');
  console.log('\nwritten: leads.json' + (mismatch ? '  (' + mismatch + ' campaign count(s) differ — see above)' : ''));
})().catch(e => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1); });
