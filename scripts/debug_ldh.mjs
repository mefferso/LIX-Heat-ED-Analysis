import { chromium } from "playwright";
import fs from "fs";

const URL="https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1200}});
page.setDefaultTimeout(60000);
await page.goto(URL,{waitUntil:"domcontentloaded",timeout:120000});
await page.waitForFunction(()=>document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"),null,{timeout:120000});
await page.waitForTimeout(6000);

const button=page.getByRole("button",{name:/^Region /});
await button.click();
const wait=page.waitForResponse(r=>r.status()===200 && r.url().includes("set-parameter-value-from-index"),{timeout:60000});
await page.getByRole("menuitem",{name:"1 - Southeast",exact:true}).click();
const resp=await wait;
const text=await resp.text();
const root=JSON.parse(text);
const app=root?.vqlCmdResponse?.layoutStatus?.applicationPresModel;
const segments=app?.dataDictionary?.dataSegments||{};
const zones=app?.workbookPresModel?.dashboardPresModel?.zones||{};
const zone=Object.values(zones).find(z=>z?.worksheet==="HRI Epi Curve");
const pcd=zone?.presModelHolder?.visual?.vizData?.paneColumnsData;

const out={
  url:resp.url(),
  bodyLength:text.length,
  segmentKeys:Object.keys(segments),
  segments:Object.entries(segments).map(([key,seg])=>({
    key,
    isNull:!seg,
    columns:(seg?.dataColumns||[]).map(c=>({
      dataType:c.dataType,
      valueCount:Array.isArray(c.dataValues)?c.dataValues.length:null,
      sample:Array.isArray(c.dataValues)?c.dataValues.slice(0,8):null
    }))
  })),
  zoneFound:Boolean(zone),
  zoneKeys:zone?Object.keys(zone):[],
  visualValid:zone?.presModelHolder?.visual?.valid,
  metas:(pcd?.vizDataColumns||[]).map(m=>({
    caption:m.fieldCaption,dataType:m.dataType,paneIndices:m.paneIndices,columnIndices:m.columnIndices
  })),
  panes:(pcd?.paneColumnsList||[]).map(p=>({
    descriptor:p.paneDescriptor,
    cols:(p.vizPaneColumns||[]).map((c,i)=>({
      i,
      valueLen:(c.valueIndices||[]).length,
      aliasLen:(c.aliasIndices||[]).length,
      valueSample:(c.valueIndices||[]).slice(0,8),
      aliasSample:(c.aliasIndices||[]).slice(0,8)
    }))
  }))
};
fs.writeFileSync("data/ldh_debug_live.json",JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
await browser.close();
