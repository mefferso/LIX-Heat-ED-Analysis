const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
  weatherPairs, linearStats, loessCurve, shiftDate, finiteValue,
  piecewiseBreakpoint, breakpointWithCI, binnedStats
} = require('../weather-analysis.js');

assert.equal(finiteValue(''),null);
assert.equal(finiteValue('bad'),null);
assert.equal(finiteValue('0'),0);
assert.equal(shiftDate('2024-02-28',1),'2024-02-29');
assert.equal(linearStats([{x:1,y:6},{x:2,y:4},{x:3,y:2}],'x').r,-1);

const piecewise = Array.from({length:120},(_,i)=>({
  x:80+i*.25,
  y:5 + .3*(80+i*.25) + 1.5*Math.max(0,(80+i*.25)-100)
}));
const bp = piecewiseBreakpoint(piecewise,'x');
assert.ok(bp);
assert.ok(Math.abs(bp.k-100)<1.5);
assert.ok(bp.slopeAfter>bp.slopeBefore);
const bpci = breakpointWithCI(piecewise,'x','y',20);
assert.ok(bpci.ciLow<=100 && bpci.ciHigh>=100);
const smooth = loessCurve(piecewise,'x');
assert.equal(smooth.length,64);
assert.ok(smooth.every(p=>p.low<=p.y && p.y<=p.high));
assert.ok(binnedStats(piecewise,'x','y',2).length>5);

const geography = {
  regions:{
    '1':{weather_stations:['A'],short_name:'One'},
    '2':{weather_stations:['B'],short_name:'Two'}
  },
  parishes:[
    {name:'P1',region:'1',population_2020:100},
    {name:'P2',region:'2',population_2020:300}
  ]
};
const analysis=[];
const regionWeather=new Map();
for(let d=1;d<=4;d++){
  const date=`2024-07-0${d}`;
  analysis.push({date,season:'2024',ldh_region:'1',ed_visits:String(d-1),health_population_2020:'100'});
  analysis.push({date,season:'2024',ldh_region:'2',ed_visits:String(d),health_population_2020:'300'});
  regionWeather.set(date+'|1',{high_f:80,regional_wbgt_max_f:80,population_2020:100,fallback_used:'0',weather_sources:'A'});
  regionWeather.set(date+'|2',{high_f:100,regional_wbgt_max_f:100,population_2020:300,fallback_used:'1',weather_sources:'B'});
}
const opts={analysis,regionWeather,geography,regions:['1','2'],start:'2024-07-01',end:'2024-07-04',season:'all',metricKeys:['high_f','regional_wbgt_max_f']};
let result=weatherPairs(opts);
assert.equal(result.pairs.length,4);
assert.equal(result.pairs[0].y,1);
assert.equal(result.pairs[0].high_f,95); // population-weighted 100/300, not equal region mean
assert.equal(result.pairs[0].yRate,250); // 1 / 400 * 100k
assert.equal(result.pairs[0].fallbackUsed,true);
regionWeather.get('2024-07-02|2').regional_wbgt_max_f='';
assert.deepEqual(weatherPairs(opts).pairs.map(p=>p.date),['2024-07-01','2024-07-03','2024-07-04']);
result=weatherPairs({...opts,lag:1});
assert.equal(result.pairs[0].edDate,'2024-07-02');

