/* index.js — the every-minute half of the tracker.
 *
 * GitHub's scheduler will not fire a five-minute cron. Asked for ~170 runs a day it
 * delivered four to ten, and the published figures went four hours stale
 * between them. Cloudflare's cron does fire, every minute, for free, so the
 * fast figures move here and everything slow stays where it already works.
 *
 * What this does NOT do: Sierra, the artwork, the weekly history, the daily
 * audit. Those need a headless browser or a couple of hundred questions put
 * back to Meta, and neither belongs in a job that runs sixty times an hour.
 * GitHub Actions keeps doing all of it and keeps publishing the full payload
 * to Pages. This worker treats that payload as its base and overwrites only
 * the handful of figures that actually move minute to minute: what each
 * campaign has spent this week, how many leads it brought, the cost of each,
 * and the day-by-day column for today.
 *
 * So the feed is never worse than the last full Actions build, and never more
 * than a minute behind Meta on the numbers anyone is watching.
 *
 *   cron  *** every minute ***   pull Meta, patch, re-encrypt, store
 *   GET  /  and  /feed           the encrypted feed, CORS-open
 *   GET  /t/<PAGE_PATH>          the tracker itself — the link to bookmark
 *   GET  /health                 plain text: is it fresh, when did it last run
 *
 * The page is served from here as well as the feed, so there is one link to
 * keep. It fetches on open, so clicking it is always current — which is the
 * whole point. The artifact on claude.ai cannot do this: its sandbox has no
 * network capability, so nothing it shows can be newer than the last time a
 * Claude session wrote its database. See SETUP.md.
 *
 * Secrets (wrangler secret put):
 *   META_TOKEN      the same long-lived token Actions uses
 *   PAGE_PASSWORD   the key the shared HTML carries — must match exactly
 *   PAGE_PATH       a long random string; the page lives at /t/<it>
 * Vars (wrangler.toml):
 *   BASE_URL        where Actions publishes the full payload
 * Binding:
 *   FEED            KV namespace holding the current encrypted feed
 */

/* Cloudflare Workers refuses PBKDF2 above 100,000 iterations ("iteration
   counts above 100000 are not supported"), and the worker has to open what
   Actions seals. The key is 32 random characters, not a typed password, so
   the stretching was never what stood between anyone and the figures. Both
   halves seal at this number; every reader takes the count from the feed
   itself, so a page built before this change still opens a feed built after. */
const ITER = 100000;
const KEY_FEED = 'feed';          /* the encrypted blob we serve */
const KEY_BASE = 'base';          /* last full payload from Actions, decrypted */
const KEY_NOTE = 'note';          /* when we last ran, and what went wrong */
const KEY_PAGE = 'page';          /* the tracker HTML, served at the secret path */

/* ---------------- small helpers ---------------- */

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parseYmd = s => { const p = String(s).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); };

/* Calgary, so "today" flips at local midnight rather than UTC midnight. The
   tracker's weeks start on a Saturday, which is how the offline build cuts
   them, so the two must agree or the current week would not line up. */
function todayLocal() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return f.format(new Date());          /* en-CA formats as YYYY-MM-DD */
}
function weekStartOf(s) {
  const d = parseYmd(s);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
  return ymd(d);
}

const b64 = buf => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};
const unb64 = s => {
  const r = atob(s), a = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) a[i] = r.charCodeAt(i);
  return a;
};

const money = n => '$' + (Math.round(n * 100) / 100).toFixed(2);

/* ---------------- the same lock the page already opens ---------------- */

async function deriveKey(password, salt, usage) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

async function seal(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, 'encrypt');
  /* WebCrypto appends the GCM tag to the ciphertext, which is exactly what
     Node's update+final+getAuthTag concatenation produces, so the page cannot
     tell which half of the system sealed it. */
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER,
    salt: b64(salt), iv: b64(iv), data: b64(data),
    builtAt: payload.builtAt
  });
}

