/* Sierra CRM → the tracker's Sierra tab.
 *
 * Sierra has no feed this computer can read on its own, so this runs inside
 * a Chrome tab that is logged in to Sierra (the Claude morning task does it):
 *
 *   node sierra-sync.js --js       prints JavaScript to run in the Sierra tab.
 *                                  When done, window.__sierraSync holds the result.
 *   node sierra-sync.js --apply    reads that result on stdin and writes
 *                                  sierra.json + agents.json
 *
 * For every Meta lead it finds the matching Sierra lead (exact name, registered
 * within 10 days of the Meta lead) and reads its communication history, keeping
 * COUNTS and TIMES only — never phone numbers, emails or message text:
 *   calls   made by an agent / received, and talk time
 *   texts   sent by an agent / received      (Sierra's automatic texts left out)
 *   emails  sent by an agent / received      (Sierra's automatic emails left out)
 *   first and last time an agent reached out
 * Each lead's counts are checked against the totals Sierra itself reports.
 *
 * It also reads Sierra's Agent Accountability numbers (all leads, whole team)
 * for this week, last week, this month, last month and all time. */
const fs = require('fs'), path = require('path');
const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const P = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const add = (s, k) => { const d = P(s); d.setDate(d.getDate() + k); return ymd(d); };
const satOf = s => { let d = s; while (P(d).getDay() !== 6) d = add(d, -1); return d; };

