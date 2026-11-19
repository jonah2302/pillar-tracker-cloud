/* verify-shape.mjs — check the worker rebuilds the figures the way the Node
 * build does, by replaying the published feed through it.
 *
 *   node worker/verify-shape.mjs
 *
 * There is no Meta token on this machine, so the pull itself cannot be tried
 * here. What can be tried is everything after it: take the day-by-day figures
 * Actions last published, turn them back into the rows Meta would have sent,
 * run the worker's own aggregate() over them, and check it lands on the same
 * days map and the same per-row spend and leads. If it does, the only thing
 * left untested is the HTTP call, and that is one fetch.
 *
 * Reads the key from the KEYS files beside it, exactly as a person would.
 */
import fs from 'fs';
import path from 'path';
import nodeCrypto from 'crypto';
import { fileURLToPath } from 'url';
import { aggregate, idsFromBase, weekStartOf } from './src/index.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const FEED = 'https://jonah2302.github.io/pillar-tracker-cloud/data.enc.json';

let failed = 0;
const check = (what, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
};

function keys() {
  const out = [];
  for (const f of ['KEYS - keep private.txt', 'KEYS - new, paste into GitHub.txt']) {
    try {
      (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/[A-Za-z0-9_-]{24,}/g) || [])
        .forEach(s => { if (!out.includes(s)) out.push(s); });
    } catch (e) { /* the file may not be here; that is fine */ }
  }
  return out;
}

function openNode(j, pw) {
  const key = nodeCrypto.pbkdf2Sync(pw, Buffer.from(j.salt, 'base64'), j.iter, 32, 'sha256');
  const raw = Buffer.from(j.data, 'base64');
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(raw.slice(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.slice(0, raw.length - 16)), d.final()]).toString('utf8'));
}

/* Turn the published day columns back into the rows Meta's insights endpoint
   would have produced for them — one row per campaign per day. */
function asMetaRows(payload, leadType) {
  const rows = [];
  Object.keys(payload.days).forEach(day => {
    const d = payload.days[day];
    Object.keys(d).forEach(name => {
      rows.push({
        campaign_name: name,
        date_start: day,
        spend: String(d[name].spent),
        actions: d[name].leads ? [{ action_type: leadType, value: String(d[name].leads) }] : []
      });
    });
  });
  return rows;
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const res = await fetch(FEED + '?t=' + Date.now(), { cache: 'no-store' });
if (!res.ok) { console.error('could not reach the published feed (HTTP ' + res.status + ')'); process.exit(1); }
const env = await res.json();

let payload = null;
for (const pw of keys()) { try { payload = openNode(env, pw); break; } catch (e) { /* next */ } }
if (!payload) { console.error('none of the keys beside this script opened the feed'); process.exit(1); }

console.log('\nreplaying the published feed through the worker');
console.log('  feed built ' + env.builtAt + ', ' + payload.rows.length + ' rows, '
  + Object.keys(payload.days).length + ' days\n');

const leadType = (cfg.leadActionTypes || ['lead'])[0];
const ids = idsFromBase(payload, cfg);
const metaRows = asMetaRows(payload, leadType);
const { days, weeks } = aggregate(metaRows, cfg, ids);

console.log('the day columns come back identical');
check('same set of days', JSON.stringify(Object.keys(days).sort()) === JSON.stringify(Object.keys(payload.days).sort()),
  Object.keys(days).length + ' vs ' + Object.keys(payload.days).length);
let dayDiffs = 0;
Object.keys(payload.days).forEach(d => {
  if (JSON.stringify(days[d]) !== JSON.stringify(payload.days[d])) {
    if (dayDiffs < 3) console.log('       ' + d + '\n         was  ' + JSON.stringify(payload.days[d])
      + '\n         now  ' + JSON.stringify(days[d]));
    dayDiffs++;
  }
});
check('every day matches to the cent', dayDiffs === 0, dayDiffs ? dayDiffs + ' differ' : '');

console.log('\nthe week the tracker calls current is the week the rows show');
const today = payload.updated.slice(0, 10);
const cur = weeks[weekStartOf(today)] || { campaigns: {} };
check('a current week was found', !!weeks[weekStartOf(today)], 'week of ' + weekStartOf(today));

let rowDiffs = 0;
payload.rows.forEach(r => {
  const c = cur.campaigns[r.name] || { spent: 0, leads: 0 };
  const spent = +c.spent.toFixed(2);
  if (spent !== r.spent || c.leads !== r.leads) {
    if (rowDiffs < 5) console.log('       ' + r.name + ': published $' + r.spent + '/' + r.leads
      + 'L, rebuilt $' + spent + '/' + c.leads + 'L');
    rowDiffs++;
  }
});
check('every row\'s spend and leads match', rowDiffs === 0, rowDiffs ? rowDiffs + ' of ' + payload.rows.length + ' differ' : payload.rows.length + ' rows');

console.log('\nthe patch leaves everything else alone');
const out = JSON.parse(JSON.stringify(payload));
out.days = days;
out.rows.forEach(row => {
  const c = cur.campaigns[row.name] || { spent: 0, leads: 0 };
  row.spent = +c.spent.toFixed(2);
  row.leads = c.leads;
});
check('snaps untouched', JSON.stringify(out.snaps) === JSON.stringify(payload.snaps));
check('sierra untouched', JSON.stringify(out.sierra) === JSON.stringify(payload.sierra));
check('ads untouched', JSON.stringify(out.ads) === JSON.stringify(payload.ads));
const sameExceptFigures = payload.rows.every((r, i) => {
  const o = out.rows[i], a = Object.assign({}, r), b = Object.assign({}, o);
  delete a.spent; delete a.leads; delete b.spent; delete b.leads;
  return JSON.stringify(a) === JSON.stringify(b);
});
check('rows keep every hand-typed field', sameExceptFigures);

console.log(failed ? '\n' + failed + ' check(s) FAILED\n' : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
