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

function parseLengthPrefixedJson(body) {
  const chunks = [];
  let pos = 0;
  while (pos < body.length) {
    while (pos < body.length && /\s/.test(body[pos])) pos++;
    const semi = body.indexOf(";", pos);
    if (semi < 0) break;
    const len = Number(body.slice(pos, semi));
    if (!Number.isFinite(len) || len <= 0) break;
    const start = semi + 1;
    const raw = body.slice(start, start + len);
    chunks.push(JSON.parse(raw));
    pos = start + len;
  }
  return chunks;
}

class TableauDictionary {
  constructor() {
    this.values = new Map();
    this.appliedSegments = new Set();
  }

  appendSegments(segments) {
    for (const [segmentId, segment] of Object.entries(segments || {})) {
      if (!segment || this.appliedSegments.has(String(segmentId))) continue;

      for (const col of segment.dataColumns || []) {
        const dataType = col.dataType;
        if (!dataType) continue;
        if (!this.values.has(dataType)) this.values.set(dataType, []);
        const target = this.values.get(dataType);
        for (const value of col.dataValues || []) target.push(value);
      }
      this.appliedSegments.add(String(segmentId));
    }
  }

  decode(meta, column) {
    const dict = this.values.get(meta.dataType) || [];
    const valueIndices = column.valueIndices || [];
    const aliasIndices = column.aliasIndices || [];
    const indices = valueIndices.length ? valueIndices : aliasIndices;

    return indices.map((idx) => {
      if (idx === null || idx === undefined) return null;
      // Tableau uses negative indices for special/null/derived aliases.
      if (idx < 0 || idx >= dict.length) return null;
      return dict[idx];
    });
  }

  snapshot() {
    return Object.fromEntries(
      [...this.values.entries()].map(([k,v]) => [k, {count:v.length, sample:v.slice(0,8)}])
    );
  }
}

function getBootstrapSegments(chunks) {
  for (const chunk of chunks) {
    const segments =
      chunk?.secondaryInfo?.presModelMap?.dataDictionary?.presModelHolder
        ?.genDataDictionaryPresModel?.dataSegments;
    if (segments) return segments;
  }
  throw new Error("Could not locate Tableau bootstrap data dictionary.");
}

function getCommandApp(root) {
  return root?.vqlCmdResponse?.layoutStatus?.applicationPresModel || null;
}

function applyCommandDictionary(root, dictionary) {
  const app = getCommandApp(root);
  if (app?.dataDictionary?.dataSegments) {
    dictionary.appendSegments(app.dataDictionary.dataSegments);
  }
}

