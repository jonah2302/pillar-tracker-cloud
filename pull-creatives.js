/*  pull-creatives.js — the format and the artwork of every ad that is running.
 *
 *  Read-only. It asks Meta three things about each ACTIVE ad:
 *    1. what it is          — video, carousel or single image
 *    2. what it says        — headline, body copy, the button
 *    3. what it looks like  — the artwork, at full size, saved next to this file
 *
 *  Nothing is ever changed in Ads Manager. The token is read the same way
 *  pull-meta.js reads it and is never printed or written anywhere.
 *
 *  It also asks for each ad's spend and leads day by day, so the tracker can
 *  total a format over any date range exactly, the way it already does for
 *  campaigns — nothing is apportioned or estimated.
 *
 *  Usage:  node pull-creatives.js                active ads only (what the tab shows)
 *          node pull-creatives.js --all          every ad, running or not
 *          node pull-creatives.js --no-art       skip the downloads, just the facts
 *          node pull-creatives.js --check-video  can Meta give us the films yet?
 *
 *  Writes: creatives.json            one record per ad
 *          creative-art/<id>.jpg     the artwork, 1080 wide
 *          creative-video/<id>.mp4   the film, where Meta allows it
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const ALL = process.argv.includes('--all');
const NO_ART = process.argv.includes('--no-art');
const CHECK_VIDEO = process.argv.includes('--check-video');
const ART_DIR = path.join(DIR, 'creative-art');
const VID_DIR = path.join(DIR, 'creative-video');
/* an artifact takes binary files up to 15 MB; a longer ad is left as its still */
const MAX_VIDEO = 15 * 1024 * 1024;

/* ---------- token: same places pull-meta.js looks ---------- */
function readToken() {
  if (process.env.META_TOKEN && process.env.META_TOKEN.trim()) return process.env.META_TOKEN.trim();
  for (const f of [path.join(DIR, 'meta-token.txt'), CFG.tokenFile].filter(Boolean)) {
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))[0];
      if (t) return t;
    }
  }
  console.error('\nNo access token found. Put it on the first line of meta-token.txt');
  console.error('or set META_TOKEN. Same token pull-meta.js uses.\n');
  process.exit(2);
}
const TOKEN = readToken();
const V = CFG.apiVersion, ACC = 'act_' + CFG.accountId;
const hide = s => String(s).split(TOKEN).join('<token>');

/* ---------- http ---------- */
function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => {
        const b = Buffer.concat(c).toString('utf8');
        let j; try { j = JSON.parse(b); } catch (e) { return rej(new Error('Meta did not return JSON (HTTP ' + r.statusCode + '): ' + hide(b).slice(0, 160))); }
        if (j.error) {
          const e = j.error;
          let hint = '';
          if (e.code === 190) hint = '  -> the token is expired or invalid.';
          if (e.code === 10 || e.code === 200) hint = '  -> the token is not allowed to read this.';
          if (e.code === 17 || e.code === 4) hint = '  -> Meta is rate limiting. Wait a few minutes.';
          return rej(new Error('Meta API error ' + e.code + ': ' + e.message + hint));
        }
        res(j);
      });
    }).on('error', rej);
  });
}
const api = (p, qs) => getJson('https://graph.facebook.com/' + V + '/' + p + '?' + qs + '&access_token=' + encodeURIComponent(TOKEN));

function fetchBin(url, depth) {
  return new Promise((res, rej) => {
    if ((depth || 0) > 6) return rej(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.destroy();
        return res(fetchBin(new URL(r.headers.location, url).href, (depth || 0) + 1));
      }
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'] || '', buf: Buffer.concat(c) }));
    }).on('error', rej);
  });
}

/* ---------- what kind of ad is it ---------- */
/* Meta does not hand you "this is a carousel". It is read off the creative:
   more than one card means carousel; a video id means video; otherwise an
   image. asset_feed_spec is the newer, flexible-format shape and is checked
   too, so an Advantage+ ad is not mislabelled. */
