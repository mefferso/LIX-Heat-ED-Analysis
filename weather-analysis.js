/* Regional weather / ED comparisons, nonlinear threshold diagnostics, and model summaries. */
const CORE_CORRELATION_METRICS = [
  {key:"high_f", label:"High temperature", unit:"°F", binWidth:2},
  {key:"low_f", label:"Low temperature", unit:"°F", binWidth:2},
  {key:"average_f", label:"Average temperature", unit:"°F", binWidth:2},
  {key:"peak_heat_index_f", label:"Peak heat index", unit:"°F", binWidth:2, threshold:true},
  {key:"regional_wbgt_max_f", label:"Outdoor WBGT", unit:"°F", binWidth:2, threshold:true}
];
const EXTENDED_CORRELATION_METRICS = [
  {key:"morning_low_f", label:"Overnight / morning low", unit:"°F"},
  {key:"hi_hours_105", label:"Hours with HI ≥105°F", unit:"hours"},
  {key:"hi_hours_108", label:"Hours with HI ≥108°F", unit:"hours"},
  {key:"hi_2day_mean_f", label:"2-day mean peak HI", unit:"°F"},
  {key:"hi_3day_mean_f", label:"3-day mean peak HI", unit:"°F"},
  {key:"consecutive_hi108_days", label:"Consecutive HI ≥108°F days", unit:"days"}
];
const CORRELATION_METRICS = [...CORE_CORRELATION_METRICS, ...EXTENDED_CORRELATION_METRICS];
const SCATTER_YEAR_COLORS = ["#236fa1", "#ae5215", "#754ca3", "#168175"];

function finiteValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shiftDate(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

function configuredPopulation(geography, region) {
  return geography.parishes
    .filter(p=>p.region===region)
    .reduce((sum,p)=>sum+(finiteValue(p.population_2020)||0),0);
}

function weatherPairs({analysis, regionWeather, regions, geography, start, end, season,
                       lag=0, metricKeys=CORE_CORRELATION_METRICS.map(m=>m.key)}) {
  const ed = new Map();
  for (const row of analysis) {
    const visits = finiteValue(row.ed_visits);
    const pop = finiteValue(row.health_population_2020);
    if (visits !== null && visits >= 0 && pop !== null && pop > 0 &&
        regions.includes(row.ldh_region) && (season === "all" || String(row.season) === season)) {
      ed.set(row.date + "|" + row.ldh_region, {visits,pop});
    }
  }
  const dates = [...new Set(analysis.map(row=>row.date))].sort();
  const pairs = [];
  let eligible = 0;
  for (const date of dates) {
    const target = shiftDate(date, lag);
    if (date < start || target > end || date.slice(0,4) !== target.slice(0,4) ||
        (season !== "all" && date.slice(0,4) !== season)) continue;
    const edRows = regions.map(id=>ed.get(target+"|"+id));
    if (!edRows.every(Boolean)) continue;
    eligible++;
    const wxRows = regions.map(id=>regionWeather.get(date+"|"+id));
    if (!wxRows.every(Boolean)) continue;
    if (!wxRows.every(row=>metricKeys.every(key=>finiteValue(row[key]) !== null))) continue;

    const weights = regions.map((id,i)=>
      finiteValue(wxRows[i].population_2020) || configuredPopulation(geography,id) || 1);
    const weightSum = weights.reduce((a,b)=>a+b,0);
    const aggregate = {};
    for (const key of metricKeys) {
      aggregate[key] = wxRows.reduce((sum,row,i)=>sum + Number(row[key])*weights[i],0)/weightSum;
    }
    const visits = edRows.reduce((sum,row)=>sum+row.visits,0);
    const healthPop = edRows.reduce((sum,row)=>sum+row.pop,0);
    pairs.push({
      date, edDate:target, y:visits, yRate:visits/healthPop*100000,
      healthPopulation:healthPop,
      fallbackUsed:wxRows.some(row=>String(row.fallback_used)==="1"),
      weatherSources:wxRows.map((row,i)=>regions[i]+":"+(row.weather_sources||"")).join(" · "),
      ...aggregate
    });
  }
  return {pairs, eligible};
}

function linearStats(pairs, key, responseKey="y") {
  const source = pairs.filter(p=>Number.isFinite(p[key]) && Number.isFinite(p[responseKey]));
  const n = source.length;
  if (n < 3) return {n, r:null, r2:null, slope:null, intercept:null};
  const mx = source.reduce((sum,p)=>sum+p[key],0)/n;
  const my = source.reduce((sum,p)=>sum+p[responseKey],0)/n;
  let xx=0, yy=0, xy=0;
  for (const p of source) {
    xx += (p[key]-mx)**2;
    yy += (p[responseKey]-my)**2;
    xy += (p[key]-mx)*(p[responseKey]-my);
  }
  if (!xx || !yy) return {n, r:null, r2:null, slope:null, intercept:null};
  const r = Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy)));
  return {n, r, r2:r*r, slope:xy/xx, intercept:my-xy/xx*mx};
}

