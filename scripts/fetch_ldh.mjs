import { chromium } from "playwright";
import fs from "fs";

const DASHBOARD_URL = "https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard?:showVizHome=no";
const YEARS = [2026, 2025, 2024, 2023];
const REGIONS = [
  {id:"1", label:"1 - Southeast", name:"Southeast"},
  {id:"2", label:"2 - Capital Region", name:"Capital Region"},
  {id:"3", label:"3 - South Central", name:"South Central"},
  {id:"9", label:"9 - Northshore", name:"Northshore"}
];

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s;
}

function decodeColumn(meta, column, dictionaries) {
  const dict = dictionaries.get(meta.dataType) || [];
  const valueIndices = column.valueIndices || [];
  const aliasIndices = column.aliasIndices || [];
  const indices = valueIndices.length ? valueIndices : aliasIndices;
  return indices.map((idx) => idx >= 0 && idx < dict.length ? dict[idx] : null);
}

function extractEpiCurve(text, expectedYear) {
  const root = JSON.parse(text);
  const app = root?.vqlCmdResponse?.layoutStatus?.applicationPresModel;
  if (!app) throw new Error("Tableau response did not include applicationPresModel.");

  const zones = app?.workbookPresModel?.dashboardPresModel?.zones || {};
  const zone = Object.values(zones).find((z) => z?.worksheet === "HRI Epi Curve");
  if (!zone) throw new Error("Could not find HRI Epi Curve worksheet in Tableau response.");

  const segments = app?.dataDictionary?.dataSegments || {};
  const segment = segments["0"] || Object.values(segments).find(Boolean);
  if (!segment?.dataColumns) throw new Error("Tableau data dictionary was missing.");

  const dictionaries = new Map();
  for (const col of segment.dataColumns) {
    if (!dictionaries.has(col.dataType)) dictionaries.set(col.dataType, col.dataValues || []);
  }

  const paneData = zone?.presModelHolder?.visual?.vizData?.paneColumnsData;
  const metas = paneData?.vizDataColumns || [];
  const panes = paneData?.paneColumnsList || [];

  let paneIndex = panes.findIndex((p) =>
    (p?.paneDescriptor?.yFields || []).some((f) => String(f).includes("Cases HRI"))
  );
  if (paneIndex < 0) paneIndex = 0;

  const paneColumns = panes[paneIndex]?.vizPaneColumns || [];

  function columnForCaption(caption) {
    const meta = metas.find((m) => m?.fieldCaption === caption);
    if (!meta) throw new Error("Missing Tableau field: " + caption);
    const pos = (meta.paneIndices || []).indexOf(paneIndex);
    if (pos < 0) throw new Error("Field " + caption + " is not in HRI pane.");
    const columnIndex = meta.columnIndices[pos];
    const column = paneColumns[columnIndex];
    if (!column) throw new Error("Missing pane column for " + caption);
    return {meta, column};
  }

  const dateCol = columnForCaption("Date Axis");
  const casesCol = columnForCaption("SUM(Cases HRI)");
  const dates = decodeColumn(dateCol.meta, dateCol.column, dictionaries);
  const cases = decodeColumn(casesCol.meta, casesCol.column, dictionaries);

  if (!dates.length || dates.length !== cases.length) {
    throw new Error("HRI date/count lengths do not match: " + dates.length + " vs " + cases.length);
  }

  const rows = dates.map((date, i) => ({
    date: String(date).slice(0,10),
    ed_visits: Number(cases[i] ?? 0)
  })).filter((r) => r.date.startsWith(String(expectedYear)));

  if (rows.length < 100) {
    throw new Error("Only " + rows.length + " daily HRI rows decoded for " + expectedYear + ".");
  }
  return rows;
}

async function waitForCommand(page, action, match = () => true) {
  const responsePromise = page.waitForResponse(
    (resp) => resp.status() === 200 &&
      resp.url().includes("/commands/tabdoc/") &&
      !resp.url().includes("notify-first-client-render") &&
      match(resp),
    {timeout:60000}
  );
  await action();
  return await responsePromise;
}

