const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {weatherPairs,linearStats,shiftDate,finiteValue} = require('../weather-analysis.js');
assert.equal(finiteValue(''),null);
assert.equal(finiteValue('bad'),null);
assert.equal(finiteValue('0'),0);
assert.equal(shiftDate('2024-02-28',1),'2024-02-29');
assert.equal(shiftDate('2024-03-10',1),'2024-03-11');
assert.equal(linearStats([{x:1,y:6},{x:2,y:4},{x:3,y:2}],'x').r,-1);
assert.equal(linearStats([{x:1,y:0},{x:2,y:0},{x:3,y:0}],'x').r,null);
const geography = {regions:{'1':{weather_stations:['A','B']},'2':{weather_stations:['C']}}};
const analysis = [];
const weather = new Map();
for (let d=1; d<=4; d++) {
  const date = `2024-07-0${d}`;
  for (const id of ['1','2']) analysis.push({date,season:'2024',ldh_region:id,ed_visits:String(d-1)});
  for (const [s,t] of [['A',80],['B',100],['C',60]]) weather.set(date+'|'+s,
    {high_f:t,low_f:t-10,average_f:t-5,peak_heat_index_f:t+10,temperature_hours:18,heat_index_hours:18,expected_hours:24});
}
const opts = {analysis,weather,geography,regions:['1','2'],start:'2024-07-01',end:'2024-07-04',season:'all'};
let result = weatherPairs(opts);
assert.equal(result.pairs.length,4);
assert.equal(result.pairs[0].y,0); // Real zero ED day retained.
assert.equal(result.pairs[0].high_f,75); // Mean of region means, not three stations.
weather.get('2024-07-02|B').heat_index_hours = 17;
weather.get('2024-07-03|A').peak_heat_index_f = '';
assert.deepEqual(weatherPairs(opts).pairs.map(p=>p.date),['2024-07-01','2024-07-04']);
assert.equal(weatherPairs({...opts,coverage:0}).pairs.length,3);
assert.equal(weatherPairs({...opts,coverage:1}).pairs.length,0);
result = weatherPairs({...opts,lag:1});
assert.equal(result.pairs.length,1);
assert.equal(result.pairs[0].edDate,'2024-07-02');
assert.equal(result.pairs[0].y,2);
analysis.find(r=>r.date==='2024-07-02' && r.ldh_region==='1').ed_visits='';
assert.equal(weatherPairs({...opts,lag:1}).pairs.length,0);
assert.equal(weatherPairs({...opts,season:'2023'}).pairs.length,0);

// Exercise rendering with repository data and verify each plotted count and fit.
const elements = new Map();
const element = () => ({value:'',children:[],style:{},textContent:'',
  appendChild(x){this.children.push(x)},append(...x){this.children.push(...x)},
  replaceChildren(){this.children=[]},setAttribute(){},getContext(){return {}},
  classList:{toggle(){},remove(){}}});
const document = {getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
let created=0,destroyed=0;
const ctx = vm.createContext({document,console,Chart:class {constructor(_,config){this.config=config;created++}destroy(){destroyed++}}});
vm.runInContext(fs.readFileSync('weather-analysis.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('app.js','utf8').replace(/boot\(\);\s*$/,''),ctx);
ctx.geo=JSON.parse(fs.readFileSync('config/geography.json','utf8'));
ctx.edCSV=fs.readFileSync('data/analysis_region_daily.csv','utf8');
ctx.weatherCSV=fs.readFileSync('data/weather_daily.csv','utf8');
vm.runInContext(`state.geography=geo; state.analysis=parseCSV(edCSV); state.weatherStatus='loaded';
  for(const row of parseCSV(weatherCSV))state.weather.set(row.date+'|'+row.station,row);`,ctx);
for (const [id,value] of Object.entries({areaSelect:'all',seasonSelect:'all',startDate:'2023-04-01',endDate:'2026-09-05',weatherLag:'0',weatherCoverage:'0.75'}))document.getElementById(id).value=value;
vm.runInContext('renderWeatherCorrelations()',ctx);
assert.equal(created,20);
assert.equal(elements.get('weatherCorrelationTable').children.length,5);
assert.equal(elements.get('weatherScatterGroups').children.length,5);
console.log('Current archive, all seasons, same-day, >=75% hours:');
for(const row of elements.get('weatherCorrelationTable').children) console.log(row.children.map(c=>c.textContent).join(' | '));
document.getElementById('areaSelect').value='region:1';
vm.runInContext('renderWeatherCorrelations()',ctx);
assert.equal(destroyed,20);
assert.equal(created,24);
assert.equal(elements.get('weatherScatterGroups').children.length,1);
const configs = vm.runInContext('scatterCharts.map(c=>c.config)',ctx);
for(const config of configs){
  assert.equal(config.type,'scatter');
  assert.ok(config.data.datasets.some(d=>d.label==='Linear fit'));
  assert.ok(config.data.datasets[0].data[0].edDate);
}
console.log('Correlation tests passed: missing vs zero, coverage, matching, lag dates, regional weighting, constant data, chart groups and cleanup.');