function loessCurve(pairs, key, responseKey="y", span=0.22, pointCount=64) {
  const source = pairs.map(p=>({x:p[key],y:p[responseKey]}))
    .filter(p=>Number.isFinite(p.x) && Number.isFinite(p.y));
  if (source.length < 8) return [];
  const minX = Math.min(...source.map(p=>p.x));
  const maxX = Math.max(...source.map(p=>p.x));
  if (minX === maxX) return [];
  const neighbors = Math.min(source.length,Math.max(20,Math.ceil(source.length*span)));
  const curve = [];
  for (let i=0; i<pointCount; i++) {
    const x = minX + (maxX-minX)*i/(pointCount-1);
    const distances = source.map(p=>Math.abs(p.x-x)).sort((a,b)=>a-b);
    let bandwidth = distances[neighbors-1] || distances.find(d=>d>0) || 1;
    let sw=0, sw2=0, sx=0, sy=0, sxx=0, sxy=0;
    const weighted=[];
    for (const p of source) {
      const ratio = Math.abs(p.x-x)/bandwidth;
      if (ratio > 1) continue;
      const w = (1-ratio**3)**3;
      if (w <= 0) continue;
      weighted.push([p,w]);
      sw += w; sw2 += w*w; sx += w*p.x; sy += w*p.y;
      sxx += w*p.x*p.x; sxy += w*p.x*p.y;
    }
    if (sw <= 0 || weighted.length < 4) continue;
    const denominator = sw*sxx-sx*sx;
    const intercept = Math.abs(denominator)<1e-9 ? sy/sw : (sy*sxx-sx*sxy)/denominator;
    const slope = Math.abs(denominator)<1e-9 ? 0 : (sw*sxy-sx*sy)/denominator;
    const y = intercept+slope*x;
    let wrss=0;
    for (const [p,w] of weighted) wrss += w*(p.y-(intercept+slope*p.x))**2;
    const neff = sw2 ? sw*sw/sw2 : weighted.length;
    const sigma2 = wrss/Math.max(sw-2,1);
    const se = Math.sqrt(Math.max(0,sigma2)/Math.max(neff,1));
    const margin = 1.96*se;
    if (Number.isFinite(y)) curve.push({x,y:Math.max(0,y),low:Math.max(0,y-margin),high:Math.max(0,y+margin)});
  }
  return curve;
}

function solve3(matrix, vector) {
  const M=matrix.map((r,i)=>[...r,vector[i]]);
  for(let i=0;i<3;i++){
    let pivot=i;
    for(let r=i+1;r<3;r++) if(Math.abs(M[r][i])>Math.abs(M[pivot][i])) pivot=r;
    [M[i],M[pivot]]=[M[pivot],M[i]];
    if(Math.abs(M[i][i])<1e-10) return null;
    const d=M[i][i];
    for(let j=i;j<4;j++) M[i][j]/=d;
    for(let r=0;r<3;r++) if(r!==i){
      const f=M[r][i];
      for(let j=i;j<4;j++) M[r][j]-=f*M[i][j];
    }
  }
  return M.map(r=>r[3]);
}

function quantile(values,q) {
  if (!values.length) return null;
  const a=[...values].sort((x,y)=>x-y);
  const pos=(a.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos);
  return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo);
}