async function setSeason(page, year) {
  const combo = page.getByRole("combobox");
  const current = (await combo.innerText()).trim();
  if (current === String(year)) return;

  await combo.click();
  const option = page.getByRole("option", {name:String(year), exact:true});
  await waitForCommand(page, async () => {
    await option.click();
  });
  await page.waitForTimeout(1200);

  const reset = page.getByText("Reset Filter", {exact:true});
  if (await reset.count()) {
    try {
      await waitForCommand(page, async () => {
        await reset.first().click();
      });
      await page.waitForTimeout(900);
    } catch {
      // Reset is defensive; a full-domain season change may not need it.
    }
  }

  const after = (await combo.innerText()).trim();
  if (after !== String(year)) {
    throw new Error("Season selector expected " + year + " but shows " + after);
  }
}

async function selectRegionAndExtract(page, region, year) {
  const regionButton = page.getByRole("button", {name:/^Region /});
  await regionButton.click();
  const item = page.getByRole("menuitem", {name:region.label, exact:true});

  const response = await waitForCommand(
    page,
    async () => { await item.click(); },
    (resp) => resp.url().includes("set-parameter-value-from-index")
  );
  const body = await response.text();
  const rows = extractEpiCurve(body, year);

  const currentLabel = await regionButton.getAttribute("aria-label");
  if (!String(currentLabel).includes(region.label)) {
    throw new Error("Region selector did not switch to " + region.label + "; got " + currentLabel);
  }
  return rows;
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1200}});
page.setDefaultTimeout(60000);

console.log("Opening LDH Tableau dashboard...");
await page.goto(DASHBOARD_URL, {waitUntil:"domcontentloaded", timeout:120000});
await page.waitForFunction(() => document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"), null, {timeout:120000});
await page.waitForTimeout(7000);

const bodyText = await page.locator("body").innerText();
const updatedMatch = bodyText.match(/Last Updated:\s*([0-9/]+)/i);
const sourceUpdated = updatedMatch ? updatedMatch[1] : "";

const output = [];
const diagnostics = [];

for (const year of YEARS) {
  console.log("Selecting season", year);
  await setSeason(page, year);

  for (const region of REGIONS) {
    console.log("Extracting", year, region.label);
    let rows;
    let lastError;
    for (let attempt=1; attempt<=3; attempt++) {
      try {
        rows = await selectRegionAndExtract(page, region, year);
        break;
      } catch (err) {
        lastError = err;
        console.warn("Attempt", attempt, "failed:", err.message);
        await page.waitForTimeout(1500);
      }
    }
    if (!rows) throw lastError;

    diagnostics.push({
      year,
      region:region.id,
      region_name:region.name,
      row_count:rows.length,
      first_date:rows.at(-1)?.date || "",
      last_date:rows[0]?.date || "",
      sum_ed_visits:rows.reduce((a,b)=>a+b.ed_visits,0)
    });

    for (const row of rows) {
      output.push({
        date:row.date,
        season:year,
        ldh_region:region.id,
        region_name:region.name,
        ed_visits:row.ed_visits,
        source_updated:sourceUpdated
      });
    }
  }
}

output.sort((a,b) => a.date.localeCompare(b.date) || a.ldh_region.localeCompare(b.ldh_region));
fs.mkdirSync("data", {recursive:true});

const header = ["date","season","ldh_region","region_name","ed_visits","source_updated"];
const csv = [
  header.join(","),
  ...output.map((r) => header.map((k)=>csvEscape(r[k])).join(","))
].join("\n") + "\n";

fs.writeFileSync("data/ldh_heat_region_daily.csv", csv);
fs.writeFileSync("data/ldh_meta.json", JSON.stringify({
  fetched_at:new Date().toISOString(),
  source_updated:sourceUpdated,
  dashboard:DASHBOARD_URL,
  years:YEARS,
  regions:REGIONS,
  rows:output.length,
  diagnostics
}, null, 2) + "\n");

console.log(JSON.stringify({sourceUpdated, rows:output.length, diagnostics}, null, 2));
await browser.close();
