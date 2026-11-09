/* feed-to-claude.js — turn the published feed into documents for the Claude
 * tracker's database.
 *
 * The Claude artifact page cannot fetch anything: its sandbox runs under
 * default-src 'none', so even cdnjs is refused. The only way figures reach it is
 * its own database, and only a Claude session can write that. So an hourly cloud
 * routine runs this, then applies the writes with the ArtifactData tool.
 *
 *   node feed-to-claude.js <feed url> <page password> [out dir]
 *
 * Writes <out dir>/ (default claude-feed/) with one JSON file per document, and
 * prints a plan naming each collection and document id. Hand-typed Deal and
 * Qualified tags are NOT touched: the page merges those from the database itself,
 * so nothing here can overwrite them.
 */
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');

const URL_IN = process.argv[2], PASS = process.argv[3], OUT = process.argv[4] || 'claude-feed';
if (!URL_IN || !PASS) {
  console.error('use: node feed-to-claude.js <feed url> <page password> [out dir]');
  process.exit(1);
}

const get = u => new Promise((res, rej) => {
  https.get(u, r => {
    if (r.statusCode !== 200) { rej(new Error('HTTP ' + r.statusCode + ' from the feed')); r.resume(); return; }
    let s = ''; r.setEncoding('utf8');
    r.on('data', d => s += d); r.on('end', () => res(s));
  }).on('error', rej);
});

(async function () {
  const raw = await get(URL_IN + (URL_IN.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now());
  const j = JSON.parse(raw);
  const b = s => Buffer.from(s, 'base64');
  const key = crypto.pbkdf2Sync(PASS, b(j.salt), j.iter || 200000, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b(j.iv));
  const all = b(j.data);
  d.setAuthTag(all.slice(all.length - 16));
  let feed;
  try {
    feed = JSON.parse(Buffer.concat([d.update(all.slice(0, all.length - 16)), d.final()]).toString('utf8'));
  } catch (e) {
    console.error('The password does not open this feed. Nothing was written.');
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const plan = [];
  const put = (coll, id, body) => {
    const dir = path.join(OUT, coll);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, id + '.json');
    fs.writeFileSync(f, JSON.stringify(body));
    plan.push({ collection: coll, doc_id: id, file_path: path.resolve(f) });
  };

  /* campaigns — the figures only. leadRecords come along because that is where
     the lead names live; the page keeps the database's own quality tags. */
  (feed.rows || []).forEach(r => {
    const body = {};
    ['name', 'pillar', 'segment', 'about', 'areas', 'audience', 'ageRange', 'ageSpend', 'leadAges',
      'gender', 'budget', 'spent', 'leads', 'clients', 'status', 'start', 'end', 'firstRan',
      'notes', 'clientNotes', 'source', 'community', 'feedback', 'leadRecords']
      .forEach(k => { if (r[k] !== undefined) body[k] = r[k]; });
    put('campaigns', r.id, body);
  });

  /* the saved weeks */
  (feed.snaps || []).forEach(s => {
    const body = Object.assign({}, s); delete body.id;
    put('snapshots', s.id, body);
  });

  /* day by day, one document per month, the shape the page already reads */
  const months = {};
  Object.keys(feed.days || {}).forEach(day => {
    const m = day.slice(0, 7);
    (months[m] = months[m] || {})[day] = feed.days[day];
  });
  Object.keys(months).forEach(m =>
    put('daily', m, { month: m, days: months[m], pulledAt: feed.updated || feed.builtAt }));

  /* Sierra */
  if (feed.sierra) put('sierra', 'latest', feed.sierra);

  /* the ads running right now */
  const live = {};
  (feed.ads || []).forEach(a => {
    const body = Object.assign({}, a); delete body.adId;
    body.running = true;
    put('creatives', a.adId, body);
    live[a.adId] = 1;
  });

  fs.writeFileSync(path.join(OUT, 'PLAN.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), feedBuiltAt: j.builtAt,
      figuresAt: feed.updated || feed.builtAt, live: Object.keys(live), writes: plan }, null, 1));

  console.log('feed published at : ' + j.builtAt);
  console.log('figures as of     : ' + (feed.updated || feed.builtAt));
  console.log('campaigns ' + (feed.rows || []).length +
    ' · weeks ' + (feed.snaps || []).length +
    ' · months ' + Object.keys(months).length +
    ' · ads ' + (feed.ads || []).length +
    ' · sierra ' + (feed.sierra ? 'yes' : 'no'));
  console.log('documents written : ' + plan.length + ' under ' + path.resolve(OUT));
  console.log('plan              : ' + path.resolve(path.join(OUT, 'PLAN.json')));
})().catch(e => { console.error('FAILED: ' + (e && e.message || e)); process.exit(1); });