async function open(doc, password) {
  const j = typeof doc === 'string' ? JSON.parse(doc) : doc;
  const key = await deriveKey(password, unb64(j.salt), 'decrypt');
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data));
  return JSON.parse(new TextDecoder().decode(buf));
}

/* ---------------- Meta ---------------- */

async function metaJson(url) {
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  const body = await r.text();
  let j;
  try { j = JSON.parse(body); }
  catch (e) { throw new Error('Meta returned something that is not JSON (HTTP ' + r.status + ')'); }
  if (j.error) {
    const e = j.error;
    let hint = '';
    if (e.code === 190) hint = ' — the token is expired or invalid.';
    if (e.code === 10 || e.code === 200) hint = ' — the token lacks ads_read on this account.';
    if (e.code === 17 || e.code === 4 || e.code === 80004) hint = ' — Meta is rate limiting.';
    throw new Error('Meta API error ' + e.code + ': ' + e.message + hint);
  }
  return j;
}

/* One lead per row, counted from the first action type that appears — the same
   order config.json gives the Node puller, so a campaign is never double
   counted and the two halves cannot disagree about what a lead is. */
function leadsFrom(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.filter(a => a.action_type === t)[0];
    if (hit) return +hit.value || 0;
  }
  return 0;
}

async function pullDaily(cfg, token, since, until) {
  const fields = 'campaign_id,campaign_name,spend,impressions,reach,actions,date_start';
  let url = 'https://graph.facebook.com/' + cfg.apiVersion + '/act_' + cfg.accountId + '/insights'
    + '?level=campaign&time_increment=1&limit=500'
    + '&fields=' + encodeURIComponent(fields)
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&access_token=' + encodeURIComponent(token);

  const out = [];
  let page = 0;
  while (url) {
    const j = await metaJson(url);
    (j.data || []).forEach(r => out.push(r));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
    if (++page > 60) throw new Error('too many pages from Meta — stopping rather than looping');
  }
  return out;
}

async function pullStatuses(cfg, token) {
  const j = await metaJson('https://graph.facebook.com/' + cfg.apiVersion + '/act_' + cfg.accountId
    + '/campaigns?limit=200&fields=name,effective_status&access_token=' + encodeURIComponent(token));
  const out = {};
  (j.data || []).forEach(c => {
    out[c.name] = { campaign: c.effective_status, running: c.effective_status === 'ACTIVE' };
  });
  return out;
}

/* ---------------- turn Meta's daily rows into the shapes the page wants ----- */

/* idFor: taken from the base payload wherever possible. The Node build derives
   an id from the campaign name for anything config.json does not list, and
   re-deriving it here would risk the two halves inventing different ids for the
   same campaign. Reading them back off the rows Actions already published
   cannot drift. A campaign so new that no build has seen it yet is left out of
   the day columns until the next Actions run names it — half an hour at worst. */
function idsFromBase(base, cfg) {
  const ids = {};
  Object.keys(cfg.campaignIds || {}).forEach(n => { ids[n] = cfg.campaignIds[n]; });
  (base.rows || []).forEach(r => { if (r.name && r.id) ids[r.name] = r.id; });
  return ids;
}

