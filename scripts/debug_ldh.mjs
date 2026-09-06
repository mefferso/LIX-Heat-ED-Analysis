import { chromium } from "playwright";
import fs from "fs";

const VIEW="https://analytics.la.gov/t/LDH/views/HeatRelatedIllnessDashboardLive_17568488201530/HeatRelatedIllnessesDashboard";
const API="https://analytics.la.gov/javascripts/api/tableau.embedding.3.latest.min.js";

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1200}});
page.setDefaultTimeout(120000);

await page.goto("about:blank");

const result=await page.evaluate(async ({VIEW,API})=>{
  const mod=await import(API);
  const viz=new mod.TableauViz();
  viz.src=VIEW;
  viz.hideTabs=true;
  viz.hideToolbar=true;
  viz.width="1400px";
  viz.height="1000px";

  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("FirstInteractive timeout")),90000);
    viz.addEventListener(mod.TableauEventType.FirstInteractive,()=>{
      clearTimeout(timer);
      resolve();
    },{once:true});
  });

  document.body.appendChild(viz);
  await ready;

  const workbook=viz.workbook;
  const active=workbook.activeSheet;
  const params=await workbook.getParametersAsync();
  const dashboardFilters=await active.getFiltersAsync();
  const worksheets=active.worksheets || [];
  const hri=worksheets.find(w=>w.name==="HRI Epi Curve");
  if (!hri) throw new Error("HRI Epi Curve worksheet not found via Embedding API");
  const hriFilters=await hri.getFiltersAsync();
  const table=await hri.getSummaryDataAsync({maxRows:1000});

  function cleanValue(v) {
    if (v===null || v===undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v==="object") {
      try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
    }
    return v;
  }

  return {
    activeSheet:{name:active.name,sheetType:active.sheetType},
    worksheets:worksheets.map(w=>({name:w.name,sheetType:w.sheetType})),
    parameters:params.map(p=>({
      name:p.name,
      currentValue:cleanValue(p.currentValue),
      allowableValuesType:p.allowableValuesType,
      allowableValues:(p.allowableValues||[]).map(cleanValue),
      dataType:p.dataType
    })),
    dashboardFilters:dashboardFilters.map(f=>({
      fieldName:f.fieldName,
      filterType:f.filterType,
      className:f.constructor?.name || null
    })),
    hriFilters:hriFilters.map(f=>({
      fieldName:f.fieldName,
      filterType:f.filterType,
      className:f.constructor?.name || null
    })),
    summary:{
      columns:table.columns.map(c=>({
        fieldName:c.fieldName,
        index:c.index,
        dataType:c.dataType
      })),
      totalRowCount:table.totalRowCount,
      data:table.data.slice(0,12).map(row=>row.map(cell=>({
        value:cleanValue(cell.value),
        formattedValue:cell.formattedValue
      })))
    }
  };
},{VIEW,API});

fs.writeFileSync("data/ldh_api_probe.json",JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
await browser.close();
