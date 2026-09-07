// Exercise the production CSV loader and pairing with the published archive.
// Synthetic calculation tests alone missed the 2026 schema migration regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const element = () => ({value:'', checked:false, textContent:'', children:[], style:{},
  appendChild(x){this.children.push(x)}, append(...x){this.children.push(...x)},
  replaceChildren(){this.children=[]}, setAttribute(){}, getContext(){return {}}, classList:{toggle(){},remove(){}}});
const document = {
  getElementById(id){if(!elements.has(id)) elements.set(id,element()); return elements.get(id)},
  createElement:element, createTextNode(text){return {textContent:text}}
};
const ctx = vm.createContext({document,console,
  Chart:class {constructor(_,config){this.config=config} destroy(){}},
  fetch:async url => {
    const text = fs.readFileSync(String(url).split('?')[0], 'utf8');
    return {ok:true,text:async()=>text,json:async()=>JSON.parse(text)};
  }
});
vm.runInContext(fs.readFileSync('weather-analysis.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('app.js','utf8').replace(/boot\(\);\s*$/,''),ctx);
ctx.geo = JSON.parse(fs.readFileSync('config/geography.json','utf8'));
ctx.analysisText = fs.readFileSync('data/analysis_region_daily.csv','utf8');
vm.runInContext(`state.geography=geo; state.analysis=parseCSV(analysisText);
  renderAll=()=>{};`,ctx);

(async()=>{
  await vm.runInContext('loadWeather()',ctx);
  assert.equal(vm.runInContext('state.weatherStatus',ctx),'loaded');
  const years = vm.runInContext('[...new Set(state.analysis.map(r=>String(r.season)))].sort()',ctx);
  const report=[];
  for(const year of years){
    for(const area of ['all',...Object.keys(ctx.geo.regions)]){
      ctx.year=year; ctx.area=area;
      const {pairs,eligible}=vm.runInContext(`weatherPairs({analysis:state.analysis,
        regionWeather:state.weatherRegion,geography:state.geography,
        regions:area==='all'?Object.keys(geo.regions):[area],
        start:year+'-04-01',end:year+'-10-31',season:year})`,ctx);
      if(eligible<30) continue; // A newly started season can be shorter than the archive lag.
      assert.ok(pairs.length>=eligible*.9,
        year+' '+area+': only '+pairs.length+'/'+eligible+' complete core weather/WBGT days');
      report.push({year,area,paired:pairs.length,eligible});
    }
  }
  for(const [id,value] of Object.entries({areaSelect:'all',seasonSelect:'2025',
    startDate:'2025-04-01',endDate:'2025-10-31',weatherLag:'0',
    weatherResponseScale:'count',adjustedPeriod:'all_months'})) document.getElementById(id).value=value;
  vm.runInContext('renderWeatherCorrelations()',ctx);
  assert.equal(vm.runInContext('scatterCharts.length',ctx),25);
  assert.equal(elements.get('weatherCorrelationTable').children.length,5);
  assert.ok(vm.runInContext('scatterCharts.every(c=>c.config.data.datasets.some(d=>d.data.length>100))',ctx));
  for(const area of ['all',...Object.keys(ctx.geo.regions)]){
    for(const period of ['all_months','jja']){
      ctx.area=area; ctx.period=period;
      const models=vm.runInContext('state.advanced.groups[area][period]',ctx);
      for(const metric of ['high_f','low_f','average_f','peak_heat_index_f','regional_wbgt_max_f']){
        assert.equal(models[metric].status,'ok',area+' '+period+' '+metric);
        assert.ok(models[metric].n>80 && Number.isFinite(models[metric].aic));
      }
    }
  }
  console.table(report);
  console.log('Published archive passed: all seasons/areas paired, 25 scatter plots populated, five core adjusted models available.');
})().catch(error=>{console.error(error);process.exitCode=1});