function aggregate(rows, cfg, ids) {
  const exclude = cfg.excludeCampaigns || [];
  const types = cfg.leadActionTypes || ['lead'];

  /* days is keyed by date, then by campaign NAME, exactly as the offline build
     writes it — the page reads day.<name>.spent, not a daily total. */
  const days = {};             /* 'YYYY-MM-DD' -> { name -> {id, spent, leads} } */
  const weeks = {};            /* weekStart    -> {spent, leads, campaigns{}} */

  rows.forEach(r => {
    const name = r.campaign_name;
    if (!name || exclude.indexOf(name) >= 0) return;
    const day = r.date_start;
    const spent = +r.spend || 0;
    const leads = leadsFrom(r.actions, types);
    /* Meta sends a row for every campaign on every day, most of them all
       zeroes. The offline build keeps only the days a campaign actually ran,
       so match that or the day columns fill up with empty bars. */
    if (!spent && !leads) return;

    const id = ids[name];
    if (id) {
      const d = days[day] || (days[day] = {});
      const dc = d[name] || (d[name] = { id, spent: 0, leads: 0 });
      dc.spent += spent; dc.leads += leads;
    }

    const ws = weekStartOf(day);
    const w = weeks[ws] || (weeks[ws] = { spent: 0, leads: 0, campaigns: {} });
    w.spent += spent; w.leads += leads;
    const wc = w.campaigns[name] || (w.campaigns[name] = { spent: 0, leads: 0 });
    wc.spent += spent; wc.leads += leads;
  });

  Object.keys(days).forEach(day => {
    Object.keys(days[day]).forEach(n => { days[day][n].spent = +days[day][n].spent.toFixed(2); });
  });
  return { days, weeks };
}

/* ---------------- the once-a-minute job ---------------- */

