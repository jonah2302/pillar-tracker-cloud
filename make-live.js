/* make-live.js — turn the finished offline file into the shareable live one.
 *
 * The offline build carries its numbers inside it, so a copy you email is frozen
 * the moment it is sent. The live build carries no numbers at all: it fetches
 * them when it opens. Share the file, or the link, and either one shows what the
 * cloud pulled a few minutes ago.
 *
 * The numbers sit on a public address, so they are encrypted there and the key
 * lives in the HTML. The address on its own is unreadable; whoever holds the
 * file can read it. Treat the file the way you would treat the numbers.
 *
 *   node make-live.js --data     the numbers, locked, for the public address
 *   node make-live.js --page     the file you share (holds the key — never commit it)
 *
 * The page is built once, by hand, and given to the people who should see the
 * figures. The cloud only ever publishes --data. That is the whole reason this
 * can live on a public address: the address holds nothing readable, and the key
 * exists only inside the file you chose to hand over.
 *
 * Needs: DATA_URL   where data.enc.json is published
 *        PAGE_PASSWORD   the key, the same one for both halves
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DIR = __dirname, OUT = path.join(DIR, 'docs');
const SRC = path.join(DIR, 'Meta Ads Tracker - OFFLINE.html');
const DATA_URL = (process.env.DATA_URL || '').trim();
const PASSWORD = (process.env.PAGE_PASSWORD || '').trim();
const ITER = 200000;
const WANT_PAGE = process.argv.includes('--page');
const WANT_DATA = process.argv.includes('--data') || !WANT_PAGE;
const PAGE_OUT = path.join(DIR, 'Marketing Pillar Tracker (live).html');

if (!DATA_URL) { console.error('make-live.js: DATA_URL is not set — where should the page fetch its numbers from?'); process.exit(1); }
if (!PASSWORD) { console.error('make-live.js: PAGE_PASSWORD is not set — refusing to publish the numbers unencrypted.'); process.exit(1); }
if (!fs.existsSync(SRC)) { console.error('make-live.js: no offline build to work from (' + SRC + '). Run build-from-data.js first.'); process.exit(1); }

const html = fs.readFileSync(SRC, 'utf8');

/* ---- 1. lift the five seed lines out of the offline build ---- */
const start = html.indexOf('\nvar SEED_ROWS=');
if (start < 0) { console.error('make-live.js: could not find "var SEED_ROWS=" in the offline build.'); process.exit(1); }
const upd = html.indexOf('\nvar SEED_UPDATED=', start);
if (upd < 0) { console.error('make-live.js: could not find "var SEED_UPDATED=" in the offline build.'); process.exit(1); }
const seedsEnd = html.indexOf('\n', upd + 1) + 1;
const head = html.slice(0, start);
const seeds = html.slice(start, seedsEnd);
const rest = html.slice(seedsEnd);

/* the boot code runs after the seeds and ends at the closing script tag */
const tagAt = rest.lastIndexOf('</script>');
if (tagAt < 0) { console.error('make-live.js: could not find the closing script tag.'); process.exit(1); }
const boot = rest.slice(0, tagAt);
const tail = rest.slice(tagAt);

/* ---- 2. the numbers, as their own payload ---- */
const seedLines = seeds.split('\n');
const grab = name => {
  const pre = 'var ' + name + '=';
  const line = seedLines.filter(l => l.startsWith(pre))[0];
  if (!line) { console.error('make-live.js: could not read ' + name + ' out of the offline build.'); process.exit(1); }
  return JSON.parse(line.slice(pre.length).replace(/;\s*$/, ''));
};
/* The ads ride along with their artwork, so a tracker reading the feed shows the
   same cards as the file. The offline build drops Meta's signed preview link,
   because a file sits in somebody's inbox for days and the link lasts hours; the
   feed is rewritten every few minutes, so the link goes back in here, fresh from
   the pull that just ran. */
function adsWithLinks() {
  let ads = [];
  try { ads = grab('SEED_ADS') || []; } catch (e) { return []; }
  let live = {};
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, 'creatives.json'), 'utf8'));
    (c.ads || []).forEach(a => { if (a.links) live[a.adId] = a.links; });
  } catch (e) { }
  return ads.map(a => live[a.adId] ? Object.assign({}, a, { links: live[a.adId] }) : a);
}
const payload = {
  rows: grab('SEED_ROWS'), snaps: grab('SEED_SNAPS'), days: grab('SEED_DAYS'),
  sierra: grab('SEED_SIERRA'), ads: adsWithLinks(),
  updated: grab('SEED_UPDATED'), builtAt: new Date().toISOString()
};
const plain = Buffer.from(JSON.stringify(payload), 'utf8');

/* ---- 3. lock it ---- */
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
if (WANT_DATA) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data.enc.json'), JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER,
    salt: salt.toString('base64'), iv: iv.toString('base64'), data: body.toString('base64'),
    builtAt: payload.builtAt
  }));
}

