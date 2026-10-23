/* cloud-run.js — one update, start to finish, with nobody watching.
 *
 * This is the laptop's daily-run.js with the Windows parts taken out: no pop-up
 * warning, no Google Drive copy, no lock file (GitHub runs one job at a time).
 * What it keeps is the thing that matters — every figure is checked against
 * Meta before anything is published, and a failed check publishes nothing.
 *
 *   node cloud-run.js            the full morning run, with the whole audit
 *   node cloud-run.js --quick    the every-15-minutes run
 *
 * Exits non-zero if the numbers cannot be trusted. The workflow then leaves the
 * published file exactly as it was.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const DIR = __dirname;
const QUICK = process.argv.includes('--quick');
const summary = [];
let failed = null;

fs.mkdirSync(path.join(DIR, 'daily-db'), { recursive: true });

function run(script, args) {
  const label = script + (args && args.length ? ' ' + args.join(' ') : '');
  console.log('\n===== ' + label + ' =====');
  const r = spawnSync(process.execPath, [script].concat(args || []),
    { cwd: DIR, encoding: 'utf8', timeout: 20 * 60 * 1000, env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  return { ok: r.status === 0, out };
}
/* Meta turns requests away when it is busy; waiting a few minutes fixes it */
function runWithRetry(script, args) {
  let r = run(script, args);
  for (let i = 1; i <= 3 && !r.ok && /limit/i.test(r.out); i++) {
    console.log('Meta asked us to wait — trying again in ' + (5 * i) + ' minutes.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 60 * 1000 * i);
    r = run(script, args);
  }
  return r;
}
const lastLines = (s, n) => String(s || '').trim().split(/\r?\n/).slice(-(n || 3)).join(' | ');
function stop(why) { failed = why; }

(function main() {
  /* 1. spend and leads, every week checked against Meta */
  let r = runWithRetry('pull-meta.js');
  if (!r.ok || !/matches the API exactly/.test(r.out)) return stop('Meta pull failed or a week did not match: ' + lastLines(r.out));

  /* 2. month and all-time totals, to the cent */
  r = run('verify-periods.js');
  if (!r.ok) return stop('Month / all-time totals did not match Meta: ' + lastLines(r.out));

  /* 3. lead names. A failure here keeps yesterday's names — the audit still checks them. */
  const names = runWithRetry('pull-leads.js');
  if (!names.ok) summary.push('lead names could not be refreshed — kept the previous ones');

  /* 4. Sierra: new leads and agents from the API, then follow-up from the screens.
        Neither can block the Meta update; each keeps its last good reading. */
  if (fs.existsSync(path.join(DIR, 'sierra-api-key.txt'))) run('sierra-api.js');
  run('cloud-sierra.js', QUICK ? ['--quick'] : []);

  /* 5. rebuild */
  r = run('build-from-data.js', ['--no-share']);
  if (!r.ok) return stop('Rebuild failed: ' + lastLines(r.out));
  const thisWeek = ((r.out.match(/this week\s*:\s*(.*)/) || [])[1] || '').trim();
  const allTime = ((r.out.match(/all time\s*:\s*(.*)/) || [])[1] || '').trim();

  /* 6. the full audit — about 130 questions put to Meta — once a day.
        The quick runs lean on the week-by-week and month checks above, so
        Meta's hourly request limit is never reached. */
  let a = { ok: true, out: 'quick run — every week and month checked against Meta' };
  if (!QUICK) {
    a = run('audit-meta.js');
    if (!a.ok) { run('pull-meta.js'); run('build-from-data.js', ['--no-share']); a = run('audit-meta.js'); }
  }
  if (!a.ok) return stop('The audit found numbers that do not match Meta: ' + lastLines(a.out, 8));

  /* 7. the shareable file */
  r = run('make-live.js');
  if (!r.ok) return stop('Could not build the live page: ' + lastLines(r.out));

  summary.unshift('This week: ' + thisWeek, 'All time:  ' + allTime,
    'Checks:    ' + (QUICK ? 'quick run — every week and month verified' : ((a.out.match(/(\d+) checks, 0 mismatches/) || [])[0] || 'audit passed')));
})();

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const text = (failed ? 'FAILED' : 'OK') + '  ' + stamp + '\n' + (failed || summary.join('\n')) + '\n';
fs.writeFileSync(path.join(DIR, 'LAST RUN.txt'), text);
console.log('\n===== result =====\n' + text);
if (failed) {
  console.log('Nothing was published. The file people are looking at still shows the last numbers that passed every check.');
  process.exitCode = 1;
}
