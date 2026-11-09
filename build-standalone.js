const fs = require('fs');
const src = fs.readFileSync('marketing-pillar-tracker.html', 'utf8');

const iStyle = src.indexOf('</style>') + '</style>'.length;
const iScript = src.indexOf('\n<script>');
const stylePart = src.slice(0, iStyle);
let markup = src.slice(iStyle, iScript);
let script = src.slice(iScript).replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');

/* 1. toolbar: add Back up / Restore */
const snapBtn = '<button class="btn" id="snapBtn">Save snapshot</button>';
if (markup.indexOf(snapBtn) < 0) throw new Error('snapBtn not found');
markup = markup.replace(snapBtn,
  '<button class="btn" id="backupBtn">Back up</button>\n' +
  '    <label class="btn" for="restoreInput" style="cursor:pointer">Restore</label>\n' +
  '    <input id="restoreInput" type="file" accept=".json,application/json" hidden>\n' +
  '    ' + snapBtn);

/* 2. real browser download instead of the Claude downloads capability */
const dlBlock = [
  '  if(downloadsRef){',
  '    downloadsRef.save({filename:name,data:csv}).catch(function(e){',
  '      if(e&&e.code==="declined")return;',
  '      notify("The export did not go through"+(e&&e.message?": "+e.message:"."));',
  '    });',
  '  } else {',
  '    notify("Saving files is not available in this view. Open the tracker in the Claude app to export a CSV.");',
  '  }'
].join('\n');
if (script.indexOf(dlBlock) < 0) throw new Error('download block not found');
script = script.replace(dlBlock, '  downloadFile(name,csv,"text/csv;charset=utf-8");');

/* 2b. inline the PDF libraries — the shared file loads nothing from the
   internet, and the Sierra sheets are drawn with jsPDF. Same pinned builds
   the page names, read from vendor/ rather than fetched. */
