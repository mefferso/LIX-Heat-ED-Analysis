/* Daily, complete-case weather / ED comparisons. No missing value becomes zero. */
const CORRELATION_METRICS = [
  {key:"high_f", label:"High temperature"},
  {key:"low_f", label:"Low temperature"},
  {key:"average_f", label:"Average temperature"},
  {key:"peak_heat_index_f", label:"Peak heat index"}
];
const SCATTER_YEAR_COLORS = ["#236fa1", "#ae5215", "#754ca3", "#168175"];
let scatterCharts = [];

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

function weatherPairs({analysis, weather, regions, geography, start, end, season, lag=0, coverage=0.75}) {
  const ed = new Map();
  for (const row of analysis) {
    const visits = finiteValue(row.ed_visits);
    if (visits !== null && visits >= 0 && regions.includes(row.ldh_region) &&
        (season === "all" || String(row.season) === season)) {
      ed.set(row.date + "|" + row.ldh_region, visits);
    }
  }
  const dates = [...new Set(analysis.map(row=>row.date))].sort();
  const pairs = [];
  let eligible = 0;
  for (const date of dates) {
    const target = shiftDate(date, lag);
    // Both dates must be inside the requested period and same summer/year.
    if (date < start || target > end || date.slice(0,4) !== target.slice(0,4) ||
        (season !== "all" && date.slice(0,4) !== season)) continue;
    const visits = regions.map(id=>ed.get(target+"|"+id));
    if (!visits.every(Number.isFinite)) continue;
    eligible++;
    const regionalWeather = [];
    for (const id of regions) {
      const stations = geography.regions[id].weather_stations || [];
      if (!stations.length) break;
      const stationDays = stations.map(station=>weather.get(date+"|"+station));
      const complete = stationDays.every(day=> {
        if (!day || !CORRELATION_METRICS.every(metric=>finiteValue(day[metric.key]) !== null)) return false;
        const expected = finiteValue(day.expected_hours);
        const temperatures = finiteValue(day.temperature_hours);
        const humidity = finiteValue(day.heat_index_hours);
        return expected > 0 && temperatures > 0 && humidity > 0 &&
          temperatures / expected >= coverage && humidity / expected >= coverage;
      });
      if (!complete) break;
      regionalWeather.push(Object.fromEntries(CORRELATION_METRICS.map(metric=>[
        metric.key, stationDays.reduce((sum,day)=>sum+Number(day[metric.key]),0)/stations.length
      ])));
    }
    if (regionalWeather.length !== regions.length) continue;
    pairs.push({date, edDate:target, y:visits.reduce((a,b)=>a+b,0),
      ...Object.fromEntries(CORRELATION_METRICS.map(metric=>[
        metric.key, regionalWeather.reduce((sum,day)=>sum+day[metric.key],0)/regions.length
      ]))});
  }
  return {pairs, eligible};
}

function linearStats(pairs, key) {
  const n = pairs.length;
  if (n < 3) return {n, r:null, r2:null, slope:null, intercept:null};
  const mx = pairs.reduce((sum,p)=>sum+p[key],0)/n;
  const my = pairs.reduce((sum,p)=>sum+p.y,0)/n;
  let xx=0, yy=0, xy=0;
  for (const p of pairs) {
    xx += (p[key]-mx)**2;
    yy += (p.y-my)**2;
    xy += (p[key]-mx)*(p.y-my);
  }
  if (!xx || !yy) return {n, r:null, r2:null, slope:null, intercept:null};
  const r = Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy)));
  return {n, r, r2:r*r, slope:xy/xx, intercept:my-xy/xx*mx};
}