// Exercise the browser renderer with synthetic four-region data.
const elements=new Map();
const element=()=>({
  value:'',checked:false,children:[],style:{},textContent:'',innerHTML:'',
  appendChild(x){this.children.push(x)},append(...x){this.children.push(...x)},
  replaceChildren(){this.children=[]},setAttribute(){},getContext(){return {}},
  classList:{toggle(){},remove(){}}
});
const document={
  getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},
  createElement:element,
  createTextNode(text){return {textContent:text}}
};
let created=0,destroyed=0;
const Chart=class{
  constructor(_,config){this.config=config;created++}
  destroy(){destroyed++}
};
const ctx=vm.createContext({document,console,Chart});
vm.runInContext(fs.readFileSync('weather-analysis.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('app.js','utf8').replace(/boot\(\);\s*$/,''),ctx);

ctx.geo={
  regions:{
    '1':{short_name:'Southeast',weather_stations:['KMSY','KNEW']},
    '2':{short_name:'Capital',weather_stations:['KBTR']},
    '3':{short_name:'South Central',weather_stations:['KHUM'],health_population_extra_2020:50},
    '9':{short_name:'Northshore',weather_stations:['KASD']}
  },
  parishes:[
    {name:'a',region:'1',population_2020:1000},
    {name:'b',region:'2',population_2020:1200},
    {name:'c',region:'3',population_2020:900},
    {name:'d',region:'9',population_2020:1100}
  ]
};
ctx.analysis=[];
ctx.wx=[];
for(let i=0;i<120;i++){
  const dt=new Date(Date.UTC(2024,4,1+i));
  const date=dt.toISOString().slice(0,10);
  for(const [j,rid] of ['1','2','3','9'].entries()){
    const hi=94+i*.18+j*.5;
    const pop=ctx.geo.parishes.find(p=>p.region===rid).population_2020 + (rid==='3'?50:0);
    const visits=Math.max(0,Math.round(2+.05*i + .55*Math.max(0,hi-108)+j));
    ctx.analysis.push({date,season:'2024',ldh_region:rid,ed_visits:String(visits),health_population_2020:String(pop)});
    ctx.wx.push({date,ldh_region:rid,high_f:hi-8,low_f:hi-25,average_f:hi-15,
      peak_heat_index_f:hi,regional_wbgt_max_f:hi-20,morning_low_f:hi-26,
      hi_hours_105:Math.max(0,(hi-104)/2),hi_hours_108:Math.max(0,(hi-107)/2),
      hi_2day_mean_f:hi-.2,hi_3day_mean_f:hi-.4,consecutive_hi108_days:hi>=108?Math.min(6,1+Math.floor((hi-108)/2)):0,
      population_2020:ctx.geo.parishes.find(p=>p.region===rid).population_2020,
      fallback_used:(i%37===0&&rid==='3')?'1':'0',weather_sources:rid==='3'?'KGAO':'PRIMARY'});
  }
}
vm.runInContext(`state.geography=geo; state.analysis=analysis; state.weatherStatus='loaded'; state.advanced=null;
  for(const row of wx) state.weatherRegion.set(row.date+'|'+row.ldh_region,row);`,ctx);
for(const [id,value] of Object.entries({
  areaSelect:'all',seasonSelect:'all',startDate:'2024-05-01',endDate:'2024-08-28',
  weatherLag:'0',weatherResponseScale:'rate',adjustedPeriod:'all_months'
})) document.getElementById(id).value=value;

vm.runInContext('renderWeatherCorrelations()',ctx);
assert.equal(created,25);
assert.equal(elements.get('weatherCorrelationTable').children.length,5);
assert.equal(elements.get('weatherScatterGroups').children.length,5);
assert.equal(elements.get('thresholdCards').children.length,2);
assert.equal(elements.get('extendedCorrelationTable').children.length,6);

const configs=vm.runInContext('scatterCharts.map(c=>c.config)',ctx);
const hiConfig=configs.find(c=>c.data.datasets.some(d=>d.label==='108°F advisory criterion'));
assert.ok(hiConfig);
assert.ok(hiConfig.data.datasets.some(d=>d.label==='113°F warning criterion'));
assert.ok(hiConfig.data.datasets.some(d=>d.label==='Approx. 95% local band'));
assert.ok(configs.some(c=>c.options.scales.x.title.text.includes('Outdoor WBGT')));

document.getElementById('areaSelect').value='region:1';
vm.runInContext('renderWeatherCorrelations()',ctx);
assert.equal(destroyed,25);
assert.equal(created,30);
assert.equal(elements.get('weatherScatterGroups').children.length,1);
console.log('Correlation tests passed: population weighting, rates, WBGT, breakpoint, confidence band, bins, and chart lifecycle.');
