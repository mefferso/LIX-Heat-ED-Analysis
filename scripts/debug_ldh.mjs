import { chromium } from "playwright";
import fs from "fs";

const URL="https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";

function parseChunks(body) {
  const chunks=[];
  let pos=0;
  while (pos<body.length) {
    while (pos<body.length && /\s/.test(body[pos])) pos++;
    const semi=body.indexOf(";",pos);
    if (semi<0) break;
    const len=Number(body.slice(pos,semi));
    if (!Number.isFinite(len) || len<1) break;
    const start=semi+1;
    const raw=body.slice(start,start+len);
    try { chunks.push(JSON.parse(raw)); }
    catch (e) { chunks.push({__parseError:String(e),__rawStart:raw.slice(0,200)}); }
    pos=start+len;
  }
  return chunks;
}

function summarizeSegments(segments) {
  return Object.entries(segments||{}).map(([key,seg])=>({
    key,
    isNull:!seg,
    columns:(seg?.dataColumns||[]).map(c=>({
      dataType:c.dataType,
      valueCount:Array.isArray(c.dataValues)?c.dataValues.length:null,
      sample:Array.isArray(c.dataValues)?c.dataValues.slice(0,8):null
    }))
  }));
}

function walk(obj,path,out,seen) {
  if (!obj || typeof obj!=="object" || seen.has(obj)) return;
  seen.add(obj);
  if (Object.prototype.hasOwnProperty.call(obj,"dataSegments")) {
    out.dataSegments.push({path:path+".dataSegments",summary:summarizeSegments(obj.dataSegments)});
  }
  if (obj.worksheet==="HRI Epi Curve") {
    out.hriObjects.push({path,keys:Object.keys(obj),zoneId:obj.zoneId||null});
  }
  for (const [k,v] of Object.entries(obj)) {
    if (v && typeof v==="object") walk(v,path+"."+k,out,seen);
  }
}

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1200}});
let bootstrapBody=null;
page.on("response",async resp=>{
  if (resp.url().includes("/bootstrapSession/") && resp.status()===200) {
    try { bootstrapBody=await resp.text(); } catch {}
  }
});
await page.goto(URL,{waitUntil:"domcontentloaded",timeout:120000});
await page.waitForFunction(()=>document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"),null,{timeout:120000});
await page.waitForTimeout(7000);
if (!bootstrapBody) throw new Error("No Tableau bootstrap response captured");

const chunks=parseChunks(bootstrapBody);
const out={
  bodyLength:bootstrapBody.length,
  chunkCount:chunks.length,
  chunks:chunks.map((chunk,i)=>{
    const found={dataSegments:[],hriObjects:[]};
    walk(chunk,"$",found,new WeakSet());
    return {
      i,
      topKeys:Object.keys(chunk||{}),
      parseError:chunk?.__parseError||null,
      dataSegments:found.dataSegments,
      hriObjects:found.hriObjects.slice(0,10)
    };
  })
};
fs.writeFileSync("data/ldh_api_probe.json",JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify(out,null,2));
await browser.close();
