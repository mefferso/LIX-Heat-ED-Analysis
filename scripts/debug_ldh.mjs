import { chromium } from "playwright";
import fs from "fs";

const URL="https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1200}});
const captures=[];

page.on("response", async (resp)=>{
  const url=resp.url();
  if (!url.includes("analytics.la.gov")) return;
  if (!/bootstrap|sessions|vizql/i.test(url)) return;
  try {
    const body=await resp.text();
    captures.push({
      url,
      status:resp.status(),
      contentType:resp.headers()["content-type"]||"",
      length:body.length,
      first:body.slice(0,1200),
      hasDataSegments:body.includes("dataSegments"),
      hasHri:body.includes("HRI Epi Curve"),
      dataSegmentsPos:body.indexOf("dataSegments"),
      hriPos:body.indexOf("HRI Epi Curve")
    });
    if (url.includes("bootstrap") && body.length>10000) {
      fs.writeFileSync("data/ldh_bootstrap_raw.txt",body);
    }
  } catch {}
});

await page.goto(URL,{waitUntil:"domcontentloaded",timeout:120000});
await page.waitForFunction(()=>document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"),null,{timeout:120000});
await page.waitForTimeout(7000);
fs.writeFileSync("data/ldh_bootstrap_debug.json",JSON.stringify(captures,null,2));
console.log(JSON.stringify(captures.map(c=>({url:c.url,length:c.length,hasDataSegments:c.hasDataSegments,hasHri:c.hasHri,first:c.first.slice(0,150)})),null,2));
await browser.close();