function loessCurve(pairs, key, span=0.22, pointCount=64) {
  if (pairs.length < 3) return [];
  const source = pairs.map(p=>({x:p[key],y:p.y})).filter(p=>Number.isFinite(p.x) && Number.isFinite(p.y));
  if (source.length < 3) return [];
  const minX = Math.min(...source.map(p=>p.x));
  const maxX = Math.max(...source.map(p=>p.x));
  if (minX === maxX) return [];
  const neighbors = Math.min(source.length,Math.max(15,Math.ceil(source.length*span)));
  const curve = [];
  for (let i=0; i<pointCount; i++) {
    const x = minX + (maxX-minX)*i/(pointCount-1);
    const distances = source.map(p=>Math.abs(p.x-x)).sort((a,b)=>a-b);
    let bandwidth = distances[neighbors-1];
    if (!bandwidth) bandwidth = distances.find(d=>d>0) || 1;
    let sw=0, sx=0, sy=0, sxx=0, sxy=0;
    for (const p of source) {
      const ratio = Math.abs(p.x-x)/bandwidth;
      if (ratio > 1) continue;
      const weight = (1-ratio**3)**3;
      sw += weight;
      sx += weight*p.x;
      sy += weight*p.y;
      sxx += weight*p.x*p.x;
      sxy += weight*p.x*p.y;
    }
    if (!sw) continue;
    const denominator = sw*sxx-sx*sx;
    const y = Math.abs(denominator) < 1e-9 ? sy/sw :
      ((sy*sxx-sx*sxy)/denominator) + ((sw*sxy-sx*sy)/denominator)*x;
    if (Number.isFinite(y)) curve.push({x,y:Math.max(0,y)});
  }
  return curve;
}

