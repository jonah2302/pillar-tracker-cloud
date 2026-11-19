/* publish-page.cjs — build the tracker page against the worker and put it up.
 *
 *   node worker\publish-page.cjs https://pillar-tracker-feed.<sub>.workers.dev
 *
 * Three steps, so there is one command instead of three:
 *
 *   1. make-live.js builds the shareable HTML with the worker's /feed address
 *      and the key baked in
 *   2. the five-minute refresh inside that file is turned down to one minute,
 *      to match how often the worker actually has something new
 *   3. the file goes into KV, where the worker serves it at /t/<PAGE_PATH>
 *
 * PAGE_PASSWORD must be set, and must be the key the published feed opens
 * with — the same one GitHub holds. It is never printed.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const DIR = __dirname, ROOT = path.join(DIR, '..');
const PAGE = path.join(ROOT, 'Marketing Pillar Tracker (live).html');

const base = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!base || !/^https:\/\//.test(base)) {
  console.error('\nUsage: node worker\\publish-page.cjs https://pillar-tracker-feed.<sub>.workers.dev');
  console.error('       (the URL wrangler deploy printed)\n');
  process.exit(1);
}
const password = (process.env.PAGE_PASSWORD || '').trim();
if (!password) {
  console.error('\nPAGE_PASSWORD is not set. In PowerShell:');
  console.error('  $env:PAGE_PASSWORD = \'<the key from KEYS - keep private.txt>\'\n');
  process.exit(1);
}

const run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit', shell: true }, opts || {}));
  if (r.status !== 0) { console.error('\n' + cmd + ' failed (exit ' + r.status + ')\n'); process.exit(r.status || 1); }
};

/* ---- 1. build it against the worker ---- */
console.log('building the page against ' + base + '/feed');
run('node', ['make-live.js', '--page'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DATA_URL: base + '/feed', PAGE_PASSWORD: password })
});

/* ---- 2. one minute, not five ---- */
let html = fs.readFileSync(PAGE, 'utf8');
const was = html;
html = html.replace('setInterval(function(){__pull(false);},300000)',
  'setInterval(function(){__pull(false);},60000)');
if (html === was) {
  console.log('note: could not find the five-minute timer to turn down — the page');
  console.log('      still refreshes on open and on every visit, just every five');
  console.log('      minutes while left sitting there.');
} else {
  fs.writeFileSync(PAGE, html, 'utf8');
  console.log('refresh interval turned down to 60s');
}

/* ---- 3. up it goes ---- */
console.log('uploading ' + (fs.statSync(PAGE).size / 1048576).toFixed(2) + ' MB to KV');
run('npx', ['wrangler', 'kv', 'key', 'put', 'page', '--binding', 'FEED', '--remote',
  '--path', JSON.stringify(PAGE)], { cwd: DIR });

console.log('\ndone. The link to bookmark is:');
console.log('  ' + base + '/t/<your PAGE_PATH>\n');
console.log('Open it and it fetches the figures as it loads, so it is current');
console.log('every time you click it. Check the feed behind it with:');
console.log('  curl ' + base + '/health\n');