function formatOf(c) {
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  const kids = (oss.link_data && oss.link_data.child_attachments) || [];
  if (kids.length > 1) return 'carousel';
  if (Array.isArray(afs.videos) && afs.videos.length) return afs.videos.length > 1 ? 'carousel' : 'video';
  if (c.video_id || (oss.video_data && oss.video_data.video_id)) return 'video';
  if (Array.isArray(afs.images) && afs.images.length > 1) return 'carousel';
  if (c.image_url || c.image_hash || oss.photo_data || (oss.link_data && oss.link_data.picture) || (afs.images || []).length) return 'image';
  return 'unknown';
}

/* the words on the ad, wherever Meta happens to keep them */
function copyOf(c) {
  const oss = c.object_story_spec || {};
  const afs = c.asset_feed_spec || {};
  const ld = oss.link_data || {}, vd = oss.video_data || {}, pd = oss.photo_data || {};
  const first = a => (Array.isArray(a) && a.length ? (a[0].text || a[0].message || '') : '');
  return {
    title: vd.title || ld.name || first(afs.titles) || '',
    body: vd.message || ld.message || pd.caption || first(afs.bodies) || '',
    description: vd.link_description || ld.description || first(afs.descriptions) || '',
    cta: (vd.call_to_action && vd.call_to_action.type) || (ld.call_to_action && ld.call_to_action.type) ||
      ((afs.call_to_action_types || [])[0]) || ''
  };
}

/* every carousel card, in the order they are swiped */
function cardsOf(c) {
  const oss = c.object_story_spec || {};
  const kids = (oss.link_data && oss.link_data.child_attachments) || [];
  return kids.map((k, i) => ({
    i: i,
    name: k.name || '',
    description: k.description || '',
    picture: k.picture || '',
    videoId: k.video_id || '',
    format: k.video_id ? 'video' : 'image'
  }));
}

/* ---------- artwork ----------
   The creative's own thumbnail, asked for at the size we want. For a video ad
   this is its poster frame — the still Meta itself shows before playback. */
