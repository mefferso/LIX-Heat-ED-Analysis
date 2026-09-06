import { chromium } from "playwright";
import fs from "fs";

const URL = "https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1200}});
const responses = [];

page.on("response", async (resp) => {
  const url = resp.url();
  if (url.includes("/commands/tabdoc/")) {
    responses.push({url, status:resp.status(), contentType:resp.headers()["content-type"] || ""});
  }
});

await page.goto(URL, {waitUntil:"domcontentloaded", timeout:120000});
await page.waitForTimeout(12000);

const result = await page.evaluate(() => {
  const compact = (el) => ({
    tag: el.tagName,
    id: el.id,
    cls: el.className,
    role: el.getAttribute("role"),
    aria: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
    text: (el.innerText || el.textContent || "").trim().replace(/\s+/g," ").slice(0,500),
    html: el.outerHTML.slice(0,1500)
  });
  const selects = [...document.querySelectorAll("select")].map(compact);
  const combo = [...document.querySelectorAll('[role="combobox"]')].map(compact);
  const buttons = [...document.querySelectorAll('button,[role="button"]')]
    .filter(el => /region|season|2026|southeast|northshore|capital/i.test((el.innerText||el.textContent||"")+" "+(el.getAttribute("aria-label")||"")+" "+(el.getAttribute("title")||"")))
    .map(compact);
  const textMatches = [...document.querySelectorAll("body *")]
    .filter(el => {
      const t=(el.innerText||el.textContent||"").trim();
      return t === "Region" || t === "Season" || /^202[3-6]$/.test(t) || /Northshore|Southeast|Capital Region|South Central/.test(t);
    })
    .slice(0,80)
    .map(compact);
  return {
    title: document.title,
    bodyText: (document.body.innerText || "").slice(0,12000),
    selects, combo, buttons, textMatches
  };
});

result.commandResponses = responses.slice(-30);
fs.mkdirSync("data", {recursive:true});
fs.writeFileSync("data/ldh_probe.json", JSON.stringify(result,null,2));
await page.screenshot({path:"data/ldh_probe.png", fullPage:true});
await browser.close();
