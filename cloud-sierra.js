/* cloud-sierra.js — the Sierra follow-up reading, without a person at a keyboard.
 *
 * On the laptop this step runs inside an already logged-in Chrome tab. In the
 * cloud there is no such tab, so this opens a headless Chromium, signs in to
 * Sierra with the credentials held as repository secrets, and runs exactly the
 * same page script that sierra-sync.js already emits. Nothing about the reading
 * itself changes: same endpoints, same counts, same checks.
 *
 *   node cloud-sierra.js            full reading
 *   node cloud-sierra.js --quick    only leads whose answer can still change
 *
 * Needs: SIERRA_SITE, SIERRA_USER, SIERRA_PASS   (SIERRA_HOST is optional)
 * Writes: sierra.json and agents.json, through sierra-sync.js --apply.
 * Never prints the password, and never stores phone numbers, emails or message text.
 */
const fs = require('fs'), path = require('path'), { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const DIR = __dirname;
const QUICK = process.argv.includes('--quick');
/* which Sierra site: the secret if one is set, otherwise config.json, which
   travels encrypted — the address is not written into this file, because this
   file is public and the address says who you are. */
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const HOST = process.env.SIERRA_HOST || CFG.sierraHost || '';
const SITE = process.env.SIERRA_SITE || '';
const USER = process.env.SIERRA_USER || '';
const PASS = process.env.SIERRA_PASS || '';

if (!USER || !PASS) { console.log('No Sierra login in the environment — follow-up reading skipped, last one kept.'); process.exit(0); }
if (!HOST) { console.log('No Sierra site set (SIERRA_HOST, or sierraHost in config.json) — follow-up reading skipped, last one kept.'); process.exit(0); }

const say = m => console.log('[sierra] ' + m);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    /* 1. sign in. The site-name box only appears on the shared login page. */
    await page.goto('https://' + HOST + '/login.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await page.locator('#txtSiteName').count()) await page.fill('#txtSiteName', SITE || HOST.split('.')[0]);
    await page.fill('#txtUserName', USER);
    await page.fill('#txtPassword', PASS);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.click('#btnLoginSubmit')
    ]);
    await page.waitForTimeout(3000);

    /* 2. land on the leads screen, same origin the page script fetches from */
    await page.goto('https://' + HOST + '/leads.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await page.locator('#txtPassword').count()) {
      throw new Error('Sierra did not accept the sign-in (still on the login screen). Check SIERRA_SITE / SIERRA_USER / SIERRA_PASS, and whether Sierra now asks for a verification code.');
    }
    say('signed in as ' + USER + ' on ' + HOST);

    /* 3. the very same reading the laptop does */
    const src = execFileSync(process.execPath, ['sierra-sync.js', '--js'].concat(QUICK ? ['--quick'] : []),
      { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    say(String(await page.evaluate(src)).slice(0, 200));

    /* it runs in the background; ~3–4 minutes is normal */
    let state = null;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(10000);
      state = await page.evaluate('String(window.__sierraSync)');
      if (state && state !== 'null') break;
      if (i % 6 === 5) say('still reading… (' + ((i + 1) / 6) + ' min)');
    }
    if (!state || state === 'null') throw new Error('Sierra reading did not finish within 10 minutes.');
    if (state.startsWith('ERROR')) throw new Error('Sierra reading failed: ' + state);
    say(state);

    /* 4. pull the result out whole — no chunk-by-chunk copying needed here */
    const lines = await page.evaluate('window.__sierraChunks.join("\\n")');
    fs.writeFileSync(path.join(DIR, 'sierra-lines.txt'), lines.replace(/\r/g, '').replace(/\n$/, '') + '\n');

    /* 5. prove the copy is exact, the same way the laptop does */
    const pageHash = await page.evaluate(`(async()=>{
      const t=new TextEncoder().encode(window.__sierraChunks.join('\\n'));
      const h=await crypto.subtle.digest('SHA-256',t);
      return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16)+' len '+t.length;
    })()`);
    const ours = execFileSync(process.execPath, ['sierra-sync.js', '--hash'], { cwd: DIR, encoding: 'utf8' }).trim();
    if (pageHash !== ours) throw new Error('The copy does not match what Sierra showed (' + pageHash + ' vs ' + ours + ') — nothing applied.');
    say('copy verified ' + ours);

    /* 6. apply it: writes sierra.json and agents.json */
    /* --apply takes no --quick: the reading itself carries the Q| marker that
       tells it to lay these counts over the last full reading. */
    const r = spawnSync(process.execPath, ['sierra-sync.js', '--apply'],
      { cwd: DIR, input: fs.readFileSync(path.join(DIR, 'sierra-lines.txt')), encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) throw new Error('sierra-sync.js --apply refused the reading.');
    say('sierra.json updated');
  } finally {
    await browser.close();
  }
})().catch(e => {
  /* A Sierra failure must never block the Meta update — the last reading stays. */
  console.error('[sierra] FAILED: ' + e.message);
  console.error('[sierra] Keeping the previous Sierra reading.');
  process.exitCode = 0;
});