if (process.argv.includes('--js')) {
  const L = JSON.parse(fs.readFileSync(path.join(DIR, 'leads.json'), 'utf8')).byCampaign;
  const today = ymd(new Date()), ws = satOf(today), m0 = today.slice(0, 8) + '01';
  /* --quick (hourly): only re-check leads whose answer can still change — new
     ones, ones not contacted yet, ones not found in Sierra, and anything from
     the last 14 days. Everything else keeps its last full reading. */
  const QUICK = process.argv.includes('--quick');
  const prev = fs.existsSync(path.join(DIR, 'sierra.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'sierra.json'), 'utf8')) : null;
  const since = add(today, -14);
  const untouched = r => !r || r.status !== 'ok' || !(r.calls.out + r.texts.out + r.emails.out);
  const list = [];
  Object.entries(L).forEach(([camp, xs]) => xs.forEach(x => {
    if (QUICK && prev && !untouched(prev.leads[x.id]) && x.date < since) return;
    list.push([x.id, x.name, x.date, camp]);
  }));
  const Q = { quick: QUICK && !!prev, since: QUICK && prev ? since : null,
    recheck: QUICK && prev ? Object.entries(prev.other || {}).filter(([sid, r]) => (r.reg || r.signup.slice(0, 10)) < since && untouched(Object.assign({ status: 'ok' }, r)))
      .map(([sid, r]) => [+sid, r.signup]) : [] };
  /* calls and daily team numbers: a quick run only re-reads the last few days
     (the full morning run re-reads everything since the first day) */
  if (QUICK && prev && prev.calls && prev.days) { Q.callsSince = add(today, -2); Q.daysSince = add(today, -3); }
  const pm = P(m0); pm.setMonth(pm.getMonth() - 1);
  const ranges = {
    thisweek: [ws, today], lastweek: [add(ws, -7), add(ws, -1)],
    m0: [m0, today], m1: [ymd(pm), add(m0, -1)], all: [CFG.firstDay, today]
  };
  const page = async (M, R, Q) => {
    Q = Q || {};
    window.__sierraSync = null;
    const post = async (u, b) => {
      const r = await fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(b) });
      if (!r.ok) throw new Error(u + ' HTTP ' + r.status);
      const j = await r.json(); return typeof j.d === 'string' ? JSON.parse(j.d) : j.d;
    };
    const clean = s => s.replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const norm = s => clean(String(s || '')).toLowerCase();
    const ago = r => { r = String(r || '').toLowerCase(); const n = parseFloat(r) || (/^an? /.test(r) ? 1 : 0);
      if (/hr|hour|min|sec|just/.test(r)) return 0; if (/day/.test(r)) return n; if (/week|wk/.test(r)) return n * 7;
      if (/month/.test(r)) return n * 30; if (/yr|year/.test(r)) return n * 365; return 9999; };
    const today = new Date(), wait = ms => new Promise(r => setTimeout(r, ms));
    const isAgent = x => x.userId && x.userId !== 2 && !/^sierra$/i.test(x.userFirstName || '');
    const H = (sid, flag) => post('/lead-detail.aspx/GetCommunicationHistory', Object.assign({ leadId: sid, pageNumber: 1, pageSize: 500,
      returnActions: false, returnCalls: false, returnEmails: false, returnFavorite: false, returnNotes: false,
      returnOnSiteMessages: false, returnTasks: false, returnTextMessages: false, returnAppointments: false }, { [flag]: true })).then(d => d.data);
    const out = { pulledAt: new Date().toISOString(), leads: {}, team: {}, checks: { leads: 0, bad: [] } };
    try {
      for (const [id, name, date] of M) {
        const s = await post('/leads.aspx/GetSearchValues', { searchTerm: clean(name), limit: 25, includeDeleted: false });
        const leads = (s.Data && s.Data.leads) || [];
        const want = Math.round((today - new Date(date + 'T12:00:00')) / 864e5);
        const same = leads.filter(x => norm(x.name) === norm(name));
        const near = same.filter(x => Math.abs(ago(x.registered) - want) <= 10);
        if (near.length !== 1) { out.leads[id] = { status: near.length > 1 || same.length ? 'ambiguous' : 'missing' }; continue; }
        const x = near[0], rec = { status: 'ok', sid: x.id, agent: x.buyerAgent || x.listingAgent || '',
          calls: { out: 0, in: 0, talk: 0 }, texts: { out: 0, in: 0 }, emails: { out: 0, in: 0 }, first: '', last: '', by: {} };
        const touch = (it, who) => {
          const t = String(it.dateCreated || '').slice(0, 16);
          if (!rec.first || t < rec.first) rec.first = t;
          if (!rec.last || t > rec.last) rec.last = t;
          rec.by[who] = (rec.by[who] || 0) + 1;
        };
        const calls = await H(x.id, 'returnCalls'), texts = await H(x.id, 'returnTextMessages'), emails = await H(x.id, 'returnEmails');
        calls.items.forEach(it => { if (it.inbound) rec.calls.in++; else if (isAgent(it)) { rec.calls.out++; rec.calls.talk += +it.duration || 0; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        texts.items.forEach(it => { if (it.inbound) rec.texts.in++; else if (isAgent(it)) { rec.texts.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        emails.items.forEach(it => { if (it.inbound) rec.emails.in++; else if (isAgent(it)) { rec.emails.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        /* check against Sierra's own totals for this lead */
        out.checks.leads++;
        if (calls.items.length !== +calls.totalPhoneCalls || texts.items.length !== +texts.totalTextMessages || emails.items.length !== +emails.totalEmails)
          out.checks.bad.push(name + ': read ' + calls.items.length + '/' + texts.items.length + '/' + emails.items.length +
            ', Sierra says ' + calls.totalPhoneCalls + '/' + texts.totalTextMessages + '/' + emails.totalEmails);
        out.leads[id] = rec;
        await wait(200);
      }
      /* every OTHER new lead in Sierra since the first day (not one of the Meta
         ad leads above): where it came from, who got it, and the follow-up.
         The earliest note in a lead's history is the moment it signed up. */
      out.other = {};
      const metaSids = new Set(Object.values(out.leads).map(r => r.sid).filter(Boolean).concat(Q.metaSids || []));
      const listBody = { searchTerm: '', sites: [3977], parentSiteId: -1, offices: [-1], teamSiteId: -1, leadStatuses: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        agents: [-1], sortColumn: 10, sortDir: 'desc', pageNumber: 1, pageSize: 100, smartSearchId: 0, savedSearchId: -1, searchType: 1,
        ponds: [], pondStatus: -1, smartSearch: { smartSearchParams: [], actionPlanSearchParams: [], smartSearchSortParam: null } };
      const fresh = []; let done = false;
      for (let p = 1; p <= 30 && !done; p++) {
        const d = (await post('/leads.aspx/FindLeadsBySmartParams', Object.assign({}, listBody, { pageNumber: p }))).data;
        const page = d.leads || []; if (!page.length) break;
        page.forEach(x => { const [m, dd, y] = String(x.regDate || '').split('/'); const iso = y + '-' + m + '-' + dd;
          if (iso < (Q.since || R.all[0])) { done = true; return; } fresh.push({ x, iso }); });
      }
      out.checks.otherListed = fresh.length;
      for (const { x, iso } of fresh) {
        if (metaSids.has(x.id)) continue;
        const rec = { name: String(x.leadName || '').replace(/\|/g, '/'), src: String(x.referrerBase || 'Unknown').replace(/\|/g, '/'),
          detail: String(x.regLine2 && x.regLine2 !== x.referrerBase ? x.regLine2 : (x.regLine1 && x.regLine1 !== x.referrerBase ? x.regLine1 : '')).replace(/\|/g, '/'),
          agent: (x.assignedToAgent && x.assignedToAgent.name) || (x.listingAgent && (x.listingAgent.name || (typeof x.listingAgent === 'string' && x.listingAgent))) || '', signup: iso + 'T12:00', reg: iso,
          calls: { out: 0, in: 0, talk: 0 }, texts: { out: 0, in: 0 }, emails: { out: 0, in: 0 }, first: '', last: '', by: {} };
        const touch = (it, who) => { const t = String(it.dateCreated || '').slice(0, 16);
          if (!rec.first || t < rec.first) rec.first = t; if (!rec.last || t > rec.last) rec.last = t; rec.by[who] = (rec.by[who] || 0) + 1; };
        const notes = await H(x.id, 'returnNotes');
        const firstNote = notes.items.map(it => String(it.dateCreated || '').slice(0, 16)).filter(Boolean).sort()[0];
        if (firstNote && firstNote.slice(0, 10) === iso) rec.signup = firstNote;
        const calls = await H(x.id, 'returnCalls'), texts = await H(x.id, 'returnTextMessages'), emails = await H(x.id, 'returnEmails');
        calls.items.forEach(it => { if (it.inbound) rec.calls.in++; else if (isAgent(it)) { rec.calls.out++; rec.calls.talk += +it.duration || 0; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        texts.items.forEach(it => { if (it.inbound) rec.texts.in++; else if (isAgent(it)) { rec.texts.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        emails.items.forEach(it => { if (it.inbound) rec.emails.in++; else if (isAgent(it)) { rec.emails.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        out.checks.leads++;
        if (calls.items.length !== +calls.totalPhoneCalls || texts.items.length !== +texts.totalTextMessages || emails.items.length !== +emails.totalEmails)
          out.checks.bad.push(rec.name + ': read ' + calls.items.length + '/' + texts.items.length + '/' + emails.items.length +
            ', Sierra says ' + calls.totalPhoneCalls + '/' + texts.totalTextMessages + '/' + emails.totalEmails);
        out.other[x.id] = rec;
        await wait(200);
      }
      /* quick mode: older other-source leads nobody had contacted yet — re-count
         only (name, source and sign-up time are kept from the last full reading) */
      const seenFresh = new Set(fresh.map(f => f.x.id));
      for (const [sid, signup] of (Q.recheck || [])) {
        if (seenFresh.has(sid)) continue;
        const rec = { name: '', src: '', detail: '', agent: '', signup: signup, reg: String(signup).slice(0, 10), keep: true,
          calls: { out: 0, in: 0, talk: 0 }, texts: { out: 0, in: 0 }, emails: { out: 0, in: 0 }, first: '', last: '', by: {} };
        const touch = (it, who) => { const t = String(it.dateCreated || '').slice(0, 16);
          if (!rec.first || t < rec.first) rec.first = t; if (!rec.last || t > rec.last) rec.last = t; rec.by[who] = (rec.by[who] || 0) + 1; };
        const calls = await H(sid, 'returnCalls'), texts = await H(sid, 'returnTextMessages'), emails = await H(sid, 'returnEmails');
        calls.items.forEach(it => { if (it.inbound) rec.calls.in++; else if (isAgent(it)) { rec.calls.out++; rec.calls.talk += +it.duration || 0; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        texts.items.forEach(it => { if (it.inbound) rec.texts.in++; else if (isAgent(it)) { rec.texts.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        emails.items.forEach(it => { if (it.inbound) rec.emails.in++; else if (isAgent(it)) { rec.emails.out++; touch(it, it.userFirstName + ' ' + it.userLastName); } });
        out.checks.leads++;
        if (calls.items.length !== +calls.totalPhoneCalls || texts.items.length !== +texts.totalTextMessages || emails.items.length !== +emails.totalEmails)
          out.checks.bad.push('lead ' + sid + ': read ' + calls.items.length + '/' + texts.items.length + '/' + emails.items.length +
            ', Sierra says ' + calls.totalPhoneCalls + '/' + texts.totalTextMessages + '/' + emails.totalEmails);
        out.other[sid] = rec;
        await wait(200);
      }
      for (const [k, [a, b]] of Object.entries(R)) {
        const f = s => s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4);
        const d = await post('/agent-accountability.aspx/FindAccountability', { siteId: 3977, siteChanged: false, fromDate: f(a), toDate: f(b),
          fromTime: 0, toTime: 1439, leadStatusIds: [1, 10, 2, 3, 9, 8, 4, 7, 6, 0, 5], leadSourceIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          onlyTransferedLeads: true, leadTypeId: 3, agentName: '', accSortColumn: 0, accSortDir: 0, pageNumber: 1, pageSize: 100, agents: [] });
        out.team[k] = { from: a, to: b, agents: ((d.data && d.data.agentInfos) || []).map(g => ({ name: g.agentName, lastLoggedIn: g.lastLoggedIn,
          sessions: g.sessionCount, newLeads: g.assignedLeads, notViewed: g.notViewed, noEmails: g.noEmails, noCalls: g.noCalls,
          noTasks: g.noTasks, firstEmailMin: g.avgTimeToFirstEmail, firstCallMin: g.avgTimeToFirstCall })) };
        await wait(200);
      }
      /* EVERY call by every agent (all leads, not only new ones): walk the
         leads Sierra lists as "Called Most Recently" until their last call is
         older than the window, and read each one's call history. Each call is
         kept by its own Sierra id, so re-reading never double-counts. */
      out.calls = {}; out.callsFrom = Q.callsSince || R.all[0];
      const cBody = Object.assign({}, listBody, { sortColumn: 14, sortDir: 'desc' });
      let cDone = false, cLeads = 0;
      for (let p = 1; p <= 40 && !cDone; p++) {
        const page = ((await post('/leads.aspx/FindLeadsBySmartParams', Object.assign({}, cBody, { pageNumber: p }))).data.leads) || [];
        if (!page.length) break;
        for (const x of page) {
          const last = String(x.lastPhoneCallDate || '').slice(0, 10);
          if (!last || last < out.callsFrom) { cDone = true; break; }
          const c = await H(x.id, 'returnCalls'); cLeads++;
          if (c.items.length !== +c.totalPhoneCalls) out.checks.bad.push('calls on lead ' + x.id + ': read ' + c.items.length + ', Sierra says ' + c.totalPhoneCalls);
          /* outbound calls by a person, totalled per day + agent + lead:
             [calls, talk seconds, time of that day's first call] */
          c.items.forEach(it => {
            const t = String(it.dateCreated || '').slice(0, 16);
            if (it.inbound || !isAgent(it) || t.slice(0, 10) < out.callsFrom) return;
            const k = t.slice(0, 10) + '|' + it.userFirstName + ' ' + it.userLastName + '|' + x.id;
            const v = out.calls[k] = out.calls[k] || [0, 0, t.slice(11, 16)];
            v[0]++; v[1] += +it.duration || 0; if (t.slice(11, 16) < v[2]) v[2] = t.slice(11, 16);
          });
          await wait(150);
        }
      }
      out.checks.callLeads = cLeads;
      /* Sierra's accountability numbers one DAY at a time, so any date range
         can be added up exactly (only agents with something that day) */
      out.days = {};
      const dayList = []; for (let d = new Date((Q.daysSince || R.all[0]) + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
        const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (s > R.all[1]) break; dayList.push(s); }
      for (const day of dayList) {
        const f = s => s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4);
        const d = await post('/agent-accountability.aspx/FindAccountability', { siteId: 3977, siteChanged: false, fromDate: f(day), toDate: f(day),
          fromTime: 0, toTime: 1439, leadStatusIds: [1, 10, 2, 3, 9, 8, 4, 7, 6, 0, 5], leadSourceIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          onlyTransferedLeads: true, leadTypeId: 3, agentName: '', accSortColumn: 0, accSortDir: 0, pageNumber: 1, pageSize: 100, agents: [] });
        out.days[day] = ((d.data && d.data.agentInfos) || []).filter(g => g.sessionCount || g.assignedLeads)
          .map(g => [g.agentName, g.sessionCount, g.assignedLeads, g.notViewed, g.noEmails, g.noCalls, g.noTasks]);
        await wait(120);
      }
      /* one line per lead / per agent-period, cut into pieces under 900
         characters — the browser tool returns about 1,000 at a time */
      const lines = ['P|' + out.pulledAt];
      Object.entries(out.leads).forEach(([id, r]) => lines.push(['L', id, r.status, r.sid || '', r.agent || '',
        r.calls ? r.calls.out : '', r.calls ? r.calls.in : '', r.calls ? r.calls.talk : '', r.texts ? r.texts.out : '', r.texts ? r.texts.in : '',
        r.emails ? r.emails.out : '', r.emails ? r.emails.in : '', r.first || '', r.last || '',
        r.by ? Object.entries(r.by).map(([k, v]) => k + ':' + v).join(';') : ''].join('|')));
      Object.entries(out.other).forEach(([sid, r]) => lines.push(['O', sid, r.name, r.src, r.detail, r.agent, r.signup,
        r.calls.out, r.calls.in, r.calls.talk, r.texts.out, r.texts.in, r.emails.out, r.emails.in, r.first, r.last,
        Object.entries(r.by).map(([k, v]) => k + ':' + v).join(';')].join('|')));
      lines.push('N|' + out.checks.otherListed);
      lines.push('W|' + out.callsFrom + '|' + out.checks.callLeads + '|' + Object.keys(out.calls).length);
      Object.entries(out.calls).forEach(([k, c]) => lines.push(['K', k].concat(c).join('|')));
      Object.entries(out.days).forEach(([day, rows]) => { lines.push('D|' + day); rows.forEach(g => lines.push(['d'].concat(g).join('|'))); });
      if (Q.quick) lines.push('Q|' + Q.since + '|' + M.length);
      Object.entries(out.team).forEach(([k, t]) => t.agents.forEach(g => lines.push(['T', k, t.from, t.to, g.name, g.sessions, g.newLeads,
        g.notViewed, g.noEmails, g.noCalls, g.noTasks, g.firstEmailMin, g.firstCallMin, String(g.lastLoggedIn || '').slice(0, 16)].join('|'))));
      lines.push('C|' + out.checks.leads + '|' + out.checks.bad.length);
      out.checks.bad.forEach(b => lines.push('B|' + b));
      const chunks = []; let cur = '';
      lines.forEach(l => { if (cur && (cur.length + l.length + 1) > 880) { chunks.push(cur); cur = ''; } cur += (cur ? '\n' : '') + l; });
      if (cur) chunks.push(cur);
      window.__sierraChunks = chunks;
      window.__sierraSync = 'DONE ' + chunks.length + ' pieces';
    } catch (e) { window.__sierraSync = 'ERROR ' + String(e && e.message || e).slice(0, 200); }
  };
  if (Q.quick) Q.metaSids = Object.entries(prev.leads).filter(([id]) => !list.some(l => l[0] === id)).map(([, r]) => r.sid).filter(Boolean);
  console.log('(' + page.toString() + ')(' + JSON.stringify(list) + ',' + JSON.stringify(ranges) + ',' + JSON.stringify(Q) + '); "started ' +
    list.length + ' Meta leads' + (Q.quick ? ' (quick re-check), ' + Q.recheck.length + ' older other-source leads' : '') + '"');
  return;
}

/* fingerprint of sierra-lines.txt — must equal the one the page shows with
   (await crypto.subtle.digest(...)) so nothing was lost or mistyped copying it */
if (process.argv.includes('--hash')) {
  const s = fs.readFileSync(path.join(DIR, 'sierra-lines.txt'), 'utf8').replace(/\r/g, '').replace(/\n$/, '');
  const b = Buffer.from(s, 'utf8');
  console.log(require('crypto').createHash('sha256').update(b).digest('hex').slice(0, 16) + ' len ' + b.length);
  return;
}

if (process.argv.includes('--apply')) {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw || raw.startsWith('ERROR')) { console.error('Nothing applied: ' + (raw || 'empty input')); process.exit(1); }
  /* the line format the page produces (see --js); plain JSON also accepted */
  const S = raw.startsWith('{') ? JSON.parse(raw) : { pulledAt: '', leads: {}, team: {}, checks: { leads: 0, bad: [] } };
  if (!raw.startsWith('{')) raw.split(/\r?\n/).forEach(line => {
    const f = line.split('|'), n = v => +v || 0;
    if (f[0] === 'P') S.pulledAt = f[1];
    else if (f[0] === 'L') S.leads[f[1]] = f[2] !== 'ok' ? { status: f[2] } : { status: 'ok', sid: n(f[3]), agent: f[4],
      calls: { out: n(f[5]), in: n(f[6]), talk: n(f[7]) }, texts: { out: n(f[8]), in: n(f[9]) }, emails: { out: n(f[10]), in: n(f[11]) },
      first: f[12] || '', last: f[13] || '',
      by: Object.fromEntries((f[14] || '').split(';').filter(Boolean).map(s => { const i = s.lastIndexOf(':'); return [s.slice(0, i), n(s.slice(i + 1))]; })) };
    else if (f[0] === 'T') {
      const t = S.team[f[1]] = S.team[f[1]] || { from: f[2], to: f[3], agents: [] };
      t.agents.push({ name: f[4], sessions: n(f[5]), newLeads: n(f[6]), notViewed: n(f[7]), noEmails: n(f[8]), noCalls: n(f[9]),
        noTasks: n(f[10]), firstEmailMin: n(f[11]), firstCallMin: n(f[12]), lastLoggedIn: f[13] || '' });
    }
    else if (f[0] === 'O') {
      S.other = S.other || {};
      /* Sierra sends some names as HTML codes of UTF-8 bytes (&#231;&#180;…) — turn them back into letters */
      const dec = v => String(v || '').replace(/(?:&#(\d{1,3});)+/g, run => {
        const bytes = run.match(/\d+/g).map(Number);
        if (bytes.every(b => b < 256)) { const t = Buffer.from(bytes).toString('utf8'); if (!t.includes('�')) return t; }
        return bytes.map(b => String.fromCharCode(b)).join('');
      }).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      S.other[f[1]] = { keep: !f[2] && !f[3], name: dec(f[2]), src: dec(f[3]), detail: f[4], agent: f[5], signup: f[6],
        calls: { out: n(f[7]), in: n(f[8]), talk: n(f[9]) }, texts: { out: n(f[10]), in: n(f[11]) }, emails: { out: n(f[12]), in: n(f[13]) },
        first: f[14] || '', last: f[15] || '',
        by: Object.fromEntries((f[16] || '').split(';').filter(Boolean).map(s => { const i = s.lastIndexOf(':'); return [s.slice(0, i), n(s.slice(i + 1))]; })) };
    }
    else if (f[0] === 'N') S.checks.otherListed = n(f[1]);
    else if (f[0] === 'Q') S.quick = { since: f[1], expect: n(f[2]) };
    else if (f[0] === 'W') { S.callsFrom = f[1]; S.checks.callLeads = n(f[2]); S.checks.callCount = n(f[3]); S.calls = S.calls || {}; }
    else if (f[0] === 'K') { S.calls = S.calls || {}; S.calls[f[1] + '|' + f[2] + '|' + f[3]] = [n(f[4]), n(f[5]), f[6]]; S._k = (S._k || 0) + 1; }  // day|agent|lead -> [calls, talk s, first HH:MM]
    else if (f[0] === 'D') { S.days = S.days || {}; S.days[f[1]] = []; S._day = f[1]; }
    else if (f[0] === 'd') { S.days[S._day].push([f[1], n(f[2]), n(f[3]), n(f[4]), n(f[5]), n(f[6]), n(f[7])]); }
    else if (f[0] === 'C') S.checks.leads = n(f[1]);
    else if (f[0] === 'B') S.checks.bad.push(f.slice(1).join('|'));
  });
  if (S.checks.callCount != null && (S._k || 0) !== S.checks.callCount) { console.error('Nothing applied: got ' + (S._k || 0) + ' call lines of ' + S.checks.callCount + ' — a piece is missing.'); process.exit(1); }
  delete S._k;
  const LJ = JSON.parse(fs.readFileSync(path.join(DIR, 'leads.json'), 'utf8')).byCampaign;
  const metaN = Object.values(LJ).reduce((a, x) => a + x.length, 0), gotN = Object.keys(S.leads).length;
  if (S.quick) {
    /* quick re-check: lay the fresh readings over the last full one — nothing
       that wasn't re-checked is dropped or changed */
    if (gotN !== S.quick.expect) { console.error('Nothing applied: got ' + gotN + ' of ' + S.quick.expect + ' re-checked leads — a piece is missing.'); process.exit(1); }
    const base = JSON.parse(fs.readFileSync(path.join(DIR, 'sierra.json'), 'utf8'));
    Object.assign(base.leads, S.leads);
    base.other = base.other || {};
    Object.entries(S.other || {}).forEach(([sid, r]) => {
      const old = base.other[sid];
      if (r.keep && old) { ['name', 'src', 'detail', 'agent', 'signup', 'reg'].forEach(k => { r[k] = old[k]; }); }
      delete r.keep; base.other[sid] = r;
    });
    base.team = S.team; base.pulledAt = S.pulledAt;
    /* calls: everything from the re-read window replaces what was there (so a
       deleted call disappears); older calls are kept. Days: replaced per day. */
    if (S.callsFrom) {
      base.calls = base.calls || {};
      Object.keys(base.calls).forEach(k => { if (k.slice(0, 10) >= S.callsFrom) delete base.calls[k]; });
      Object.assign(base.calls, S.calls || {});
      base.callsFrom = base.callsFrom && base.callsFrom < S.callsFrom ? base.callsFrom : S.callsFrom;
    }
    base.days = Object.assign(base.days || {}, S.days || {});
    S.calls = base.calls; S.days = base.days; S.callsFrom = base.callsFrom;
    base.checks = { leads: S.checks.leads, bad: S.checks.bad, otherListed: base.checks && base.checks.otherListed, quickSince: S.quick.since };
    const lost = Object.values(LJ).flat().filter(x => !base.leads[x.id]);
    S.leads = base.leads; S.other = base.other; S.checks = base.checks; S.checks.newMeta = lost.length;
    if (lost.length) console.log('note: ' + lost.length + ' Meta lead(s) not in this reading yet — looked up in the next run');
  } else if (gotN !== metaN) { console.error('Nothing applied: got ' + gotN + ' leads but Meta has ' + metaN + ' — a piece is missing.'); process.exit(1); }
  const F = path.join(DIR, 'agents.json'), A = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : {};
  const today = ymd(new Date());
  Object.entries(S.leads).forEach(([id, r]) => {
    if (A[id] && A[id].agent && !r.agent) return;            // never lose an agent already found
    A[id] = { agent: r.agent || '', status: r.status, checked: today };
  });
  fs.writeFileSync(F, JSON.stringify(A, null, 2));
  delete S._day;
  fs.writeFileSync(path.join(DIR, 'sierra.json'), JSON.stringify(S, null, 1));
  if (S.calls) console.log('calls: ' + Object.keys(S.calls).length + ' since ' + S.callsFrom + ' (' + (S.checks.callLeads || 0) + ' leads re-read this run); team days: ' + Object.keys(S.days || {}).length);
  const n = Object.values(S.leads), ok = n.filter(r => r.status === 'ok');
  console.log('sierra.json: ' + n.length + ' Meta leads, ' + ok.length + ' found in Sierra, ' +
    ok.filter(r => r.calls.out + r.texts.out + r.emails.out > 0).length + ' contacted by an agent; team figures for ' + Object.keys(S.team).join(', '));
  const O = Object.values(S.other || {});
  console.log('other sources: ' + O.length + ' new leads (of ' + (S.checks.otherListed || 0) + ' Sierra leads since the first day), ' +
    O.filter(r => r.calls.out + r.texts.out + r.emails.out > 0).length + ' contacted by an agent');
  console.log('check vs Sierra totals: ' + S.checks.leads + ' leads read, ' + S.checks.bad.length + ' mismatches');
  S.checks.bad.forEach(b => console.log('  MISMATCH ' + b));
  process.exitCode = S.checks.bad.length ? 1 : 0;
  return;
}
console.log('use --js or --apply');
