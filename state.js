/* state.js — the working files, locked before they go into the repository.
 *
 * The repository has to be public for the free unlimited runs, and the working
 * files carry people's names: who enquired, which agent has them, when they were
 * called. Those must never sit in a public repository in plain sight.
 *
 * So the run unpacks them at the start, works on them, and packs them again at
 * the end. What is committed is one locked file, state.enc, that nobody without
 * STATE_KEY can read — not even someone who clones the repository.
 *
 *   node state.js unpack     state.enc  ->  the working files
 *   node state.js pack       the working files  ->  state.enc
 *
 * Needs: STATE_KEY
 * A first run with no state.enc simply starts from what the repository has.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DIR = __dirname, ENC = path.join(DIR, 'state.enc');
const KEY_TEXT = (process.env.STATE_KEY || '').trim();
const ITER = 200000;

/* everything a run needs to remember, and everything that names a person,
   a campaign, a listing address or an amount of money */
const FILES = [
  'config.json',
  'LAST RUN.txt',
  'meta-data.json',
  'leads.json',
  'sierra.json',
  'sierra-api.json',
  'agents.json',
  'creatives.json',
  'Marketing Pillar Tracker.html',
  /* the page the build starts from. It carries the Sierra address and a couple
     of staff names in its placeholder text, and the repository is public, so it
     travels locked like everything else that names anybody. */
  'marketing-pillar-tracker.html'
];
/* The artwork is binary and it is slow to fetch, so it travels here too rather
   than being downloaded again every run. The five-minute pass asks Meta only
   for figures; without this the ad cards on that pass would have no pictures. */
const ART_DIRS = ['creative-art', 'creative-video'];
const ART_MAX = 12e6;   /* a film bigger than this stays where it is */

const mode = process.argv[2];
if (mode !== 'pack' && mode !== 'unpack') { console.error('use: node state.js pack | unpack'); process.exit(1); }
if (!KEY_TEXT) { console.error('state.js: STATE_KEY is not set — refusing to handle the working files.'); process.exit(1); }

const keyFrom = salt => crypto.pbkdf2Sync(KEY_TEXT, salt, ITER, 32, 'sha256');

if (mode === 'pack') {
  const bundle = {}, art = {};
  FILES.forEach(f => {
    const p = path.join(DIR, f);
    if (fs.existsSync(p)) bundle[f] = fs.readFileSync(p, 'utf8');
  });
  ART_DIRS.forEach(d => {
    const dir = path.join(DIR, d);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile() && fs.statSync(p).size <= ART_MAX)
        art[d + '/' + f] = fs.readFileSync(p).toString('base64');
    });
  });
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(salt), iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify({ text: bundle, art: art }), 'utf8')), c.final(), c.getAuthTag()]);
  fs.writeFileSync(ENC, JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER,
    salt: salt.toString('base64'), iv: iv.toString('base64'), data: body.toString('base64'),
    packedAt: new Date().toISOString(), files: Object.keys(bundle), art: Object.keys(art).length
  }));
  console.log('state.enc: ' + Object.keys(bundle).length + ' files and ' + Object.keys(art).length +
    ' pieces of artwork locked (' + (fs.statSync(ENC).size / 1024).toFixed(0) + ' KB)');
  process.exit(0);
}

if (!fs.existsSync(ENC)) {
  /* config.json lives in state.enc, so without it a run has nothing to work from */
  if (!fs.existsSync(path.join(DIR, 'config.json'))) {
    console.error('state.js: no state.enc and no config.json — there is nothing to run on.');
    console.error('Build state.enc on the computer that has the working files:  STATE_KEY=... node state.js pack');
    process.exit(1);
  }
  console.log('No state.enc yet — starting from what the repository already holds.');
  process.exit(0);
}
const j = JSON.parse(fs.readFileSync(ENC, 'utf8'));
const b = s => Buffer.from(s, 'base64');
const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(b(j.salt)), b(j.iv));
const all = b(j.data);
d.setAuthTag(all.slice(all.length - 16));
let plain;
try { plain = Buffer.concat([d.update(all.slice(0, all.length - 16)), d.final()]); }
catch (e) { console.error('state.js: STATE_KEY does not open state.enc. If the key was changed, delete state.enc and let the next run build it again.'); process.exit(1); }
const packed = JSON.parse(plain.toString('utf8'));
/* a bundle written before the artwork was carried is a flat map of text files */
const bundle = packed.text || packed, art = packed.art || {};
Object.keys(bundle).forEach(f => fs.writeFileSync(path.join(DIR, f), bundle[f], 'utf8'));
Object.keys(art).forEach(f => {
  const p = path.join(DIR, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(art[f], 'base64'));
});
console.log('state.enc: ' + Object.keys(bundle).length + ' files and ' + Object.keys(art).length +
  ' pieces of artwork opened, packed ' + (j.packedAt || 'at an unknown time'));
