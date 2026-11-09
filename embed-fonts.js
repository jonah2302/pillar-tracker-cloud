/* Inline the webfonts so the shared file makes zero network requests. */
const fs = require('fs');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': UA } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location).then(res, rej);
      if (r.statusCode !== 200) return rej(new Error(url + ' -> ' + r.statusCode));
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });
}

(async () => {
  const target = process.argv[2];
  let css = fs.readFileSync('fonts/css.txt', 'utf8');

  const urls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || [])];
  console.log('font files:', urls.length);

  let total = 0;
  for (const u of urls) {
    const buf = await get(u);
    total += buf.length;
    console.log('  ' + u.split('/').pop().padEnd(46) + (buf.length / 1024).toFixed(1) + ' KB');
    css = css.split(u).join('data:font/woff2;base64,' + buf.toString('base64'));
  }
  console.log('raw font bytes:', (total / 1024).toFixed(1), 'KB');

  if (/https?:\/\//.test(css)) throw new Error('a remote URL survived in the font CSS');

  let html = fs.readFileSync(target, 'utf8');
  const linkRe = /<link rel="preconnect"[^>]*>\s*<link rel="preconnect"[^>]*>\s*<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2[^"]*">/;
  if (!linkRe.test(html)) throw new Error('font <link> block not found in ' + target);
  html = html.replace(linkRe,
    '<style id="fontCss">\n/* Marcellus, Marcellus SC and IBM Plex Sans embedded — this file loads nothing from the internet. */\n' + css + '\n</style>');

  // the PDF report builds its own document; point it at the same embedded bytes
  // instead of the network, and instead of a second copy of the fonts
  // the PDF report builds its own document; point it at the same embedded
  // bytes instead of the network. Matched by shape, not by exact text, so
  // reformatting the page cannot quietly break the offline build.
  const reportRe = /'<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">'\+\s*'<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>'\+\s*'<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2[^"]*">'\+/;
  if (!reportRe.test(html)) throw new Error('report font links not found');
  html = html.replace(reportRe,
    "'<style>'+((document.getElementById(\"fontCss\")||{}).textContent||\"\")+'</style>'+");

  const left = (html.match(/https?:\/\/(?!fonts\.gstatic)[^"' )]+/g) || []).filter(u => !u.startsWith('data:'));
  fs.writeFileSync(target, html, 'utf8');
  console.log('remaining external URLs:', left.length ? left.join(', ') : 'none');
  console.log('final size:', (Buffer.byteLength(html) / 1024).toFixed(1), 'KB');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
