/* sync-config.js — copy the parts of config.json the worker needs into
 * wrangler.toml, so the two halves can never drift on what a lead is or which
 * campaigns are excluded.
 *
 *   node worker/sync-config.cjs
 *
 * Run it after any edit to config.json, then deploy the worker again.
 */
const fs = require('fs'), path = require('path');

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'config.json'), 'utf8'));
const toml = path.join(DIR, 'wrangler.toml');

const slim = {
  accountId: cfg.accountId,
  apiVersion: cfg.apiVersion,
  firstDay: cfg.firstDay,
  excludeCampaigns: cfg.excludeCampaigns || [],
  leadActionTypes: cfg.leadActionTypes || [],
  campaignIds: cfg.campaignIds || {}
};

/* Single quotes and ampersands live in campaign names. TOML's literal strings
   cannot carry a single quote at all, so escape them the way JSON does and let
   JSON.parse put them back inside the worker. */
const json = JSON.stringify(slim)
  .replace(/'/g, '\\u0027')
  .replace(/&/g, '\\u0026');

const src = fs.readFileSync(toml, 'utf8');
const next = src.replace(/^CONFIG_JSON = '.*'$/m, "CONFIG_JSON = '" + json + "'");

if (next === src) {
  console.error('sync-config.js: could not find the CONFIG_JSON line in wrangler.toml');
  process.exit(1);
}
fs.writeFileSync(toml, next, 'utf8');
console.log('wrangler.toml updated — ' + Object.keys(slim.campaignIds).length + ' campaigns, '
  + slim.excludeCampaigns.length + ' excluded, ' + slim.leadActionTypes.length + ' lead action types');
console.log('now: cd worker && npx wrangler deploy');