async function artFor(creativeId, w, h) {
  const c = await api(creativeId, 'fields=thumbnail_url&thumbnail_width=' + w + '&thumbnail_height=' + h);
  if (!c.thumbnail_url) return null;
  const r = await fetchBin(c.thumbnail_url);
  if (r.status !== 200 || !/^image\//.test(r.type)) return null;
  return r.buf;
}

/* ---------- the moving picture, if Meta will give it to us ----------
   An ad's video lives on whichever Page posted it. A token with only
   ads_read may read the ad, the creative and the poster, but not the video
   file itself; the account's own uploaded library (advideos) is readable, so
   a video uploaded there does come through. Whatever happens, the reason is
   recorded rather than guessed at. */
async function videoFor(videoId, library) {
  if (!videoId) return { ok: false, why: 'no video on this creative' };
  const inLib = library[videoId];
  if (inLib && inLib.source) return { ok: true, source: inLib.source, seconds: inLib.length || null, from: 'ad account video library' };
  try {
    const v = await api(videoId, 'fields=' + encodeURIComponent('id,source,length'));
    if (v.source) return { ok: true, source: v.source, seconds: v.length || null, from: 'video node' };
    return { ok: false, why: 'Meta returned the video but no playable file' };
  } catch (e) {
    return {
      ok: false,
      why: /permission/i.test(e.message)
        ? 'this token may not read the file (the video belongs to the Page, not the ad account)'
        : e.message
    };
  }
}

/* ---------- ways to go and look at the ad on Meta ----------
   Two links per ad, and they do different jobs:

   - the preview Meta renders itself. It shows the real ad, video playing, and
     needs no login because the link is signed. It also goes stale, so it is
     fetched fresh on every run rather than kept. Checked: the URL carries only
     two opaque signed values, never the access token.
   - Ads Manager, filtered to this one ad. Never expires, always right, and
     asks whoever clicks it to sign in to Facebook. */
async function previewUrl(adId) {
  try {
    const p = await api(adId + '/previews', 'ad_format=MOBILE_FEED_STANDARD');
    const body = (p.data && p.data[0] && p.data[0].body) || '';
    const src = (body.match(/src="([^"]+)"/) || [])[1];
    if (!src) return null;
    const url = src.replace(/&amp;/g, '&');
    if (url.indexOf(TOKEN) >= 0) return null;   /* never hand a token onwards */
    return url;
  } catch (e) { return null; }
}
const adsManagerUrl = adId =>
  'https://adsmanager.facebook.com/adsmanager/manage/ads?act=' + CFG.accountId + '&selected_ad_ids=' + adId;

/* ---------- the film itself ----------
   Meta's own video URLs are signed and expire, and pointing the tracker at one
   would also mean the page calling out to Facebook every time someone opens it.
   So the file is fetched once and handed to the tracker, the same way the still
   frames are: stored inside it, served from there, good forever. */
async function saveVideo(adId, source) {
  fs.mkdirSync(VID_DIR, { recursive: true });
  const r = await fetchBin(source);
  if (r.status !== 200 || !/^video\//.test(r.type)) {
    return { ok: false, why: 'the download came back as ' + (r.type || 'nothing') + ' (HTTP ' + r.status + ')' };
  }
  if (r.buf.length > MAX_VIDEO) {
    return { ok: false, why: 'the file is ' + (r.buf.length / 1048576).toFixed(1) + ' MB, over the 15 MB the tracker can hold' };
  }
  const f = path.join(VID_DIR, adId + '.mp4');
  fs.writeFileSync(f, r.buf);
  return { ok: true, file: path.relative(DIR, f).replace(/\\/g, '/'), bytes: r.buf.length };
}

/* ---------- what each ad spent, and what came back, day by day ----------
   Same figures and the same lead action types pull-meta.js uses, asked one
   level down. With a figure per ad per day, any week or month the tracker
   shows is an exact sum for a format, not a share of the campaign's. */
function leadsFrom(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const want of CFG.leadActionTypes) {
    const hit = actions.find(a => a.action_type === want);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}
async function dailyByAd(since, until) {
  const byAd = {};
  let url = 'https://graph.facebook.com/' + V + '/' + ACC + '/insights'
    + '?level=ad&time_increment=1&limit=500'
    + '&fields=' + encodeURIComponent('ad_id,spend,impressions,actions,date_start')
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&access_token=' + encodeURIComponent(TOKEN);
  let page = 0;
  while (url) {
    const j = await getJson(url);
    (j.data || []).forEach(r => {
      const d = (byAd[r.ad_id] = byAd[r.ad_id] || {});
      const slot = (d[r.date_start] = d[r.date_start] || { spent: 0, leads: 0, impressions: 0 });
      slot.spent += Number(r.spend) || 0;
      slot.leads += leadsFrom(r.actions);
      slot.impressions += Number(r.impressions) || 0;
    });
    url = (j.paging && j.paging.next) || null;
    if (++page > 60) throw new Error('too many pages of ad figures — stopping');
  }
  Object.values(byAd).forEach(days => {
    Object.values(days).forEach(s => { s.spent = Math.round(s.spent * 100) / 100; });
  });
  return byAd;
}

/* ---------- node pull-creatives.js --check-video ----------
   The quick answer to "can Meta give us the films yet?". Nothing is written,
   nothing is downloaded — run it straight after changing the token. */
async function checkVideo() {
  const j = await api(ACC + '/ads', 'limit=100&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE']))
    + '&fields=' + encodeURIComponent('id,name,creative{id,video_id,object_story_spec{video_data{video_id},page_id}}'));
  const ads = (j.data || []).filter(a => {
    const c = a.creative || {};
    return c.video_id || ((c.object_story_spec || {}).video_data || {}).video_id;
  });
  if (!ads.length) { console.log('No video ad is running right now.'); return; }

  const library = {};
  try {
    const l = await api(ACC + '/advideos', 'limit=100&fields=id,source');
    (l.data || []).forEach(v => { library[v.id] = v; });
  } catch (e) { /* the per-video check below still answers */ }

  let ok = 0;
  console.log('Can the tracker play these ' + ads.length + ' video ad'
    + (ads.length === 1 ? '' : 's') + '?\n');
  for (const a of ads) {
    const c = a.creative || {};
    const vid = c.video_id || ((c.object_story_spec || {}).video_data || {}).video_id;
    const v = await videoFor(vid, library);
    if (v.ok) { ok++; console.log('  YES  ' + a.name + '   (from the ' + v.from + ')'); }
    else console.log('  no   ' + a.name + '   ' + v.why);
  }
  console.log('\n' + ok + ' of ' + ads.length + ' playable.');
  if (ok === ads.length) {
    console.log('\nAll set. Run:   node pull-creatives.js');
    console.log('then the usual mirror puts the films into the tracker.');
  } else {
    console.log('\nStill blocked. See VIDEO-PLAYBACK.md — the system user needs the');
    console.log('Page assigned to it, and a token carrying pages_read_engagement.');
    process.exitCode = 1;
  }
}