const VENDOR = [
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'vendor/jspdf.umd.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js', 'vendor/jspdf.plugin.autotable.min.js']
];
VENDOR.forEach(([url, file]) => {
  const tag = '<script src="' + url + '"><\/script>';
  if (markup.indexOf(tag) < 0) throw new Error('script tag not found: ' + url);
  if (!fs.existsSync(file)) throw new Error('missing ' + file + ' — the offline build needs it');
  const code = fs.readFileSync(file, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  markup = markup.replace(tag, '<script>/* ' + file + ' */\n' + code + '\n<\/script>');
});

/* 3. drop the Claude boot */
const cut = script.indexOf('/* ---------------- boot ---------------- */');
if (cut < 0) throw new Error('boot marker not found');
script = script.slice(0, cut);

const seedRows = [
  { id: "meta30_sellers", pillar: "meta", segment: "prospect", name: "sellers ad",
    about: "Seller lead generation, instant form (Results = Leads (Form)). Creative/offer not reviewed — add the hook here.",
    status: "live", start: "2026-09-14", end: "2026-10-13", ageRange: "", gender: "All",
    leadAges: "45–54 (2), 55–64 (1)",
    ageSpend: "18–24:1.21, 25–34:4.85, 35–44:15.96, 45–54:17.07, 55–64:16.32, 65+:17.68",
    audience: "", areas: "Alberta", budget: 0, spent: 73.09, leads: 3, clients: 0, clientNotes: "",
    notes: "LAST 7 DAYS (Oct 7–13, 2026): $73.09 spent, 3 leads, $24.36 CPL — the entire 30-day spend landed in the last 7 days. Meta daily budget $15.00. Impressions 1,197, reach 657. Attribution: 7-day click or 1-day view. Dates above are the reporting window, not the campaign flight. Source: Micah's ads (1393324416262592), pulled Oct 14, 2026 for Sep 14 – Oct 13." },
  { id: "meta30_buyers", pillar: "meta", segment: "prospect", name: "Buyers Campaign",
    about: "Buyer lead generation, instant form (Results = Leads (Form)). Creative/offer not reviewed — add the hook here.",
    status: "live", start: "2026-09-14", end: "2026-10-13", ageRange: "", gender: "All",
    leadAges: "", ageSpend: "", audience: "Age split not captured for this window",
    areas: "Alberta", budget: 0, spent: 153.03, leads: 9, clients: 0, clientNotes: "",
    notes: "LAST 7 DAYS (Oct 7–13, 2026): $134.06 spent, 8 leads, $16.76 CPL — so 88% of the 30-day spend and 8 of the 9 leads landed in the last week. Meta daily budget $20.00. Impressions 4,654, reach 2,781. Has 1 open Meta recommendation. Source: Micah's ads, pulled Oct 14, 2026 for Sep 14 – Oct 13." },
  { id: "meta30_2021_27ave", pillar: "meta", segment: "prospect", name: "2021 27 Avenue SW",
    about: "Single-listing ad for 2021 27 Avenue SW. Lead form objective. Creative not reviewed.",
    status: "done", start: "2026-09-14", end: "2026-10-13", ageRange: "", gender: "All",
    leadAges: "", ageSpend: "", audience: "", areas: "Alberta", budget: 0, spent: 71.47, leads: 0, clients: 0, clientNotes: "",
    notes: "ZERO LEADS on $71.47 — worst performer in the account. LAST 7 DAYS (Oct 7–13, 2026): $0.00, no delivery. Meta daily budget $20.00. Impressions 2,391, reach 1,571. Campaign is Off. Source: Micah's ads, pulled Oct 14, 2026 for Sep 14 – Oct 13." },
  { id: "meta30_buyers_sellers", pillar: "meta", segment: "prospect", name: "Buyers & Sellers campaign",
    about: 'Combined buyer and seller campaign. Results reported as "Leads" (not Leads (Form)) — a different result type from the other campaigns.',
    status: "done", start: "2026-09-14", end: "2026-10-13", ageRange: "", gender: "All",
    leadAges: "", ageSpend: "", audience: "", areas: "Alberta", budget: 0, spent: 365.29, leads: 18, clients: 0, clientNotes: "",
    notes: 'BIGGEST SPEND in the account ($365.29, 50% of the 30-day total) and the most leads (18). LAST 7 DAYS (Oct 7–13, 2026): $0.00, no delivery. Meta daily budget $20.00. Impressions 8,456, reach 3,356. Campaign is Off. Result type is "Leads", not "Leads (Form)", so its $20.29 is not strictly comparable. Source: Micah\'s ads, pulled Oct 14, 2026 for Sep 14 – Oct 13.' },
  { id: "meta30_chaparral", pillar: "meta", segment: "prospect", name: "Micah's Chaparral Listing",
    about: "Single-listing ad for a Chaparral property. Lead form objective. Creative not reviewed.",
    status: "done", start: "2026-09-14", end: "2026-10-13", ageRange: "", gender: "All",
    leadAges: "", ageSpend: "", audience: "", areas: "Alberta", budget: 0, spent: 70.32, leads: 7, clients: 0, clientNotes: "",
    notes: "BEST COST PER LEAD in the account at $10.05 — half the account average. LAST 7 DAYS (Oct 7–13, 2026): $0.00, no delivery. Meta daily budget $15.00. Impressions 2,968, reach 1,606. Campaign is Off. Source: Micah's ads, pulled Oct 14, 2026 for Sep 14 – Oct 13." }
];

const seedSnaps = [{
  id: "s_base_20261013", label: "Week of Oct 13, 2026 — baseline", takenAt: "2026-10-13T12:00:00.000Z", count: 5,
  rows: {
    meta30_sellers: { name: "sellers ad", pillar: "meta", segment: "prospect", spent: 54.66, leads: 3, clients: 0 },
    meta30_buyers: { name: "Buyers Campaign", pillar: "meta", segment: "prospect", spent: 132.59, leads: 8, clients: 0 },
    meta30_2021_27ave: { name: "2021 27 Avenue SW", pillar: "meta", segment: "prospect", spent: 71.47, leads: 0, clients: 0 },
    meta30_buyers_sellers: { name: "Buyers & Sellers campaign", pillar: "meta", segment: "prospect", spent: 365.29, leads: 18, clients: 0 },
    meta30_chaparral: { name: "Micah's Chaparral Listing", pillar: "meta", segment: "prospect", spent: 84.57, leads: 8, clients: 0 }
  },
  totals: { budget: 0, spent: 708.58, leads: 37, clients: 0 }
}];

script += [
  '',
  '/* ---------------- standalone: file saving, backup, boot ---------------- */',
  'function downloadFile(name,text,type){',
  '  try{',
  '    var blob=new Blob([text],{type:type||"text/plain;charset=utf-8"});',
  '    var url=URL.createObjectURL(blob);',
  '    var a=document.createElement("a");',
  '    a.href=url; a.download=name; a.style.display="none";',
  '    document.body.appendChild(a); a.click();',
  '    setTimeout(function(){URL.revokeObjectURL(url);a.remove();},1500);',
  '  }catch(e){ notify("This browser blocked the download. Try Chrome, Edge or Firefox."); }',
  '}',
  'function backupJson(){',
  '  downloadFile("marketing-tracker-backup-"+new Date().toISOString().slice(0,10)+".json",',
  '    JSON.stringify({version:1,savedAt:new Date().toISOString(),rows:rows,snaps:snaps},null,2),',
  '    "application/json");',
  '}',
  'function restoreJson(file){',
  '  var fr=new FileReader();',
  '  fr.onload=function(){',
  '    try{',
  '      var d=JSON.parse(fr.result);',
  '      if(!d||!Array.isArray(d.rows))throw new Error("that file is not a tracker backup");',
  '      rows=d.rows; snaps=Array.isArray(d.snaps)?d.snaps:[];',
  '      view.compare=""; localSave(); render();',
  '      notify("Restored "+rows.length+" entr"+(rows.length===1?"y":"ies")+" and "+snaps.length+" snapshot"+(snaps.length===1?"":"s")+".");',
  '    }catch(e){ notify("Could not read that backup: "+e.message+"."); }',
  '  };',
  '  fr.onerror=function(){ notify("Could not read that file."); };',
  '  fr.readAsText(file);',
  '}',
  'var SEED_ROWS=' + JSON.stringify(seedRows) + ';',
  'var SEED_SNAPS=' + JSON.stringify(seedSnaps) + ';',
  '',
  'document.getElementById("restoreInput").addEventListener("change",function(e){',
  '  var f=e.target.files&&e.target.files[0];',
  '  if(f)restoreJson(f);',
  '  e.target.value="";',
  '});',
  'document.addEventListener("click",function(e){',
  '  if(e.target&&e.target.closest&&e.target.closest("#backupBtn"))backupJson();',
  '});',
  '',
  'if(typeof SEED_DAYS!=="undefined")DAYS=SEED_DAYS;',
  'if(typeof SEED_SIERRA!=="undefined")SIERRA=SEED_SIERRA;',
  '/* the ads running now, with their stills carried inside this file */',
  'if(typeof SEED_ADS!=="undefined"&&SEED_ADS&&SEED_ADS.length)ADS=SEED_ADS;',
  'if(typeof SEED_UPDATED!=="undefined")DATA_AT=SEED_UPDATED;',
  'canWrite=true;',
  'localLoad();',
  'var local={rows:rows.slice(),snaps:snaps.slice()};',
  'rows=JSON.parse(JSON.stringify(SEED_ROWS));',
  'snaps=JSON.parse(JSON.stringify(SEED_SNAPS));',
  'var USER_FIELDS=["clients","clientNotes","about","source","leadList","budget","segment","areas","gender","ageRange","ageSpend","leadAges","audience","community","feedback"];',
  'local.rows.forEach(function(o){',
  '  var r=rows.filter(function(x){return x.id===o.id;})[0];',
  '  if(!r){ if(o.pillar&&o.pillar!=="meta") rows.push(o); return; }',
  '  USER_FIELDS.forEach(function(k){ if(o[k]!==undefined&&o[k]!==""&&o[k]!==0) r[k]=o[k]; });',
  '  var mine={}; (o.leadRecords||[]).forEach(function(x){ if(x.id) mine[x.id]=x; });',
  '  (r.leadRecords||[]).forEach(function(x){ var m=mine[x.id]; if(m){ if(m.quality) x.quality=m.quality; if(m.agent) x.agent=m.agent; } });',
  '});',
  'local.snaps.forEach(function(sn){ if(!snaps.some(function(x){return x.id===sn.id;})) snaps.push(sn); });',
  'localSave();',
  'ready=true;',
  'render();',
  ''
].join('\n');

const reset = '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5}' +
  'img{max-width:100%}[hidden]{display:none!important}</style>';

const out = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  reset + '\n' + stylePart + '\n</head>\n<body>\n' + markup + '\n<script>\n' + script +
  '\n<' + '/script>\n</body>\n</html>\n';

fs.writeFileSync('Marketing Pillar Tracker.html', out, 'utf8');
console.log('written bytes:', Buffer.byteLength(out));
