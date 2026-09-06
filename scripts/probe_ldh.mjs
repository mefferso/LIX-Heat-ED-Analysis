import { chromium } from "playwright";
import fs from "fs";

const URL = "https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1200}});
await page.goto(URL, {waitUntil:"domcontentloaded", timeout:120000});
await page.waitForTimeout(10000);

async function snapshot(label) {
  return await page.evaluate((label) => {
    const items=[...document.querySelectorAll('[role="option"],[role="menuitem"],[role="listbox"],[role="menu"],.FIItem,.tabMenuItem,.tabMenuItemName,.tabComboBoxMenuItem')]
      .filter(el => {
        const s=getComputedStyle(el);
        const r=el.getBoundingClientRect();
        return s.visibility!=="hidden" && s.display!=="none" && r.width>0 && r.height>0;
      })
      .map(el=>({
        tag:el.tagName,role:el.getAttribute("role"),cls:el.className,
        aria:el.getAttribute("aria-label"),
        text:(el.innerText||el.textContent||"").trim().replace(/\s+/g," ").slice(0,300),
        html:el.outerHTML.slice(0,1200)
      }));
    return {label,items};
  }, label);
}

const out={};
const season=page.getByRole("combobox");
out.seasonBefore=await season.count();
await season.click();
await page.waitForTimeout(800);
out.seasonOpen=await snapshot("season");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

const region=page.getByRole("button",{name:/^Region /});
out.regionBefore=await region.count();
await region.click();
await page.waitForTimeout(800);
out.regionOpen=await snapshot("region");
await page.keyboard.press("Escape");

fs.writeFileSync("data/ldh_probe.json",JSON.stringify(out,null,2));
await browser.close();