async function refresh(env) {
  const token = (env.META_TOKEN || '').trim();
  const password = (env.PAGE_PASSWORD || '').trim();
  if (!token) throw new Error('META_TOKEN is not set');
  if (!password) throw new Error('PAGE_PASSWORD is not set — refusing to publish unencrypted');

  const cfg = JSON.parse(env.CONFIG_JSON || '{}');
  if (!cfg.accountId) throw new Error('CONFIG_JSON has no accountId');

  /* ---- 1. the base: the last full build Actions published ---- */
  let base = null;
  const held = await env.FEED.get(KEY_BASE, 'json');

  /* Actions republishes with Sierra, the artwork and the weekly history every
     half hour. Whenever that is newer than what we hold, take it as the new
     base — otherwise keep ours, because ours has this minute's figures in it
     and Pages is up to half an hour behind. */
  let fetched = null;
  try {
    const r = await fetch(env.BASE_URL + (env.BASE_URL.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(),
      { cf: { cacheTtl: 0 } });
    if (r.ok) fetched = await r.json();
  } catch (e) { /* Pages being down must not stop the figures */ }

  if (fetched && (!held || !held.builtAt || (fetched.builtAt && fetched.builtAt > held.builtAt))) {
    try { base = await open(fetched, password); base.builtAt = fetched.builtAt; }
    catch (e) { throw new Error('the published payload would not open — PAGE_PASSWORD does not match Actions'); }
  } else {
    base = held;
  }
  if (!base) throw new Error('no payload to build on yet — waiting for the first Actions publish');

  /* ---- 2. this minute's figures, straight from Meta ---- */
  const until = todayLocal();
  const since = cfg.firstDay || '2026-09-01';
  const ids = idsFromBase(base, cfg);
  const daily = await pullDaily(cfg, token, since, until);
  const { days, weeks } = aggregate(daily, cfg, ids);
  const statuses = await pullStatuses(cfg, token);

  const curWeek = weeks[weekStartOf(until)] || { spent: 0, leads: 0, campaigns: {} };

  /* ---- 3. patch only what moves ----
     Four fields, and nothing else. Everything a person typed — the pillar, the
     segment, the audience notes, the client count, the lead list — belongs to
     the Actions build and to whoever typed it, and is carried through
     untouched. 'about' in particular is empty in every published row, so
     writing a blurb here would put text on screen that the tracker itself
     never shows. */
  const out = JSON.parse(JSON.stringify(base));
  out.days = days;

  (out.rows || []).forEach(row => {
    const name = row.name;
    if (!name) return;
    const c = curWeek.campaigns[name] || { spent: 0, leads: 0 };
    row.spent = +c.spent.toFixed(2);
    row.leads = c.leads;
    /* Meta's own on/off switch, and only ever between those two. A row marked
       done or planned by hand is left as it is. */
    const st = statuses[name];
    if (st && (row.status === 'live' || row.status === 'paused')) {
      row.status = st.running ? 'live' : 'paused';
    }
  });

  const stamp = new Date().toISOString();
  out.updated = stamp;
  out.builtAt = base.builtAt || stamp;   /* the base's age, not ours */
  out.figuresAt = stamp;                 /* when Meta was last asked */

  /* ---- 4. seal and store ---- */
  await env.FEED.put(KEY_BASE, JSON.stringify(base));
  await env.FEED.put(KEY_FEED, await seal(out, password));
  await env.FEED.put(KEY_NOTE, JSON.stringify({
    at: stamp, ok: true,
    week: { spent: +curWeek.spent.toFixed(2), leads: curWeek.leads },
    rows: (out.rows || []).length, days: Object.keys(days).length
  }));
  return stamp;
}

/* ---------------- what the world sees ---------------- */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*'
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await refresh(env); }
      catch (e) {
        /* A minute that fails changes nothing anyone can see: the stored feed
           is still the last good one, and the next minute tries again. */
        await env.FEED.put(KEY_NOTE, JSON.stringify({
          at: new Date().toISOString(), ok: false, why: String((e && e.message) || e)
        }));
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    /* ---- the tracker itself, at a secret address ----
       The page carries the key that opens the feed, so the address IS the
       secret — the same bargain as emailing the file, except that a link can
       be bookmarked on a phone and is current the moment it opens. Anyone
       without the path gets the same 404 as a path that does not exist, so
       guessing tells them nothing. */
    const secret = (env.PAGE_PATH || '').trim();
    if (secret && url.pathname === '/t/' + secret) {
      const html = await env.FEED.get(KEY_PAGE, 'text');
      if (!html) return new Response('The tracker page has not been uploaded yet.', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          /* The page is rebuilt rarely, but when it is, nobody should have to
             clear anything to see the new one. */
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
          'x-robots-tag': 'noindex, nofollow'
        }
      });
    }

    if (url.pathname === '/health') {
      const note = await env.FEED.get(KEY_NOTE, 'json');
      if (!note) return new Response('never run yet', { status: 503, headers: CORS });
      const age = Math.round((Date.now() - Date.parse(note.at)) / 1000);
      const lines = [
        (note.ok ? 'ok' : 'FAILING') + ' — last run ' + age + 's ago (' + note.at + ')',
        note.ok ? ('this week: ' + money(note.week.spent) + ', ' + note.week.leads + ' leads · '
          + note.rows + ' rows, ' + note.days + ' days') : ('why: ' + note.why)
      ];
      return new Response(lines.join('\n') + '\n', {
        status: note.ok && age < 600 ? 200 : 503,
        headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS)
      });
    }

    /* Everything else is either the feed or nothing. A wrong guess at the
       secret path lands here and gets the same 404 as any other junk. */
    if (url.pathname !== '/' && url.pathname !== '/feed') {
      return new Response('Not found\n', {
        status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }

    const feed = await env.FEED.get(KEY_FEED, 'text');
    if (!feed) return new Response(JSON.stringify({ error: 'no figures published yet' }), {
      status: 503, headers: Object.assign({ 'content-type': 'application/json' }, CORS)
    });

    return new Response(feed, {
      headers: Object.assign({
        'content-type': 'application/json; charset=utf-8',
        /* The page appends its own ?t=, but say it plainly as well: nothing
           between here and the browser should ever hold this for a second. */
        'cache-control': 'no-store, max-age=0'
      }, CORS)
    });
  }
};

/* Named exports so the checks in verify-shape.mjs can drive the same code the
   worker runs, rather than a copy of it that could quietly drift. Workers
   ignores everything but the default export. */
export { aggregate, idsFromBase, weekStartOf, leadsFrom, seal, open, todayLocal };
