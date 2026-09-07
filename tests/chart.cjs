const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const elements = new Map();
const element = () => ({value:'', checked:false, textContent:'', style:{}, children:[],
  appendChild(x){this.children.push(x)}, append(...x){this.children.push(...x)},
  replaceChildren(){this.children=[]},getContext(){return {}},classList:{toggle(){},remove(){}}});
const document = {getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},
  createElement:element, createTextNode(text){return {textContent:text}}};
const ctx = vm.createContext({document, console, Chart:class {constructor(_,config){this.config=config}destroy(){}}});
vm.runInContext(fs.readFileSync('app.js','utf8').replace(/boot\(\);\s*$/, ''),ctx);
ctx.geo = JSON.parse(fs.readFileSync('config/geography.json','utf8'));
vm.runInContext('state.geography=geo; state.weatherStatus="loaded"; buildAreaOptions()',ctx);
assert.equal(elements.get('areaSelect').children.length,2); // CWA + regions only
const selected = document.getElementById('areaSelect');
const rows = [{date:'2023-08-01',edKnown:true,edVisits:4,advisoryPct:50,warningPct:0,severity:.5,meanHazardHours:4},
  {date:'2023-08-02',edKnown:true,edVisits:5,advisoryPct:0,warningPct:0,severity:0,meanHazardHours:0}];
ctx.rows=rows;
vm.runInContext(`for(const s of ['KBTR','KASD','KMSY','KNEW','KHUM'])state.weather.set('2023-08-01|'+s,
 {high_f:95,low_f:75,average_f:85,peak_heat_index_f:106,temperature_hours:24,heat_index_hours:23,expected_hours:24})`,ctx);
const expected = {'region:1':['KMSY','KNEW'],'region:2':['KBTR'],'region:3':['KHUM'],'region:9':['KASD'],'all':['KMSY','KNEW','KBTR','KHUM','KASD']};
for (const [area,stations] of Object.entries(expected)) {
  selected.value=area;
  for(const id of ['weatherHigh','weatherLow','weatherAverage','weatherHeatIndex'])document.getElementById(id).checked=true;
  vm.runInContext('renderChart(rows)',ctx);
  const config=vm.runInContext('state.chart.config',ctx);
  const weather=config.data.datasets.filter(d=>d.yAxisID==='yWeather');
  assert.equal(weather.length,stations.length*4);
  assert.deepEqual([...new Set(weather.map(d=>d.station))].sort(),stations.sort());
  assert.ok(weather.every(d=>d.data[1]===null && d.spanGaps===false));
  assert.equal(config.options.scales.x.ticks.callback.call({getLabelForValue:()=> '2023-08-01'},0),'08-01');
  assert.equal(config.options.scales.yWeather.display,true);
}
for(const id of ['weatherHigh','weatherLow','weatherAverage','weatherHeatIndex'])document.getElementById(id).checked=false;
vm.runInContext('renderChart(rows)',ctx);
assert.equal(vm.runInContext('state.chart.config.data.datasets.length',ctx),3);
assert.equal(vm.runInContext('state.chart.config.options.scales.yWeather.display',ctx),false);
const html=fs.readFileSync('index.html','utf8');
assert.ok(!html.includes('WHAT THE NUMBERS MEAN'));
console.log('Chart integration passed: region mapping, all four toggles, gaps, date labels, and independent °F axis.');
