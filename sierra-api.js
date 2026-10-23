/* Sierra's official API — runs from Windows every 15 minutes, no Chrome, no Claude.
 *
 * What the API gives: every lead with its source, sign-up time, status and
 * assigned agent. What it does NOT give: calls, texts or emails (those only
 * come from Sierra's own screens — the hourly Claude check, sierra-sync.js).
 *
 * So this script spots NEW leads (Meta ads and every other source) and agent
 * changes fast, and writes sierra-api.json. build-from-data.js lays it under
 * the hourly reading: anything the hourly check has not seen yet appears with
 * "contact not checked yet" until the next hourly check confirms it.
 *
 * Never stores or prints phone numbers, emails, or the API key.
 *   node sierra-api.js            -> writes sierra-api.json
 */
const fs = require('fs'), path = require('path'), https = require('https');
const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const KF = path.join(DIR, 'sierra-api-key.txt');
if (!fs.existsSync(KF)) { console.log('no sierra-api-key.txt — skipped'); process.exit(0); }
const KEY = fs.readFileSync(KF, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))[0];
if (!KEY) { console.log('sierra-api-key.txt is empty — skipped'); process.exit(0); }

const get = p => new Promise((res, rej) => https.get({ host: 'api.sierrainteractivedev.com', path: p, timeout: 30000,
  headers: { 'Sierra-ApiKey': KEY, 'Content-Type': 'application/json', 'Sierra-OriginatingSystemName': 'MetaAdsTracker' } }, r => {
  let s = ''; r.on('data', d => s += d);
  r.on('end', () => { try { const j = JSON.parse(s); j.success ? res(j.data) : rej(new Error('Sierra API ' + r.statusCode + ': ' + (j.errorMessage || 'failed'))); }
    catch (e) { rej(new Error('Sierra API ' + r.statusCode + ': not JSON')); } });
}).on('error', rej).on('timeout', function () { this.destroy(new Error('Sierra API timed out')); }));

/* API times are UTC without a "Z" — turn them into Mountain wall-clock "YYYY-MM-DDTHH:MM" like Sierra's screens */
const TZ = CFG.timeZone || 'America/Edmonton';
function local(utc) {
  const d = new Date(String(utc).replace(/Z?$/, 'Z'));
  if (isNaN(d)) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day') + 'T' + g('hour') + ':' + g('minute');
}
const clean = s => String(s || '').replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  const [m, d, y] = [CFG.firstDay.slice(5, 7), CFG.firstDay.slice(8, 10), CFG.firstDay.slice(0, 4)];
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const data = await get('/leads/find?leadCreationDateFrom=' + m + '/' + d + '/' + y + '&leadStatus=AllExceptDeleted&pageSize=100&pageNumber=' + page + '&sortColumn=RegisteredDate&sortOrder=desc');
    (data.leads || []).forEach(x => all.push(x));
    if (page >= (data.totalPages || 1)) break;
  }
  const leads = {};
  all.forEach(x => {
    /* Lead agent: the buyer's agent (assignedTo); if that is empty, the
       seller's agent (listingAgent). Every lead should have one or the other. */
    const nm = a => a ? [a.agentUserFirstName, a.agentUserLastName].filter(Boolean).join(' ') : '';
    leads[x.id] = {
      name: [x.firstName, x.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      src: x.source || 'Unknown', status: x.leadStatus || '',
      agent: nm(x.assignedTo) || nm(x.listingAgent),
      signup: local(x.creationDate)
    };
  });

  /* match each Meta ad lead to its Sierra record: exact name, signed up within a day of the form */
  const LJ = JSON.parse(fs.readFileSync(path.join(DIR, 'leads.json'), 'utf8')).byCampaign;
  const meta = {};
  Object.values(LJ).flat().forEach(x => {
    const want = x.time || (x.date + 'T12:00');
    const hits = Object.entries(leads).filter(([, r]) => clean(r.name) === clean(x.name) &&
      Math.abs(Date.parse(r.signup + ':00Z') - Date.parse(want + ':00Z')) <= 36 * 3600e3);
    if (hits.length === 1) meta[x.id] = +hits[0][0];
  });

  fs.writeFileSync(path.join(DIR, 'sierra-api.json'), JSON.stringify({ at: new Date().toISOString(), leads, meta }, null, 1));
  console.log('Sierra API: ' + all.length + ' leads since ' + CFG.firstDay + ', ' + Object.keys(meta).length + ' matched to Meta ad leads');
  const none = Object.values(leads).filter(r => !r.agent);
  if (none.length) console.log('NO AGENT (buyer or seller side) in Sierra: ' + none.map(r => r.name).join(', '));
})().catch(e => { console.log('Sierra API FAILED: ' + e.message); process.exitCode = 1; });