function piecewiseBreakpoint(pairs,key,responseKey="y") {
  const source=pairs.filter(p=>Number.isFinite(p[key])&&Number.isFinite(p[responseKey]));
  if(source.length<30) return null;
  const xs=source.map(p=>p[key]), lo=quantile(xs,.2), hi=quantile(xs,.8);
  if(lo===null||hi===null||hi<=lo) return null;
  const range=hi-lo;
  const step=Math.max(range/36, key.includes("_f")||key.includes("wbgt") ? .25 : .1);
  let best=null;
  for(let k=lo;k<=hi+1e-9;k+=step){
    const xtx=[[0,0,0],[0,0,0],[0,0,0]], xty=[0,0,0];
    for(const p of source){
      const v=[1,p[key],Math.max(0,p[key]-k)], y=p[responseKey];
      for(let i=0;i<3;i++){xty[i]+=v[i]*y;for(let j=0;j<3;j++)xtx[i][j]+=v[i]*v[j];}
    }
    const b=solve3(xtx,xty);
    if(!b) continue;
    let sse=0;
    for(const p of source){
      const pred=b[0]+b[1]*p[key]+b[2]*Math.max(0,p[key]-k);
      sse+=(p[responseKey]-pred)**2;
    }
    if(!best||sse<best.sse) best={k,sse,slopeBefore:b[1],slopeAfter:b[1]+b[2],n:source.length};
  }
  return best;
}

function seededRandom(seed) {
  let x=(seed||1)>>>0;
  return ()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296;};
}

function breakpointWithCI(pairs,key,responseKey="y",replicates=60) {
  const estimate=piecewiseBreakpoint(pairs,key,responseKey);
  if(!estimate) return null;
  const source=pairs.filter(p=>Number.isFinite(p[key])&&Number.isFinite(p[responseKey]));
  const rnd=seededRandom(source.length*997 + key.length*7919);
  const boots=[];
  for(let b=0;b<replicates;b++){
    const sample=Array.from({length:source.length},()=>source[Math.floor(rnd()*source.length)]);
    const fit=piecewiseBreakpoint(sample,key,responseKey);
    if(fit&&Number.isFinite(fit.k)) boots.push(fit.k);
  }
  return {
    ...estimate,
    ciLow:quantile(boots,.025),
    ciHigh:quantile(boots,.975),
    bootstrapN:boots.length
  };
}

function binnedStats(pairs,key,responseKey="y",width=2,minCount=5) {
  const source=pairs.filter(p=>Number.isFinite(p[key])&&Number.isFinite(p[responseKey]));
  if(!source.length) return [];
  const min=Math.floor(Math.min(...source.map(p=>p[key]))/width)*width;
  const max=Math.ceil(Math.max(...source.map(p=>p[key]))/width)*width;
  const out=[];
  for(let lo=min;lo<max;lo+=width){
    const vals=source.filter(p=>p[key]>=lo&&p[key]<lo+width).map(p=>p[responseKey]);
    if(vals.length<minCount) continue;
    out.push({lo,hi:lo+width,n:vals.length,mean:vals.reduce((a,b)=>a+b,0)/vals.length});
  }
  return out;
}

function addBinTable(card,pairs,metric,responseKey,responseLabel) {
  if(!metric.binWidth || !["peak_heat_index_f","regional_wbgt_max_f"].includes(metric.key)) return;
  const bins=binnedStats(pairs,metric.key,responseKey,metric.binWidth);
  if(!bins.length) return;
  const wrap=document.createElement("div");
  wrap.className="bin-table-wrap";
  const title=document.createElement("p");
  title.className="bin-title";
  title.textContent=`2°F bins · mean ${responseLabel}`;
  const table=document.createElement("table");
  table.className="bin-table";
  const head=document.createElement("thead");
  const hr=document.createElement("tr");
  ["Bin","n","Mean"].forEach(x=>{const th=document.createElement("th");th.textContent=x;hr.appendChild(th);});
  head.appendChild(hr);
  const body=document.createElement("tbody");
  for(const b of bins){
    const tr=document.createElement("tr");
    [`${b.lo.toFixed(0)}–<${b.hi.toFixed(0)}`,String(b.n),b.mean.toFixed(responseKey==="yRate"?2:1)]
      .forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});
    body.appendChild(tr);
  }
  table.append(head,body); wrap.append(title,table); card.appendChild(wrap);
}