/* ---------- go ---------- */
(async () => {
  if (CHECK_VIDEO) return checkVideo();
  console.log('Account : ' + CFG.accountName + ' (' + CFG.accountId + ')');
  console.log('Asking  : ' + (ALL ? 'every ad' : 'ads that are running right now') + '\n');

  const creativeFields = [
    'id', 'name', 'object_type', 'thumbnail_url', 'image_url', 'image_hash', 'video_id',
    'effective_object_story_id',
    'asset_feed_spec{videos,images,titles,bodies,descriptions,call_to_action_types}',
    'object_story_spec{' +
      'link_data{message,name,description,picture,call_to_action,child_attachments{name,description,picture,image_hash,video_id,link}},' +
      'video_data{message,title,video_id,image_url,link_description,call_to_action},' +
      'photo_data{caption,url,image_hash}}'
  ].join(',');

  let url = 'https://graph.facebook.com/' + V + '/' + ACC + '/ads?limit=100'
    + (ALL ? '' : '&effective_status=' + encodeURIComponent(JSON.stringify(['ACTIVE'])))
    + '&fields=' + encodeURIComponent('id,name,status,effective_status,created_time,updated_time,'
      + 'campaign{id,name},adset{id,name},creative{' + creativeFields + '}')
    + '&access_token=' + encodeURIComponent(TOKEN);

  const ads = [];
  let page = 0;
  while (url) {
    const j = await getJson(url);
    (j.data || []).forEach(a => ads.push(a));
    url = (j.paging && j.paging.next) || null;
    if (++page > 20) throw new Error('too many pages from Meta — stopping');
  }
  console.log('ads returned: ' + ads.length);

  /* the account's own video library, read once — some ads' videos live here */
  const library = {};
  try {
    let lu = 'https://graph.facebook.com/' + V + '/' + ACC + '/advideos?limit=100&fields='
      + encodeURIComponent('id,title,length,source') + '&access_token=' + encodeURIComponent(TOKEN);
    let p = 0;
    while (lu && p++ < 10) {
      const j = await getJson(lu);
      (j.data || []).forEach(v => { library[v.id] = v; });
      lu = (j.paging && j.paging.next) || null;
    }
    console.log('account video library: ' + Object.keys(library).length + ' videos');
  } catch (e) {
    console.log('account video library: could not be read (' + e.message + ')');
  }

  /* spend and leads per ad per day, from the first day the tracker covers */
  const todayYmd = new Date().toISOString().slice(0, 10);
  let perAdDays = {};
  try {
    perAdDays = await dailyByAd(CFG.firstDay, todayYmd);
    const n = Object.keys(perAdDays).length;
    console.log('daily figures: ' + n + ' ad' + (n === 1 ? '' : 's') + ' from ' + CFG.firstDay);
  } catch (e) {
    console.log('daily figures: could not be read (' + e.message + ')');
  }

  if (!NO_ART) fs.mkdirSync(ART_DIR, { recursive: true });

  const excluded = new Set(CFG.excludeCampaigns || []);
  const out = [];
  const missingVideo = [];

  for (const a of ads) {
    const campaign = (a.campaign && a.campaign.name) || '';
    if (excluded.has(campaign)) continue;
    const c = a.creative || {};
    const fmt = formatOf(c);
    const vid = c.video_id || ((c.object_story_spec || {}).video_data || {}).video_id || '';
    const rec = {
      adId: a.id,
      adName: a.name || '',
      campaign: campaign,
      campaignId: (a.campaign && a.campaign.id) || '',
      adset: (a.adset && a.adset.name) || '',
      status: a.effective_status || a.status || '',
      running: (a.effective_status || '') === 'ACTIVE',
      format: fmt,
      creativeId: c.id || '',
      copy: copyOf(c),
      cards: fmt === 'carousel' ? cardsOf(c) : [],
      videoId: vid,
      updated: a.updated_time || '',
      days: perAdDays[a.id] || {},
      links: { adsManager: adsManagerUrl(a.id), preview: await previewUrl(a.id) }
    };
    const tot = Object.values(rec.days).reduce((s, d) => ({ spent: s.spent + d.spent, leads: s.leads + d.leads }), { spent: 0, leads: 0 });
    rec.lifetime = { spent: Math.round(tot.spent * 100) / 100, leads: tot.leads };

    if (vid) {
      const v = await videoFor(vid, library);
      /* A file you dropped in yourself always wins. Meta will not hand over a
         video that belongs to the Page, but you already have these files — put
         one at creative-video/<ad id>.mp4 and the tracker plays it, with no
         permission to change and nothing asked of Meta. */
      const mine = path.join(VID_DIR, a.id + '.mp4');
      if (fs.existsSync(mine)) {
        const sz = fs.statSync(mine).size;
        if (sz > MAX_VIDEO) {
          rec.video = { playable: false, why: 'your file is ' + (sz / 1048576).toFixed(1) + ' MB, over the 15 MB the tracker can hold' };
          missingVideo.push(rec.adName + ' — ' + rec.video.why);
        } else {
          rec.video = { playable: true, from: 'a file you provided',
            file: path.relative(DIR, mine).replace(/\\/g, '/'), bytes: sz };
        }
      } else if (!v.ok) {
        rec.video = { playable: false, why: v.why, wants: 'creative-video/' + a.id + '.mp4' };
        missingVideo.push(rec.adName + ' — ' + v.why);
      } else {
        rec.video = { playable: true, seconds: v.seconds, from: v.from };
        /* keep a copy so the tracker never depends on Meta's expiring link */
        if (NO_ART) {
          rec.video.note = 'file not fetched on this quick run';
        } else {
          const got = await saveVideo(a.id, v.source);
          if (got.ok) { rec.video.file = got.file; rec.video.bytes = got.bytes; }
          else { rec.video.playable = false; rec.video.why = got.why; missingVideo.push(rec.adName + ' — ' + got.why); }
        }
      }
    }

    if (!NO_ART) {
      try {
        const buf = await artFor(c.id, 1080, 1080);
        if (buf) {
          const f = path.join(ART_DIR, a.id + '.jpg');
          fs.writeFileSync(f, buf);
          rec.art = { file: path.relative(DIR, f).replace(/\\/g, '/'), bytes: buf.length, width: 1080 };
        }
      } catch (e) {
        console.log('  artwork for "' + rec.adName + '" could not be fetched: ' + e.message);
      }
      /* carousel cards each have their own picture */
      for (const card of rec.cards) {
        if (!card.picture) continue;
        try {
          const r = await fetchBin(card.picture);
          if (r.status === 200 && /^image\//.test(r.type)) {
            const f = path.join(ART_DIR, a.id + '-card' + card.i + '.jpg');
            fs.writeFileSync(f, r.buf);
            card.art = { file: path.relative(DIR, f).replace(/\\/g, '/'), bytes: r.buf.length };
          }
        } catch (e) { /* a card without artwork still lists its words */ }
      }
    }
    out.push(rec);
  }

  /* ---------- say what came back ---------- */
  const byFormat = {};
  out.forEach(r => { byFormat[r.format] = (byFormat[r.format] || 0) + 1; });
  console.log('\n--- ' + out.length + ' ad' + (out.length === 1 ? '' : 's') + ' ---');
  out.forEach(r => {
    console.log('  ' + (r.running ? 'running' : r.status.toLowerCase().padEnd(7)) + '  '
      + r.format.padEnd(8) + '  ' + r.adName
      + '  [' + r.campaign + ']'
      + '  $' + r.lifetime.spent.toFixed(2) + '/' + r.lifetime.leads + ' leads'
      + (r.art ? '  art ' + (r.art.bytes / 1024).toFixed(0) + 'KB' : '  NO ART')
      + (r.videoId ? (r.video && r.video.playable ? '  video ok' : '  video not readable') : ''));
  });
  const fmtTot = {};
  out.forEach(r => {
    const t = (fmtTot[r.format] = fmtTot[r.format] || { spent: 0, leads: 0 });
    t.spent += r.lifetime.spent; t.leads += r.lifetime.leads;
  });
  console.log('\n--- by format, all time ---');
  Object.entries(fmtTot).forEach(([f, t]) => console.log('  ' + f.padEnd(9)
    + '$' + t.spent.toFixed(2).padStart(9) + '  ' + String(t.leads).padStart(3) + ' leads  '
    + (t.leads ? '$' + (t.spent / t.leads).toFixed(2) + ' each' : '-')));
  console.log('\nby format: ' + Object.entries(byFormat).map(([k, v]) => k + ' ' + v).join(', '));

  const wanted = out.filter(r => r.video && r.video.wants);
  if (wanted.length) {
    fs.mkdirSync(VID_DIR, { recursive: true });
    console.log('\n--- ' + wanted.length + ' video' + (wanted.length === 1 ? '' : 's')
      + ' Meta will not hand over ---');
    console.log('The still frame is shown instead, so every ad still previews.');
    console.log('\nFastest fix, needing nothing from Meta: drop your own copy of each');
    console.log('file into ' + VID_DIR.replace(/\\/g, '/') + ' named exactly:\n');
    wanted.forEach(r => console.log('   ' + path.basename(r.video.wants).padEnd(26) + '  "' + r.adName + '"'
      + (r.copy && r.copy.title ? '   — ' + r.copy.title : '')));
    console.log('\nThen run this again. Under 15 MB each; MP4. Anything you provide');
    console.log('is used as-is and never sent back to Meta.');
    console.log('\nThe other way is to give this token Page access — see VIDEO-PLAYBACK.md.');
  }
  const mine = out.filter(r => r.video && r.video.playable && r.video.from === 'a file you provided');
  if (mine.length) console.log('\nUsing ' + mine.length + ' video file'
    + (mine.length === 1 ? '' : 's') + ' you provided: '
    + mine.map(r => '"' + r.adName + '"').join(', '));

  const doc = {
    pulledAt: new Date().toISOString(),
    account: CFG.accountId,
    scope: ALL ? 'all' : 'active',
    byFormat: byFormat,
    ads: out
  };
  fs.writeFileSync(path.join(DIR, 'creatives.json'), JSON.stringify(doc, null, 2), 'utf8');
  console.log('\nwritten: creatives.json (' + out.length + ' ads)'
    + (NO_ART ? '' : ', artwork in creative-art/'));
})().catch(e => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1); });
