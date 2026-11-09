// Asks Meta directly for whole-period totals (no daily breakdown) — last month,
// this month, all time — and checks the tracker's day-by-day sums match to the cent.
// Run after pull-meta.js:  node verify-periods.js
// Its own folder, so the same file works on the laptop and on a cloud runner.
// It used to name the Desktop folder outright, which is the one path that does
// not exist on a Linux runner.
const fs=require('fs'),https=require('https'),path=require('path'),D=__dirname+path.sep;
const CFG=JSON.parse(fs.readFileSync(D+'config.json','utf8'));
const tok=fs.readFileSync(D+'meta-token.txt','utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'))[0];
const DATA=JSON.parse(fs.readFileSync(D+'meta-data.json','utf8'));
const get=u=>new Promise((res,rej)=>https.get(u,r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{const j=JSON.parse(s);j.error?rej(new Error(j.error.message)):res(j);});}).on('error',rej));
const LEAD=CFG.leadActionTypes||['onsite_conversion.lead_grouped'];
const leadsOf=r=>{let n=0;(r.actions||[]).forEach(x=>{if(x.action_type===LEAD[0])n=+x.value;});return n;};
async function meta(since,until){
  const u='https://graph.facebook.com/'+CFG.apiVersion+'/act_'+CFG.accountId+'/insights?level=campaign&limit=500&fields=campaign_name,spend,actions&time_range='+encodeURIComponent(JSON.stringify({since,until}))+'&access_token='+encodeURIComponent(tok);
  const j=await get(u); let all=0,mine=0,ml=0;
  j.data.forEach(r=>{all+=+r.spend; if(CFG.excludeCampaigns.includes(r.campaign_name))return; mine+=+r.spend; ml+=leadsOf(r);});
  return {all:+all.toFixed(2),mine:+mine.toFixed(2),leads:ml};
}
function ours(since,until){let s=0,l=0;for(const[d,cs]of Object.entries(DATA.days)){if(d<since||d>until)continue;for(const v of Object.values(cs)){s+=v.spent;l+=v.leads;}}return{spent:+s.toFixed(2),leads:l};}
/* last month, this month and all time, through the last day the data holds */
const ymd=d=>d.toISOString().slice(0,10);
const until=DATA.range.until, u=new Date(until+'T12:00:00Z');
const m0=ymd(new Date(Date.UTC(u.getUTCFullYear(),u.getUTCMonth(),1,12)));
const m1a=ymd(new Date(Date.UTC(u.getUTCFullYear(),u.getUTCMonth()-1,1,12)));
const m1b=ymd(new Date(Date.UTC(u.getUTCFullYear(),u.getUTCMonth(),0,12)));
/* today is still spending while we check, so compare finished days only */
const done=ymd(new Date(u.getTime()-864e5));
const PERIODS=[['Last month',m1a,m1b],['This month',m0,done],['All time',CFG.firstDay||DATA.range.since,done]]
  .filter(p=>p[1]<=p[2]);
(async()=>{
  let bad=0;
  for(const [lbl,a,b] of PERIODS){
    const m=await meta(a,b), o=ours(a,b), ok=m.mine===o.spent&&m.leads===o.leads;
    if(!ok)bad++;
    console.log((lbl+' ('+a+' to '+b+')                    ').slice(0,36),'Meta $'+m.mine.toFixed(2)+' '+m.leads+' leads | tracker $'+o.spent.toFixed(2)+' '+o.leads+' leads | '+(ok?'MATCH':'MISMATCH'));
  }
  console.log(bad?'PERIOD CHECK FAILED — '+bad+' period(s) differ from Meta':'Every period matches Meta exactly.');
  process.exitCode=bad?1:0;
})().catch(e=>{console.log('ERROR',e.message);process.exitCode=1;});