function renderThresholdCards(pairs,responseKey,responseLabel) {
  const root=$("thresholdCards");
  if(!root) return;
  root.replaceChildren();
  for(const metric of CORE_CORRELATION_METRICS.filter(m=>m.threshold)){
    const metricPairs=pairs.filter(p=>Number.isFinite(p[metric.key]));
    const fit=breakpointWithCI(metricPairs,metric.key,responseKey);
    const card=document.createElement("article");
    card.className="threshold-card";
    const h=document.createElement("h3");h.textContent=metric.label;
    const strong=document.createElement("strong");
    const p=document.createElement("p");
    if(!fit){
      strong.textContent="—";
      p.textContent="Not enough complete paired days for a stable breakpoint estimate.";
    }else{
      strong.textContent=fit.k.toFixed(1)+metric.unit;
      const ci=(fit.ciLow!==null&&fit.ciHigh!==null)?` (95% bootstrap ${fit.ciLow.toFixed(1)}–${fit.ciHigh.toFixed(1)})`:"";
      const ratio=Math.abs(fit.slopeBefore)>1e-9?fit.slopeAfter/fit.slopeBefore:null;
      p.textContent=`Estimated acceleration point${ci}. Slope changes from ${fit.slopeBefore.toFixed(2)} to ${fit.slopeAfter.toFixed(2)} ${responseLabel} per ${metric.unit}${ratio&&Number.isFinite(ratio)?` (~${ratio.toFixed(1)}×)`:""}.`;
    }
    card.append(h,strong,p);
    if(metric.key==="peak_heat_index_f"){
      const note=document.createElement("p"); note.className="threshold-note";
      note.textContent="Operational references: 108°F Heat Advisory · 113°F Excessive/Extreme Heat Warning.";
      card.appendChild(note);
    }
    root.appendChild(card);
  }
}

