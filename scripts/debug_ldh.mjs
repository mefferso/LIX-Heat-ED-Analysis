import { chromium } from "playwright";
import fs from "fs";

const URL="https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";

function summarizeRoot(root,label) {
  const app=root?.vqlCmdResponse?.layoutStatus?.applicationPresModel;
  const segments=app?.dataDictionary?.dataSegments||{};
  const zones=app?.workbookPresModel?.dashboardPresModel?.zones||{};
  const zone=Object.values(zones).find(z=>z?.worksheet==="HRI Epi Curve");
  const pcd=zone?.presModelHolder?.visual?.vizData?.paneColumnsData;
  const metas=pcd?.vizDataColumns||[];
  const panes=pcd?.paneColumnsList||[];
  const paneIndex=panes.findIndex(p=>(p?.paneDescriptor?.yFields||[]).some(x=>String(x).includes("Cases HRI")));
  const cols=paneIndex>=0?(panes[paneIndex]?.vizPaneColumns||[]):[];

  return {
    label,
    segmentKeys:Object.keys(segments),
    segments:Object.entries(segments).map(([key,seg])=>({
      key,
      columns:(seg?.dataColumns||[]).map(c=>({
        dataType:c.dataType,
        keys:Object.keys(c),
        count:(c.dataValues||[]).length,
        sample:(c.dataValues||[]).slice(0,12)
      }))
    })),
    metas:metas.map(m=>({
      caption:m.fieldCaption,
      dataType:m.dataType,
      paneIndices:m.paneIndices,
      columnIndices:m.columnIndices,
      keys:Object.keys(m)
    })),
    paneIndex,
    columns:cols.map((c,i)=>({
      i,
      keys:Object.keys(c),
      obj:c
    }))
  };
}

async function command(page,action,needle=null) {
  const p=page.waitForResponse(r=>r.status()===200 && r.url().includes("/commands/tabdoc/") &&
    (!needle || r.url().includes(needle)),{timeout:60000});
  await action();
  const resp=await p;
  return JSON.parse(await resp.text());
}

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1200}});
page.setDefaultTimeout(120000);

const boot=page.waitForResponse(r=>r.status()===200&&r.url().includes("/bootstrapSession/"),{timeout:120000});
await page.goto(URL,{waitUntil:"domcontentloaded",timeout:120000});
await boot;
await page.waitForFunction(()=>document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"),null,{timeout:120000});
await page.waitForTimeout(4000);

const combo=page.getByRole("combobox");
await combo.click();
const seasonRoot=await command(page,async()=>{
  await page.getByRole("option",{name:"2025",exact:true}).click();
});
await page.waitForTimeout(1200);

const regionButton=page.getByRole("button",{name:/^Region /});
await regionButton.click();
const regionRoot=await command(page,async()=>{
  await page.getByRole("menuitem",{name:"1 - Southeast",exact:true}).click();
},"set-parameter-value-from-index");
await page.waitForTimeout(800);

const out={
  seasonControl:(await combo.innerText()).trim(),
  regionControl:await regionButton.getAttribute("aria-label"),
  season:summarizeRoot(seasonRoot,"season-2025"),
  region:summarizeRoot(regionRoot,"region-1-2025")
};

fs.writeFileSync("data/ldh_api_probe.json",JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify({
  seasonControl:out.seasonControl,
  regionControl:out.regionControl,
  seasonSegmentKeys:out.season.segmentKeys,
  seasonSegments:out.season.segments.map(s=>({key:s.key,columns:s.columns.map(c=>({dataType:c.dataType,count:c.count,sample:c.sample}))})),
  regionSegmentKeys:out.region.segmentKeys,
  regionSegments:out.region.segments.map(s=>({key:s.key,columns:s.columns.map(c=>({dataType:c.dataType,count:c.count,sample:c.sample}))})),
  seasonDateColumn:out.season.columns.find(c=>c.i===1),
  regionDateColumn:out.region.columns.find(c=>c.i===1)
},null,2));
await browser.close();
