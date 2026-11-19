/* verify-crypto.js — prove the worker's lock and the Node lock are the same lock.
 *
 * The page carries one key and one decrypt routine. If the worker sealed its
 * feed even slightly differently from make-live.js, the page would not say so
 * clearly — it would show "this copy does not match the published figures" and
 * look like a stale tracker. So check it here, offline, before deploying.
 *
 *   node worker/verify-crypto.cjs
 *
 * Seals with WebCrypto exactly as src/index.js does, opens with Node's crypto
 * exactly as the browser's SubtleCrypto does, and then the other way round.
 */
const nodeCrypto = require('crypto');
const { webcrypto } = require('crypto');
const crypto = webcrypto;

const ITER = 100000;   /* Workers' ceiling - see make-live.js */
const PASSWORD = 'a test key, not the real one';

const b64 = buf => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

/* ---- the worker's half, copied from src/index.js ---- */
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
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER,
    salt: b64(salt), iv: b64(iv), data: b64(data), builtAt: payload.builtAt
  });
}
async function open(doc, password) {
  const j = typeof doc === 'string' ? JSON.parse(doc) : doc;
  const key = await deriveKey(password, unb64(j.salt), 'decrypt');
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data));
  return JSON.parse(new TextDecoder().decode(buf));
}

/* ---- make-live.js's half, copied from make-live.js ---- */
function nodeSeal(payload, password) {
  const salt = nodeCrypto.randomBytes(16), iv = nodeCrypto.randomBytes(12);
  const key = nodeCrypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256');
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    data: body.toString('base64'), builtAt: payload.builtAt
  });
}
function nodeOpen(doc, password) {
  const j = JSON.parse(doc);
  const key = nodeCrypto.pbkdf2Sync(password, Buffer.from(j.salt, 'base64'), ITER, 32, 'sha256');
  const raw = Buffer.from(j.data, 'base64');
  const tag = raw.slice(raw.length - 16), body = raw.slice(0, raw.length - 16);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

(async () => {
  const payload = {
    rows: [{ id: 'meta30_buyers', name: 'Buyers Campaign', spent: 115.33, leads: 3 }],
    snaps: [], days: { '2026-11-18': { spent: 12.5, leads: 1 } },
    sierra: null, ads: [], updated: '2026-11-18T17:00:00.000Z',
    builtAt: '2026-11-18T17:00:00.000Z',
    awkward: "Micah's \"Chaparral\" — Buyers & Sellers · é ü 中文"
  };
  let failed = 0;
  const check = (what, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failed++; };

  console.log('\nthe worker seals, the page opens it');
  const fromWorker = await seal(payload, PASSWORD);
  const a = nodeOpen(fromWorker, PASSWORD);
  check('round trip', JSON.stringify(a) === JSON.stringify(payload));
  check('accents and quotes survive', a.awkward === payload.awkward);

  console.log('\nmake-live seals, the worker opens it');
  const fromNode = nodeSeal(payload, PASSWORD);
  const b = await open(fromNode, PASSWORD);
  check('round trip', JSON.stringify(b) === JSON.stringify(payload));

  console.log('\nthe envelope is the same shape either way');
  const w = JSON.parse(fromWorker), n = JSON.parse(fromNode);
  check('same fields', JSON.stringify(Object.keys(w).sort()) === JSON.stringify(Object.keys(n).sort()));
  check('same iterations', w.iter === n.iter && w.iter === ITER);
  check('same salt length', unb64(w.salt).length === unb64(n.salt).length);
  check('same iv length', unb64(w.iv).length === unb64(n.iv).length);
  check('ciphertext carries the 16-byte tag',
    unb64(w.data).length === unb64(n.data).length);

  console.log('\nthe wrong key is refused, not quietly wrong');
  let refused = false;
  try { await open(fromNode, 'not the key'); } catch (e) { refused = true; }
  check('wrong key throws', refused);

  console.log(failed ? '\n' + failed + ' check(s) FAILED\n' : '\nall checks passed\n');
  process.exit(failed ? 1 : 0);
})();