function renderExtendedMetrics(group, opts, responseKey) {
  const body=$("extendedCorrelationTable");
  if(!body) return;
  body.replaceChildren();
  const rows=[];
  for(const metric of EXTENDED_CORRELATION_METRICS){
    const {pairs}=weatherPairs({...opts,regions:group.regions,metricKeys:[metric.key]});
    const s=linearStats(pairs,metric.key,responseKey);
    rows.push({metric,s});
  }
  rows.sort((a,b)=>(Math.abs(b.s.r??-Infinity)-Math.abs(a.s.r??-Infinity)));
  for(const {metric,s} of rows){
    const tr=document.createElement("tr");
    [metric.label,s.r===null?"—":s.r.toFixed(3),String(s.n),metric.unit].forEach((v,i)=>{
      const td=document.createElement("td");td.textContent=v;if(i===1&&rows[0].s.r!==null&&s===rows[0].s)td.className="best-correlation";tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function renderAdjustedModels() {
  const body=$("adjustedModelTable");
  if(!body) return;
  body.replaceChildren();
  const selected=selectedArea();
  const groupKey=selected.type==="all"?"all":selected.regions[0];
  const period=$("adjustedPeriod")?.value||"all_months";
  const group=state.advanced?.groups?.[groupKey]?.[period];
  if(!group){
    const tr=document.createElement("tr"), td=document.createElement("td");
    td.colSpan=6;td.textContent="Adjusted model output is waiting for the next automated data build.";tr.appendChild(td);body.appendChild(tr);return;
  }
  const rows=Object.entries(group).filter(([,v])=>v.status==="ok")
    .sort((a,b)=>(a[1].delta_aic??Infinity)-(b[1].delta_aic??Infinity));
  for(const [key,v] of rows){
    const tr=document.createElement("tr");
    const range=`${v.p50?.toFixed(1)??"—"} → ${v.p90?.toFixed(1)??"—"} ${v.unit||""}`;
    const rr=v.rate_ratio_p90_vs_p50==null?"—":v.rate_ratio_p90_vs_p50.toFixed(2)+"×";
    [v.label||key,v.model==="negative_binomial"?"NegBin":"Poisson",String(v.n),
      v.delta_aic==null?"—":v.delta_aic.toFixed(1),range,rr].forEach((x,i)=>{
        const td=document.createElement("td");td.textContent=x;if(i===3&&v.delta_aic===0)td.className="best-correlation";tr.appendChild(td);
      });
    body.appendChild(tr);
  }
}

function renderWeatherCorrelations() {
  scatterCharts.forEach(chart=>chart.destroy());
  scatterCharts = [];
  const container = $("weatherScatterGroups");
  container.replaceChildren();
  $("weatherCorrelationTable").replaceChildren();
  if (state.weatherStatus !== "loaded") {
    $("correlationScope").textContent = state.weatherStatus === "loading" ?
      "Loading regional weather for the comparisons…" : "Regional weather data unavailable; correlations cannot be calculated.";
    return;
  }
  const start=$("startDate").value, end=$("endDate").value;
  if(!start||!end||start>end){$("correlationScope").textContent="Choose a valid start and end date.";return;}
  const selected=selectedArea();
  const regionIds=Object.keys(state.geography.regions);
  const groups=selected.type==="all"?[
    {name:"Combined LDH regions",regions:regionIds},
    ...regionIds.map(id=>({name:state.geography.regions[id].short_name,regions:[id]}))
  ]:[{name:state.geography.regions[selected.regions[0]].short_name,regions:selected.regions}];
  const lag=Number($("weatherLag").value);
  const responseKey=$("weatherResponseScale")?.value==="rate"?"yRate":"y";
  const responseLabel=responseKey==="yRate"?"ED visits / 100k":"ED visits";
  const response=lag?`${responseLabel} ${lag} day${lag===1?"":"s"} later`:`Same-day ${responseLabel}`;
  const opts={analysis:state.analysis,regionWeather:state.weatherRegion,geography:state.geography,
    start,end,season:$("seasonSelect").value,lag};

  $("correlationScope").textContent=`${start} through ${end} · ${response}. Regional weather uses QC'd primary airport observations with explicit fallbacks; combined exposure is population-weighted. WBGT is Liljegren outdoor WBGT from reanalysis radiation/wind inputs. Each core-variable ranking uses the same complete paired dates. Zero-visit days are retained.`;

  let firstPairs=null;
  for(const [groupIndex,group] of groups.entries()){
    const {pairs,eligible}=weatherPairs({...opts,regions:group.regions,
      metricKeys:CORE_CORRELATION_METRICS.map(m=>m.key)});
    if(groupIndex===0) firstPairs=pairs;
    const stats=CORE_CORRELATION_METRICS.map(metric=>linearStats(pairs,metric.key,responseKey));
    const valid=stats.filter(s=>s.r!==null);
    const bestAbs=valid.length?Math.max(...valid.map(s=>Math.abs(s.r))):null;
    const best=stats.map(s=>s.r!==null&&Math.abs(s.r).toFixed(3)===bestAbs?.toFixed(3));
    const tr=document.createElement("tr");
    const values=[group.name,best.some(Boolean)?CORE_CORRELATION_METRICS.filter((_,i)=>best[i]).map(m=>m.label).join(" / "):"Insufficient data",
      ...stats.map(s=>s.r===null?"—":s.r.toFixed(3)),String(pairs.length)];
    values.forEach((value,i)=>{const td=document.createElement("td");td.textContent=value;if(i>=2&&i<2+stats.length&&best[i-2])td.className="best-correlation";tr.appendChild(td);});
    $("weatherCorrelationTable").appendChild(tr);

    const section=document.createElement("section");section.className="scatter-group";
    const heading=document.createElement("h3");heading.textContent=group.name;
    const note=document.createElement("p");note.className="correlation-note";
    const fallbackN=pairs.filter(p=>p.fallbackUsed).length;
    note.textContent=`${pairs.length} common paired days; ${Math.max(0,eligible-pairs.length)} excluded for incomplete core weather/WBGT. ${fallbackN} paired day${fallbackN===1?"":"s"} used at least one configured airport fallback.`;
    const grid=document.createElement("div");grid.className="scatter-grid";
    section.append(heading,note,grid);container.appendChild(section);

    CORE_CORRELATION_METRICS.forEach((metric,i)=>{
      const card=document.createElement("article");card.className="scatter-card";
      const title=document.createElement("h4");title.textContent=metric.label;
      const stat=stats[i], detail=document.createElement("p");detail.className="scatter-stats";
      detail.textContent=stat.r===null?`n = ${stat.n} · correlation unavailable`:
        `Pearson r = ${stat.r.toFixed(3)} · r² = ${stat.r2.toFixed(3)} · n = ${stat.n}`;
      card.append(title,detail);grid.appendChild(card);
      if(!pairs.length){const empty=document.createElement("p");empty.className="scatter-empty";empty.textContent="No common matched days for all five core metrics.";card.appendChild(empty);return;}
      const wrap=document.createElement("div");wrap.className="scatter-wrap";
      const canvas=document.createElement("canvas");canvas.setAttribute("role","img");canvas.setAttribute("aria-label",`${group.name}: ${metric.label} versus ${response}. ${detail.textContent}`);
      wrap.appendChild(canvas);card.appendChild(wrap);
      const years=[...new Set(pairs.map(p=>p.date.slice(0,4)))].sort();
      const datasets=years.map(year=>({label:year,
        data:pairs.filter(p=>p.date.startsWith(year)).map(p=>({x:p[metric.key],y:p[responseKey],date:p.date,edDate:p.edDate,sources:p.weatherSources})),
        backgroundColor:SCATTER_YEAR_COLORS[(Number(year)-2023)%SCATTER_YEAR_COLORS.length]+"88",
        pointRadius:3,pointHoverRadius:5,order:2}));
      const curve=loessCurve(pairs,metric.key,responseKey);
      if(curve.length){
        datasets.push({type:"line",label:"95% local band lower",data:curve.map(p=>({x:p.x,y:p.low})),
          borderWidth:0,pointRadius:0,pointHitRadius:0,order:1});
        datasets.push({type:"line",label:"Approx. 95% local band",data:curve.map(p=>({x:p.x,y:p.high})),
          borderWidth:0,pointRadius:0,pointHitRadius:0,backgroundColor:"rgba(23,33,43,.10)",fill:"-1",order:1});
        datasets.push({type:"line",label:"Smoothed average",data:curve.map(p=>({x:p.x,y:p.y})),
          borderColor:"#17212b",borderWidth:2.5,pointRadius:0,pointHitRadius:0,tension:.18,order:0});
      }
      const yMax=Math.max(1,...pairs.map(p=>p[responseKey]))*1.08;
      if(metric.key==="peak_heat_index_f"){
        datasets.push({type:"line",label:"108°F advisory criterion",data:[{x:108,y:0},{x:108,y:yMax}],borderColor:"#c57b16",borderDash:[6,4],borderWidth:1.5,pointRadius:0,order:0});
        datasets.push({type:"line",label:"113°F warning criterion",data:[{x:113,y:0},{x:113,y:yMax}],borderColor:"#c23b3b",borderDash:[6,4],borderWidth:1.5,pointRadius:0,order:0});
      }
      scatterCharts.push(new Chart(canvas.getContext("2d"),{type:"scatter",data:{datasets},options:{
        responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:"nearest",intersect:true},
        scales:{x:{title:{display:true,text:metric.label+" ("+metric.unit+")"}},y:{beginAtZero:true,title:{display:true,text:responseLabel}}},
        plugins:{legend:{labels:{boxWidth:12,font:{size:11},filter:item=>!item.text.includes("band lower")}},
          tooltip:{filter:item=>Boolean(item.raw.date),callbacks:{
            title:items=>items[0]?"Weather: "+items[0].raw.date:"",
            label:item=>[`${metric.label}: ${item.parsed.x.toFixed(metric.unit==="days"?0:1)} ${metric.unit}`,
              `${responseLabel}: ${item.parsed.y.toFixed(responseKey==="yRate"?2:0)} (${item.raw.edDate})`,
              item.raw.sources||""]
          }}}
      }}));
      addBinTable(card,pairs,metric,responseKey,responseLabel);
    });
  }
  if(firstPairs) renderThresholdCards(firstPairs,responseKey,responseLabel);
  if(groups[0]) renderExtendedMetrics(groups[0],opts,responseKey);
  renderAdjustedModels();
}

if (typeof module !== "undefined") module.exports = {
  finiteValue,shiftDate,weatherPairs,linearStats,loessCurve,piecewiseBreakpoint,
  breakpointWithCI,binnedStats,CORE_CORRELATION_METRICS,EXTENDED_CORRELATION_METRICS
};