function extractEpiCurve(root, expectedYear, dictionary) {
  const app = getCommandApp(root);
  if (!app) throw new Error("Tableau response did not include applicationPresModel.");

  const zones = app?.workbookPresModel?.dashboardPresModel?.zones || {};
  const zone = Object.values(zones).find((z) => z?.worksheet === "HRI Epi Curve");
  if (!zone) throw new Error("Could not find HRI Epi Curve worksheet in Tableau response.");

  const paneData = zone?.presModelHolder?.visual?.vizData?.paneColumnsData;
  const metas = paneData?.vizDataColumns || [];
  const panes = paneData?.paneColumnsList || [];

  let paneIndex = panes.findIndex((p) =>
    (p?.paneDescriptor?.yFields || []).some((field) => String(field).includes("Cases HRI"))
  );
  if (paneIndex < 0) paneIndex = 0;

  const paneColumns = panes[paneIndex]?.vizPaneColumns || [];

  function columnForCaption(caption) {
    const meta = metas.find((m) => m?.fieldCaption === caption);
    if (!meta) throw new Error("Missing Tableau field: " + caption);
    const pos = (meta.paneIndices || []).indexOf(paneIndex);
    if (pos < 0) throw new Error("Field " + caption + " is not in HRI pane.");
    const column = paneColumns[meta.columnIndices[pos]];
    if (!column) throw new Error("Missing pane column for " + caption);
    return {meta, column};
  }

  const dateCol = columnForCaption("Date Axis");
  const casesCol = columnForCaption("SUM(Cases HRI)");
  const dates = dictionary.decode(dateCol.meta, dateCol.column);
  const cases = dictionary.decode(casesCol.meta, casesCol.column);

  if (!dates.length || dates.length !== cases.length) {
    throw new Error("HRI date/count lengths do not match: " + dates.length + " vs " + cases.length);
  }

  const rows = dates.map((d, i) => ({
    date: d ? String(d).slice(0,10) : "",
    ed_visits: cases[i] === null || cases[i] === undefined ? 0 : Number(cases[i])
  }))
    .filter((r) => r.date.startsWith(String(expectedYear)) && Number.isFinite(r.ed_visits))
    .sort((a,b) => a.date.localeCompare(b.date));

  if (rows.length < 100) {
    fs.mkdirSync("data", {recursive:true});
    fs.writeFileSync("data/ldh_debug.json", JSON.stringify({
      expectedYear,
      dictionary: dictionary.snapshot(),
      appliedSegments:[...dictionary.appliedSegments],
      dateSample:dates.slice(0,12),
      caseSample:cases.slice(0,12),
      metas:metas.map((m)=>({
        caption:m.fieldCaption,
        dataType:m.dataType,
        paneIndices:m.paneIndices,
        columnIndices:m.columnIndices
      }))
    }, null, 2));
    throw new Error("Only " + rows.length + " daily HRI rows decoded for " + expectedYear +
      "; date sample=" + JSON.stringify(dates.slice(0,5)) +
      ", case sample=" + JSON.stringify(cases.slice(0,5)));
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

async function processCommandResponse(response, dictionary) {
  const body = await response.text();
  const root = JSON.parse(body);
  applyCommandDictionary(root, dictionary);
  return root;
}

async function setSeason(page, year, dictionary) {
  const combo = page.getByRole("combobox");
  const current = (await combo.innerText()).trim();
  if (current === String(year)) return;

  await combo.click();
  const option = page.getByRole("option", {name:String(year), exact:true});
  const response = await waitForCommand(page, async () => {
    await option.click();
  });
  await processCommandResponse(response, dictionary);
  await page.waitForTimeout(1200);

  const after = (await combo.innerText()).trim();
  if (after !== String(year)) {
    throw new Error("Season selector expected " + year + " but shows " + after);
  }
}

async function selectRegionAndExtract(page, region, year, dictionary) {
  const regionButton = page.getByRole("button", {name:/^Region /});
  const currentLabel = await regionButton.getAttribute("aria-label");

  // If this region is already selected, force a different region first so Tableau
  // emits a fresh HRI Epi Curve response we can decode.
  if (String(currentLabel).includes(region.label)) {
    const fallback = region.id === "1" ? REGIONS[1] : REGIONS[0];
    await regionButton.click();
    const fallbackItem = page.getByRole("menuitem", {name:fallback.label, exact:true});
    const fallbackResponse = await waitForCommand(
      page,
      async () => { await fallbackItem.click(); },
      (resp) => resp.url().includes("set-parameter-value-from-index")
    );
    await processCommandResponse(fallbackResponse, dictionary);
    await page.waitForTimeout(700);
  }

  await regionButton.click();
  const item = page.getByRole("menuitem", {name:region.label, exact:true});
  const response = await waitForCommand(
    page,
    async () => { await item.click(); },
    (resp) => resp.url().includes("set-parameter-value-from-index")
  );

  const root = await processCommandResponse(response, dictionary);
  const rows = extractEpiCurve(root, year, dictionary);

  const after = await regionButton.getAttribute("aria-label");
  if (!String(after).includes(region.label)) {
    throw new Error("Region selector did not switch to " + region.label + "; got " + after);
  }

  return rows;
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1200}});
page.setDefaultTimeout(60000);

console.log("Opening LDH Tableau dashboard...");
const bootstrapPromise = page.waitForResponse(
  (resp) => resp.status() === 200 && resp.url().includes("/bootstrapSession/"),
  {timeout:120000}
);

await page.goto(DASHBOARD_URL, {waitUntil:"domcontentloaded", timeout:120000});
const bootstrapResponse = await bootstrapPromise;
const bootstrapBody = await bootstrapResponse.text();
const bootstrapChunks = parseLengthPrefixedJson(bootstrapBody);

const dictionary = new TableauDictionary();
dictionary.appendSegments(getBootstrapSegments(bootstrapChunks));
console.log("Seeded Tableau dictionary:", dictionary.snapshot());

await page.waitForFunction(
  () => document.body.innerText.includes("Emergency Department Visits for Heat-Related Illness"),
  null,
  {timeout:120000}
);
await page.waitForTimeout(5000);

const bodyText = await page.locator("body").innerText();
const updatedMatch = bodyText.match(/Last Updated:\s*([0-9/]+)/i);
const sourceUpdated = updatedMatch ? updatedMatch[1] : "";

const output = [];
const diagnostics = [];

for (const year of YEARS) {
  console.log("Selecting season", year);
  await setSeason(page, year, dictionary);

  for (const region of REGIONS) {
    console.log("Extracting", year, region.label);
    const rows = await selectRegionAndExtract(page, region, year, dictionary);

    diagnostics.push({
      year,
      region:region.id,
      region_name:region.name,
      row_count:rows.length,
      first_date:rows[0]?.date || "",
      last_date:rows.at(-1)?.date || "",
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

const expectedSlices = YEARS.length * REGIONS.length;
if (diagnostics.length !== expectedSlices) {
  throw new Error("Expected " + expectedSlices + " LDH slices but produced " + diagnostics.length);
}
for (const item of diagnostics) {
  if (item.row_count < 100) {
    throw new Error("Incomplete LDH slice: " + JSON.stringify(item));
  }
}

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
  years:YEARS.slice().sort(),
  regions:REGIONS,
  rows:output.length,
  dictionary_segments_applied:[...dictionary.appliedSegments],
  diagnostics
}, null, 2) + "\n");

console.log(JSON.stringify({
  sourceUpdated,
  rows:output.length,
  dictionary:dictionary.snapshot(),
  diagnostics
}, null, 2));

await browser.close();