function renderWeatherCorrelations() {
  scatterCharts.forEach(chart=>chart.destroy());
  scatterCharts = [];
  const container = $("weatherScatterGroups");
  container.replaceChildren();
  $("weatherCorrelationTable").replaceChildren();
  if (state.weatherStatus !== "loaded") {
    $("correlationScope").textContent = state.weatherStatus === "loading" ?
      "Loading station weather for the comparisons…" : "Weather data unavailable; correlations cannot be calculated.";
    return;
  }
  const start = $("startDate").value, end = $("endDate").value;
  if (!start || !end || start > end) {
    $("correlationScope").textContent = "Choose a valid start and end date.";
    return;
  }
  const selected = selectedArea();
  const regionIds = Object.keys(state.geography.regions);
  const groups = selected.type === "all" ? [
    {name:"Combined LDH regions", regions:regionIds},
    ...regionIds.map(id=>({name:state.geography.regions[id].short_name, regions:[id]}))
  ] : [{name:state.geography.regions[selected.regions[0]].short_name, regions:selected.regions}];
  const lag = Number($("weatherLag").value);
  const coverage = Number($("weatherCoverage").value);
  const response = lag ? `ED visits ${lag} day${lag === 1 ? "" : "s"} later` : "Same-day ED visits";
  $("correlationScope").textContent = `${start} through ${end} · ${response}. Each dot is one paired day; color identifies the weather year. Area, season and dates follow the controls above. Days missing any of the four weather variables or required station coverage are excluded from all four plots. Zero-visit days are retained.`;
  for (const group of groups) {
    const {pairs, eligible} = weatherPairs({analysis:state.analysis, weather:state.weather,
      geography:state.geography, regions:group.regions, start, end,
      season:$("seasonSelect").value, lag, coverage});
    const stats = CORRELATION_METRICS.map(metric=>linearStats(pairs,metric.key));
    const valid = stats.filter(s=>s.r !== null);
    const bestAbs = valid.length ? Math.max(...valid.map(s=>Math.abs(s.r))) : null;
    // Report displayed-precision ties instead of an arbitrary winner.
    const best = stats.map(s=>s.r !== null && Math.abs(s.r).toFixed(3) === bestAbs?.toFixed(3));
    const tr = document.createElement("tr");
    const values = [group.name, best.some(Boolean) ? CORRELATION_METRICS.filter((_,i)=>best[i]).map(m=>m.label).join(" / ") : "Insufficient variation/data",
      ...stats.map(s=>s.r === null ? "—" : s.r.toFixed(3)), String(pairs.length)];
    values.forEach((value,i)=> {
      const td = document.createElement("td");
      td.textContent = value;
      if (i >= 2 && i <= 5 && best[i-2]) td.className = "best-correlation";
      tr.appendChild(td);
    });
    $("weatherCorrelationTable").appendChild(tr);
    const section = document.createElement("section");
    section.className = "scatter-group";
    const heading = document.createElement("h3");
    heading.textContent = group.name;
    const note = document.createElement("p");
    note.className = "correlation-note";
    const stationNote = group.regions.length > 1 ?
      "ED visits summed across four LDH regions; weather is the equal-weight mean of four regional values (KMSY/KNEW averaged first). This spatial summary can smooth local extremes." :
      group.regions[0] === "1" ? "Weather is the mean of KMSY and KNEW daily values; both stations required." :
      `Weather: ${state.geography.regions[group.regions[0]].weather_stations.join(", ")}.`;
    note.textContent = `${stationNote} ${pairs.length} paired days; ${eligible-pairs.length} excluded for missing/incomplete weather.`;
    const grid = document.createElement("div");
    grid.className = "scatter-grid";
    section.append(heading,note,grid);
    container.appendChild(section);
    CORRELATION_METRICS.forEach((metric,i)=> {
      const card = document.createElement("article");
      card.className = "scatter-card";
      const title = document.createElement("h4");
      title.textContent = metric.label;
      const stat = stats[i];
      const detail = document.createElement("p");
      detail.className = "scatter-stats";
      detail.textContent = stat.r === null ? `n = ${stat.n} · Correlation needs ≥3 days and variation in both variables` :
        `Pearson r = ${stat.r.toFixed(3)} · r² = ${stat.r2.toFixed(3)} · n = ${stat.n}`;
      card.append(title,detail);
      grid.appendChild(card);
      if (!pairs.length) {
        const empty = document.createElement("p");
        empty.className = "scatter-empty";
        empty.textContent = "No matched days. Expand the date range or adjust observation coverage.";
        card.appendChild(empty);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "scatter-wrap";
      const canvas = document.createElement("canvas");
      canvas.setAttribute("role","img");
      canvas.setAttribute("aria-label",`${group.name}: ${metric.label} versus ${response}. ${detail.textContent}`);
      wrap.appendChild(canvas);
      card.appendChild(wrap);
      const years = [...new Set(pairs.map(p=>p.date.slice(0,4)))].sort();
      const datasets = years.map(year=>({label:year,
        data:pairs.filter(p=>p.date.startsWith(year)).map(p=>({x:p[metric.key],y:p.y,date:p.date,edDate:p.edDate})),
        backgroundColor:SCATTER_YEAR_COLORS[(Number(year)-2023)%SCATTER_YEAR_COLORS.length]+"88",
        pointRadius:3, pointHoverRadius:5, order:1}));
      const curve = loessCurve(pairs,metric.key);
      if (curve.length) {
        datasets.push({type:"line",label:"Smoothed average",data:curve,
          borderColor:"#17212b",borderWidth:2.5,pointRadius:0,pointHitRadius:0,tension:0.18,order:0});
      }
      scatterCharts.push(new Chart(canvas.getContext("2d"),{type:"scatter",data:{datasets},options:{
        responsive:true,maintainAspectRatio:false,animation:false,
        interaction:{mode:"nearest",intersect:true},
        scales:{x:{title:{display:true,text:metric.label+" (°F)"}},
          y:{beginAtZero:true,title:{display:true,text:response},ticks:{precision:0}}},
        plugins:{legend:{labels:{boxWidth:12,font:{size:12}}},tooltip:{
          filter:item=>Boolean(item.raw.date),callbacks:{
            title:items=>items[0] ? "Weather: "+items[0].raw.date : "",
            label:item=>[`${metric.label}: ${item.parsed.x.toFixed(1)} °F`,
              `ED visits: ${item.parsed.y} (${item.raw.edDate})`]
          }}}
      }}));
    });
  }
}

if (typeof module !== "undefined") module.exports = {finiteValue,shiftDate,weatherPairs,linearStats,loessCurve,CORRELATION_METRICS};
