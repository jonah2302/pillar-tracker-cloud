/*  creatives-to-claude.js — turn creatives.json into documents for the Claude link.
 *
 *  pull-creatives.js reads Meta. This prepares what it found for the tracker's
 *  database, and says which pieces of artwork are new, so the Claude task only
 *  uploads a picture when it has actually changed.
 *
 *  Nothing here talks to Meta or to Claude. It only reads creatives.json and
 *  writes small files next to it.
 *
 *    node creatives-to-claude.js
 *
 *  Writes: claude-creatives/<adId>.json   one document per running ad
 *          claude-creatives/PLAN.json     what to upload, what to write, what to drop
 *          creative-art/.uploaded.json    which artwork is already uploaded
 *
 *  The Claude task then, in order:
 *    1. uploads every file in PLAN.upload  (Artifact, asset: true)
 *    2. records the returned urls          (node creatives-to-claude.js --record ...)
 *    3. writes every doc in PLAN.write     (ArtifactData batch, set)
 *    4. deletes every id in PLAN.remove    (ads that stopped running)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const SRC = path.join(DIR, 'creatives.json');
const OUT_DIR = path.join(DIR, 'claude-creatives');
const ART_DIR = path.join(DIR, 'creative-art');
const MAP = path.join(ART_DIR, '.uploaded.json');

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 32);
const loadMap = () => { try { return JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch (e) { return {}; } };
const saveMap = m => { fs.mkdirSync(ART_DIR, { recursive: true }); fs.writeFileSync(MAP, JSON.stringify(m, null, 1), 'utf8'); };

/* ---------- node creatives-to-claude.js --record <sha> <url> [<sha> <url> ...] ----------
   Called after the uploads, so the next run knows that picture is already up. */
if (process.argv[2] === '--record') {
  const args = process.argv.slice(3);
  if (args.length % 2) { console.error('--record takes pairs: <sha> <url>'); process.exit(2); }
  const m = loadMap();
  /* Git Bash rewrites an argument that looks like a path, so "/_blob/xyz"
     can arrive as "C:/Program Files/Git/_blob/xyz". Keep only the real part. */
  const clean = u => { const i = String(u).indexOf('/_blob/'); return i < 0 ? String(u) : String(u).slice(i); };
  for (let i = 0; i < args.length; i += 2) m[args[i]] = clean(args[i + 1]);
  saveMap(m);
  console.log('recorded ' + (args.length / 2) + ' upload' + (args.length === 2 ? '' : 's'));
  process.exit(0);
}

if (!fs.existsSync(SRC)) {
  console.error('creatives.json is not there yet — run pull-creatives.js first.');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const uploaded = loadMap();
fs.mkdirSync(OUT_DIR, { recursive: true });

/* a file is "new" when no upload is recorded for its exact contents —
   true of the stills and of the films alike */
const upload = [];
function artUrl(file) {
  if (!file) return null;
  const abs = path.join(DIR, file);
  if (!fs.existsSync(abs)) return null;
  const h = sha(abs);
  if (uploaded[h]) return { url: uploaded[h], sha: h };
  if (!upload.some(u => u.sha === h)) upload.push({ file: abs.replace(/\\/g, '/'), sha: h });
  return { sha: h, pending: true };
}

/* what we told the tracker last time, so a run that skipped the downloads
   (pull-creatives.js --no-art, the every-15-minutes one) keeps the artwork
   already up there instead of blanking it */
function previousDoc(adId) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, adId + '.json'), 'utf8')); } catch (e) { return null; }
}
/* Only carry something forward while its upload is still on record. An asset
   that was deleted, or a file that has been replaced, must not leave a dead
   link in the tracker — better no picture than a broken one. */
function stillUp(prev) {
  return (prev && prev.url && prev.sha && uploaded[prev.sha] === prev.url) ? prev : null;
}

const write = [], keep = {};
(data.ads || []).filter(a => a.running).forEach(a => {
  const was = previousDoc(a.adId);
  const art = artUrl(a.art && a.art.file) || stillUp(was && was.art);
  const wasCards = (was && was.cards) || [];
  const cards = (a.cards || []).map(k => {
    const ka = artUrl(k.art && k.art.file);
    const wk = wasCards.filter(x => x.i === k.i)[0];
    const art2 = ka || stillUp(wk && wk.art);
    return Object.assign({}, k, { art: art2 ? { url: art2.url || null, sha: art2.sha } : null });
  });
  /* the film, once Meta lets us have it: uploaded like the stills, so the page
     plays it from inside the tracker and never calls Facebook */
  let video = a.video || null;
  if (video && video.playable) {
    const vu = artUrl(video.file) || stillUp(was && was.video);
    video = Object.assign({}, video, { url: (vu && vu.url) || null, sha: vu && vu.sha });
    delete video.source;              /* Meta's signed link expires — never store it */
    if (!video.url) video.playable = false;   /* not uploaded yet: keep showing the still */
  } else if (video && stillUp(was && was.video) && a.videoId === ((was && was.videoId) || a.videoId)) {
    /* a quick run that skipped the download must not lose a film already up there */
    video = Object.assign({}, was.video);
  }

  const doc = {
    adName: a.adName, campaign: a.campaign, campaignId: a.campaignId, adset: a.adset,
    status: a.status, running: true, format: a.format, creativeId: a.creativeId,
    copy: a.copy, cards: cards, videoId: a.videoId, video: video,
    /* the ways through to Meta. The preview link goes stale, so it is taken
       from this run rather than carried forward from the last one. */
    links: a.links || (was && was.links) || null,
    days: a.days, lifetime: a.lifetime, pulledAt: data.pulledAt,
    art: art ? { url: art.url || null, sha: art.sha, width: (a.art && a.art.width) || null } : null
  };
  const f = path.join(OUT_DIR, a.adId + '.json');
  fs.writeFileSync(f, JSON.stringify(doc, null, 1), 'utf8');
  write.push({ adId: a.adId, file: f.replace(/\\/g, '/'), adName: a.adName, format: a.format,
    playable: !!(video && video.playable && video.url) });
  keep[a.adId] = 1;
});

/* ads the database still holds that are no longer running are listed for removal;
   the Claude task deletes them so the tab only ever shows what is live */
let previous = [];
try { previous = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'PLAN.json'), 'utf8')).live || []; } catch (e) { }
const remove = previous.filter(id => !keep[id]);

const plan = {
  preparedAt: new Date().toISOString(),
  pulledAt: data.pulledAt,
  live: Object.keys(keep),
  upload: upload,
  write: write,
  remove: remove
};
fs.writeFileSync(path.join(OUT_DIR, 'PLAN.json'), JSON.stringify(plan, null, 1), 'utf8');

const playable = write.filter(w => w.playable).length;
console.log('running ads   : ' + write.length + '  (' + write.map(w => w.format).join(', ') + ')');
console.log('films playable: ' + playable + ' of ' + write.filter(w => w.format === 'video').length + ' video ads');
console.log('files to add  : ' + upload.length + (upload.length ? '' : '  (all already uploaded)'));
upload.forEach(u => console.log('   ' + u.file + '   sha ' + u.sha));
console.log('docs to write : ' + write.length);
if (remove.length) console.log('no longer live: ' + remove.join(', '));
console.log('\nplan: ' + path.join(OUT_DIR, 'PLAN.json').replace(/\\/g, '/'));