/* ---- 4. the page that goes and gets them ---- */
const loader = '\n' +
'var SEED_ROWS=[],SEED_SNAPS=[],SEED_DAYS={},SEED_SIERRA=null,SEED_ADS=[],SEED_UPDATED="";\n' +
'var LIVE_URL=' + JSON.stringify(DATA_URL) + ',LIVE_KEY=' + JSON.stringify(PASSWORD) + ';\n' +
'function __boot(){' + boot + '\n}\n' +
'var __booted=false;\n' +
'function __apply(){\n' +
'  if(!__booted){__booted=true;__boot();return;}\n' +
'  var proto=EventTarget.prototype, real=proto.addEventListener;\n' +
'  proto.addEventListener=function(){};\n' +
'  try{__boot();}finally{proto.addEventListener=real;}\n' +
'}\n' +
'var __last="";\n' +
'function __paint(){\n' +
'  var c=document.getElementById("ctx");\n' +
'  if(c&&__last&&c.textContent.indexOf(__last)<0)c.textContent+=__last;\n' +
'}\n' +
'function __stamp(ok,why){\n' +
'  var t=new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});\n' +
'  __last=ok?" \\u00b7 checked "+t:" \\u00b7 last checked "+t+" ("+why+")";\n' +
'  __paint();\n' +
'}\n' +
/* render rewrites the masthead wholesale, so the stamp goes back on after it.
   Reassigning the name works because everything calls render() by name. */
'(function(){\n' +
'  if(typeof render!=="function")return;\n' +
'  var real=render;\n' +
'  render=function(){var r=real.apply(this,arguments);__paint();return r;};\n' +
'})();\n' +
'function __say(msg,bad){\n' +
'  var h=document.getElementById("sections");if(!h)return;\n' +
'  h.innerHTML=\'<div class="empty"><h3>\'+msg+\'</h3>\'+(bad?\'<p>\'+bad+\'</p>\':"")+\'</div>\';\n' +
'}\n' +
'var __busy=false;\n' +
'function __pull(first){\n' +
'  if(__busy)return Promise.resolve();\n' +
'  __busy=true;\n' +
'  var ctx=document.getElementById("ctx");\n' +
'  if(first){\n' +
'    if(ctx)ctx.textContent="Fetching the latest numbers\\u2026";\n' +
'    __say("Fetching the latest numbers\\u2026");\n' +
'  }\n' +
'  var b=function(s){var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;};\n' +
'  return fetch(LIVE_URL+(LIVE_URL.indexOf("?")<0?"?":"&")+"t="+Date.now(),{cache:"no-store"})\n' +
'    .then(function(r){if(!r.ok)throw new Error("the numbers could not be reached (HTTP "+r.status+")");return r.json();})\n' +
'    .then(function(j){\n' +
'      return crypto.subtle.importKey("raw",new TextEncoder().encode(LIVE_KEY),"PBKDF2",false,["deriveKey"])\n' +
'        .then(function(k){return crypto.subtle.deriveKey({name:"PBKDF2",salt:b(j.salt),iterations:j.iter,hash:"SHA-256"},\n' +
'          k,{name:"AES-GCM",length:256},false,["decrypt"]);})\n' +
'        .then(function(k){return crypto.subtle.decrypt({name:"AES-GCM",iv:b(j.iv)},k,b(j.data));});\n' +
'    })\n' +
'    .then(function(buf){\n' +
'      var d=JSON.parse(new TextDecoder().decode(buf));\n' +
'      SEED_ROWS=d.rows;SEED_SNAPS=d.snaps;SEED_DAYS=d.days;SEED_SIERRA=d.sierra;SEED_UPDATED=d.updated;SEED_ADS=d.ads||[];\n' +
'      __apply();\n' +
'      __stamp(true);\n' +
'    })\n' +
'    .catch(function(e){\n' +
'      var why=String(e&&e.message||e);\n' +
'      if(/operationerror|operation-specific reason|decrypt/i.test(why))why="This copy of the tracker does not match the published figures \\u2014 ask whoever sent it for the current file.";\n' +
'      if(first){\n' +
'        if(ctx)ctx.textContent="Could not load the numbers";\n' +
'        __say("The numbers could not be loaded",why+" The figures themselves are safe \\u2014 nothing was lost.");\n' +
'      } else {\n' +
'        /* a later check that fails leaves the good figures on screen */\n' +
'        __stamp(false,/fetch/i.test(why)?"no connection":why);\n' +
'      }\n' +
'    })\n' +
'    .then(function(){__busy=false;});\n' +
'}\n' +
/* The figures are republished every five minutes, so the page asks on the
   same beat. A tab the browser has throttled catches up the moment it is
   looked at again, and a laptop coming back online catches up at once. */
'(function(){\n' +
'  __pull(true);\n' +
'  setInterval(function(){__pull(false);},300000);\n' +
'  document.addEventListener("visibilitychange",function(){\n' +
'    if(document.visibilityState==="visible")__pull(false);\n' +
'  });\n' +
'  window.addEventListener("online",function(){__pull(false);});\n' +
'})();\n';

if (WANT_PAGE) fs.writeFileSync(PAGE_OUT, head + loader + tail, 'utf8');

const kb = n => (n / 1024).toFixed(0) + ' KB';
if (WANT_PAGE) {
  console.log('the file to share : ' + path.basename(PAGE_OUT) + ' (' + kb(fs.statSync(PAGE_OUT).size) + ')');
  console.log('                    it holds the key — hand it to people, never commit it');
}
if (WANT_DATA) console.log('the numbers       : docs/data.enc.json (' + kb(fs.statSync(path.join(OUT, 'data.enc.json')).size) + ', AES-256-GCM)');
console.log('fetched from      : ' + DATA_URL);
console.log('rows ' + payload.rows.length + ', weeks ' + payload.snaps.length + ', days ' + Object.keys(payload.days).length +
  ', Meta figures as of ' + payload.updated);
