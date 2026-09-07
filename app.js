const state = {
  geography: null,
  hazards: [],
  analysis: [],
  summary: null,
  weather: new Map(),
  weatherRegion: new Map(),
  weatherStatus: "loading",
  advanced: null,
  chart: null
};

const $ = (id) => document.getElementById(id);

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((x) => x.trim());
  return rows.slice(1)
    .filter((r) => r.some((x) => String(x || "").trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()])));
}

async function fetchText(path) {
  const response = await fetch(path + "?v=" + Date.now(), {cache:"no-store"});
  if (!response.ok) throw new Error("Could not load " + path);
  return response.text();
}

async function fetchJSON(path) {
  const response = await fetch(path + "?v=" + Date.now(), {cache:"no-store"});
  if (!response.ok) throw new Error("Could not load " + path);
  return response.json();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mean(values) {
  return values.length ? values.reduce((a,b) => a+b, 0) / values.length : NaN;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a,b) => a-b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i=0; i<xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom ? numerator / denom : NaN;
}

function fmt(value, digits=1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function pctChange(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return NaN;
  return (value - baseline) / baseline * 100;
}

function isoDate(d) {
  return [
    d.getFullYear(),
    String(d.getMonth()+1).padStart(2,"0"),
    String(d.getDate()).padStart(2,"0")
  ].join("-");
}

function dateRange(start, end) {
  const out = [];
  const cursor = new Date(start + "T12:00:00");
  const finish = new Date(end + "T12:00:00");
  while (cursor <= finish) {
    out.push(isoDate(cursor));
    cursor.setDate(cursor.getDate()+1);
  }
  return out;
}

function selectedArea() {
  const value = $("areaSelect").value;
  if (value === "all") {
    return {
      type:"all",
      regions:Object.keys(state.geography.regions),
      parishes:state.geography.parishes.map((p)=>p.name)
    };
  }
  if (value.startsWith("region:")) {
    const region = value.split(":")[1];
    return {
      type:"region",
      regions:[region],
      parishes:state.geography.parishes.filter((p)=>p.region === region).map((p)=>p.name)
    };
  }
  if (value.startsWith("parish:")) {
    const parish = value.slice(7);
    const meta = state.geography.parishes.find((p)=>p.name === parish);
    return {type:"parish", regions:meta ? [meta.region] : [], parishes:[parish]};
  }
  return {type:"all", regions:[], parishes:[]};
}

function buildAreaOptions() {
  const select = $("areaSelect");
  select.innerHTML = "";

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "LIX Louisiana CWA — 22 parishes";
  select.appendChild(all);

  const rg = document.createElement("optgroup");
  rg.label = "LDH regions — exact daily ED series";
  Object.entries(state.geography.regions).forEach(([id, region]) => {
    const count = state.geography.parishes.filter((p)=>p.region === id).length;
    const opt = document.createElement("option");
    opt.value = "region:" + id;
    opt.textContent = region.short_name + " — " + count + " LIX parishes";
    rg.appendChild(opt);
  });
  select.appendChild(rg);


}

function buildSeasonOptions() {
  const select = $("seasonSelect");
  const years = [...new Set(state.analysis.map((r)=>Number(r.season)).filter(Number.isFinite))]
    .sort((a,b)=>b-a);

  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = years.length ? "All " + years.at(-1) + "–" + years[0] : "All seasons";
  select.appendChild(all);

  years.forEach((year)=>{
    const opt=document.createElement("option");
    opt.value=String(year);
    opt.textContent=String(year);
    select.appendChild(opt);
  });

  if (years.length) select.value = String(years[0]);
  else select.value = "all";
}

function analysisBoundsForSeason() {
  const season = $("seasonSelect").value;
  let rows = state.analysis;
  if (season !== "all") rows = rows.filter((r)=>String(r.season) === season);
  const dates = rows.map((r)=>r.date).filter(Boolean).sort();
  if (dates.length) return {min:dates[0], max:dates[dates.length-1]};

  const fallbackEnd = state.summary?.hazard_period_end || new Date().toISOString().slice(0,10);
  const year = season !== "all" ? season : fallbackEnd.slice(0,4);
  return {min:year + "-04-01", max:fallbackEnd};
}

function resetDatesToSeason() {
  const b = analysisBoundsForSeason();
  $("startDate").value = b.min;
  $("endDate").value = b.max;
}

function hazardIndex() {
  const map = new Map();
  for (const r of state.hazards) {
    map.set(r.date + "|" + r.parish, {
      advisory:num(r.heat_advisory),
      warning:num(r.excessive_heat_warning),
      hours:num(r.hazard_hours)
    });
  }
  return map;
}

function edIndex() {
  const map = new Map();
  for (const r of state.analysis) {
    const visits = finiteValue(r.ed_visits);
    const population = finiteValue(r.health_population_2020);
    if (visits !== null) map.set(r.date + "|" + r.ldh_region, {visits, population});
  }
  return map;
}

function availableEdDates(area) {
  if (area.type === "parish") return new Set();
  const season = $("seasonSelect").value;
  const rows = state.analysis.filter((r)=>
    area.regions.includes(r.ldh_region) &&
    (season === "all" || String(r.season) === season)
  );
  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.date)) grouped.set(r.date, new Set());
    grouped.get(r.date).add(r.ldh_region);
  }

  const needed = area.regions.length;
  return new Set([...grouped.entries()]
    .filter(([,regions])=>regions.size === needed)
    .map(([date])=>date));
}

function dailySeries() {
  const start = $("startDate").value;
  const end = $("endDate").value;
  if (!start || !end || start > end) return [];

  const area = selectedArea();
  const hazards = hazardIndex();
  const ed = edIndex();
  const knownEdDates = availableEdDates(area);
  const season = $("seasonSelect").value;

  return dateRange(start,end).map((date)=>{
    let advisory = 0;
    let warning = 0;
    let severityTotal = 0;
    let hoursTotal = 0;

    for (const parish of area.parishes) {
      const h = hazards.get(date + "|" + parish) || {advisory:0,warning:0,hours:0};
      if (h.warning) {
        warning++;
        severityTotal += 2;
      } else if (h.advisory) {
        advisory++;
        severityTotal += 1;
      }
      hoursTotal += h.hours;
    }

    const dateYear = date.slice(0,4);
    const seasonAllows = season === "all" || dateYear === season;
    const edKnown = area.type !== "parish" && seasonAllows && knownEdDates.has(date);
    let edVisits = null;
    let edPopulation = null;
    let edRate = null;
    if (edKnown) {
      const values = area.regions.map(region=>ed.get(date + "|" + region)).filter(Boolean);
      edVisits = values.reduce((sum,row)=>sum + row.visits, 0);
      edPopulation = values.reduce((sum,row)=>sum + (row.population || 0), 0);
      edRate = edPopulation > 0 ? edVisits / edPopulation * 100000 : null;
    }

    const category = warning > 0 ? "warning" : advisory > 0 ? "advisory" : "none";
    const n = Math.max(area.parishes.length,1);

    return {
      date,
      edKnown,
      edVisits,
      edPopulation,
      edRate,
      advisoryPct:advisory/n*100,
      warningPct:warning/n*100,
      severity:severityTotal/n,
      meanHazardHours:hoursTotal/n,
      category
    };
  });
}

function categoryStats(series) {
  const buckets={none:[],advisory:[],warning:[]};
  const rateBuckets={none:[],advisory:[],warning:[]};
  series.filter((d)=>d.edKnown).forEach((d)=>{
    buckets[d.category].push(d.edVisits);
    if (Number.isFinite(d.edRate)) rateBuckets[d.category].push(d.edRate);
  });
  const out={};
  for (const [k,values] of Object.entries(buckets)) {
    out[k]={days:values.length,mean:mean(values),median:median(values),meanRate:mean(rateBuckets[k])};
  }
  return out;
}

function lagStats(series) {
  const out=[];
  for (let lag=0; lag<=3; lag++) {
    const xs=[];
    const ys=[];
    for (let i=0; i+lag<series.length; i++) {
      const source=series[i];
      const target=series[i+lag];
      if (!source.edKnown || !target.edKnown) continue;

      const d0=new Date(source.date+"T12:00:00");
      const d1=new Date(target.date+"T12:00:00");
      if (Math.round((d1-d0)/86400000) !== lag) continue;

      xs.push(source.severity);
      ys.push(target.edVisits);
    }
    out.push({lag,r:pearson(xs,ys),n:xs.length});
  }
  return out;
}

function renderMetrics(series) {
  const area=selectedArea();
  if (area.type === "parish") {
    ["meanNone","meanAdvisory","meanWarning","corrSame","bestLag"].forEach((id)=>$(id).textContent="—");
    $("advisoryDelta").textContent="region-level LDH only";
    $("warningDelta").textContent="region-level LDH only";
    $("bestLagDetail").textContent="choose an LDH region or LIX LA";
    return;
  }

  const stats=categoryStats(series);
  const baseline=stats.none.mean;
  $("meanNone").textContent=fmt(stats.none.mean);
  $("meanAdvisory").textContent=fmt(stats.advisory.mean);
  $("meanWarning").textContent=fmt(stats.warning.mean);

  const adv=pctChange(stats.advisory.mean,baseline);
  const warn=pctChange(stats.warning.mean,baseline);
  $("advisoryDelta").textContent=Number.isFinite(adv)
    ? (adv>=0?"+":"")+adv.toFixed(0)+"% vs. no headline"
    : "ED visits / day";
  $("warningDelta").textContent=Number.isFinite(warn)
    ? (warn>=0?"+":"")+warn.toFixed(0)+"% vs. no headline"
    : "ED visits / day";

  const lags=lagStats(series);
  $("corrSame").textContent=fmt(lags[0]?.r,2);
  const best=lags.filter((x)=>Number.isFinite(x.r))
    .sort((a,b)=>Math.abs(b.r)-Math.abs(a.r))[0];

  $("bestLag").textContent=best
    ? best.lag===0 ? "Same day" : "+"+best.lag+" day"+(best.lag>1?"s":"")
    : "—";
  $("bestLagDetail").textContent=best
    ? "r = "+best.r.toFixed(2)+" • "+best.n+" paired days"
    : "0–3 days tested";
}

function renderTables(series) {
  const area=selectedArea();
  if (area.type === "parish") {
    $("categoryTable").innerHTML='<tr><td colspan="5">Daily LDH ED data are not published at parish resolution.</td></tr>';
    $("lagTable").innerHTML='<tr><td colspan="3">Choose an LDH region or LIX Louisiana CWA.</td></tr>';
    return;
  }

  const stats=categoryStats(series);
  const baseline=stats.none.mean;
  const labels={
    none:["No headline","none"],
    advisory:["Heat Advisory","advisory"],
    warning:["Heat Warning","warning"]
  };

  $("categoryTable").innerHTML=["none","advisory","warning"].map((key)=>{
    const s=stats[key];
    const delta=key==="none" ? 0 : pctChange(s.mean,baseline);
    const deltaText=key==="none" ? "baseline" :
      Number.isFinite(delta) ? (delta>=0?"+":"")+delta.toFixed(0)+"%" : "—";
    return "<tr>"+
      '<td><span class="tag '+labels[key][1]+'">'+labels[key][0]+"</span></td>"+
      "<td>"+s.days+"</td>"+
      "<td>"+fmt(s.mean)+"</td>"+
      "<td>"+fmt(s.meanRate,2)+"</td>"+
      "<td>"+fmt(s.median)+"</td>"+
      "<td>"+deltaText+"</td>"+
      "</tr>";
  }).join("");

  $("lagTable").innerHTML=lagStats(series).map((x)=>{
    const label=x.lag===0 ? "Same day" : "+"+x.lag+" day"+(x.lag>1?"s":"");
    return "<tr><td>"+label+"</td><td>"+fmt(x.r,2)+"</td><td>"+x.n+"</td></tr>";
  }).join("");
}

const WEATHER_METRICS = [
  {id:"weatherHigh", key:"high_f", label:"High", color:"#b63c17"},
  {id:"weatherLow", key:"low_f", label:"Low", color:"#007d87"},
  {id:"weatherAverage", key:"average_f", label:"Average", color:"#6646ab"},
  {id:"weatherHeatIndex", key:"peak_heat_index_f", label:"Peak HI", color:"#bf226f"}
];
const STATION_DASHES = {KBTR:[], KASD:[7,3], KMSY:[2,3], KNEW:[10,3,2,3], KHUM:[12,5]};

async function loadWeather() {
  try {
    const [stationText, regionText, wbgtText, advanced] = await Promise.all([
      fetchText("data/weather_daily.csv"),
      fetchText("data/weather_region_daily.csv"),
      fetchText("data/wbgt_region_daily.csv").catch(()=>""), 
      fetchJSON("data/advanced_analysis.json").catch(()=>null)
    ]);
    const rows = parseCSV(stationText);
    const regionRows = parseCSV(regionText);
    if (!rows.length || !regionRows.length) throw new Error("Regional weather dataset is awaiting its first build");

    for (const row of rows) {
      const day = {...row};
      for (const key of [...WEATHER_METRICS.map((m)=>m.key), "morning_low_f", "hi_hours_105", "hi_hours_108",
                         "temperature_hours", "heat_index_hours", "expected_hours"]) {
        day[key] = row[key] === "" || row[key] == null ? null : Number(row[key]);
        if (!Number.isFinite(day[key])) day[key] = null;
      }
      state.weather.set(row.date+"|"+row.station,day);
    }

    const wbgt = new Map(parseCSV(wbgtText).map(r=>[
      r.date+"|"+r.ldh_region, finiteValue(r.regional_wbgt_max_f)
    ]));
    for (const row of regionRows) {
      const day = {...row};
      for (const metric of CORRELATION_METRICS) {
        day[metric.key] = finiteValue(row[metric.key]);
      }
      day.population_2020 = finiteValue(row.population_2020);
      day.temperature_hours = finiteValue(row.temperature_hours);
      day.heat_index_hours = finiteValue(row.heat_index_hours);
      day.expected_hours = finiteValue(row.expected_hours);
      day.source_count = finiteValue(row.source_count);
      day.fallback_used = row.fallback_used;
      const w = wbgt.get(row.date+"|"+row.ldh_region);
      day.regional_wbgt_max_f = Number.isFinite(w) ? w : null;
      state.weatherRegion.set(row.date+"|"+row.ldh_region,day);
    }
    state.advanced = advanced;
    state.weatherStatus = "loaded";
  } catch (error) {
    console.error(error);
    state.weatherStatus = "unavailable";
  }
  renderAll();
}

function buildWeatherDatasets(series) {
  const stations = selectedArea().regions.flatMap((id)=>state.geography.regions[id].weather_stations || []);
  const metrics = WEATHER_METRICS.filter((m)=>$(m.id).checked);
  $("weatherLegend").replaceChildren();
  const datasets = [];
  for (const metric of metrics) {
    for (const station of stations) {
      const data = series.map((d)=>state.weather.get(d.date+"|"+station)?.[metric.key] ?? null);
      if (!data.some(Number.isFinite)) continue;
      const label = station+" · "+metric.label;
      datasets.push({type:"line", label, station, weatherKey:metric.key, data,
        yAxisID:"yWeather", borderColor:metric.color, backgroundColor:metric.color,
        borderDash:STATION_DASHES[station], borderWidth:1.8, pointRadius:0,
        pointHoverRadius:4, tension:0, spanGaps:false, order:-1});
      const entry = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.borderTopColor = metric.color;
      swatch.style.borderTopStyle = STATION_DASHES[station].length ? "dashed" : "solid";
      entry.append(swatch,document.createTextNode(label));
      $("weatherLegend").appendChild(entry);
    }
  }
  return datasets;
}

function renderChart(series) {
  const ctx=$("timelineChart").getContext("2d");
  const hasEd=series.some((d)=>d.edKnown);
  const weatherDatasets = buildWeatherDatasets(series);
  if (state.chart) state.chart.destroy();

  state.chart=new Chart(ctx,{
    type:"bar",
    data:{
      labels:series.map((d)=>d.date),
      datasets:[
        ...weatherDatasets,
        {
          type:"line",
          label:"Heat-related ED visits",
          data:series.map((d)=>d.edKnown?d.edVisits:null),
          yAxisID:"yEd",
          borderColor:"#236fa1",
          backgroundColor:"#236fa1",
          borderWidth:2.2,
          pointRadius:series.length>160?0:1.5,
          pointHoverRadius:4,
          tension:0.12,
          spanGaps:false,
          order:0
        },
        {
          label:"Heat Advisory coverage",
          data:series.map((d)=>d.advisoryPct),
          yAxisID:"yCoverage",
          backgroundColor:"rgba(233, 162, 59, 0.62)",
          borderWidth:0,
          stack:"headline",
          order:2
        },
        {
          label:"Heat Warning coverage",
          data:series.map((d)=>d.warningPct),
          yAxisID:"yCoverage",
          backgroundColor:"rgba(217, 74, 74, 0.67)",
          borderWidth:0,
          stack:"headline",
          order:1
        }
      ]
    },
    options:{
      maintainAspectRatio:false,
      animation:false,
      interaction:{mode:"index",intersect:false},
      scales:{
        x:{
          stacked:true,
          grid:{display:false},
          ticks:{maxTicksLimit:14,autoSkip:true,maxRotation:0,
            callback(value) { return this.getLabelForValue(value).slice(5); }}
        },
        yEd:{
          type:"linear",
          position:"left",
          beginAtZero:true,
          display:hasEd,
          title:{display:hasEd,text:"Heat-related ED visits"},
          grid:{color:"rgba(80,100,120,.11)"}
        },
        yWeather:{
          type:"linear",
          position:"right",
          display:weatherDatasets.length > 0,
          title:{display:true,text:"Temperature / heat index (°F)"},
          grid:{drawOnChartArea:false},
          ticks:{callback:(v)=>v+"°"}
        },
        yCoverage:{
          type:"linear",
          position:"right",
          stacked:true,
          beginAtZero:true,
          min:0,max:100,
          title:{display:true,text:"LIX parish headline coverage (%)"},
          grid:{drawOnChartArea:!hasEd},
          ticks:{callback:(v)=>v+"%"}
        }
      },
      plugins:{
        legend:{display:false},
        tooltip:{
          callbacks:{
            label(context) {
              const value = context.parsed.y;
              const dataset = context.dataset;
              if (dataset.yAxisID === "yWeather") {
                const day = state.weather.get(series[context.dataIndex].date + "|" + dataset.station);
                const hours = dataset.weatherKey === "peak_heat_index_f" ? day.heat_index_hours : day.temperature_hours;
                return dataset.label + ": " + value.toFixed(1) + " °F (" + hours + "/" + day.expected_hours + " hours)";
              }
              return dataset.label + ": " + value + (dataset.yAxisID === "yCoverage" ? "%" : "");
            },
            afterBody(items) {
              const d=series[items[0]?.dataIndex];
              if (!d) return "";
              return [
                "Headline severity score: "+d.severity.toFixed(2),
                "Mean headline hours/parish: "+d.meanHazardHours.toFixed(1)
              ];
            }
          }
        }
      }
    }
  });
}

function renderScope() {
  const area=selectedArea();
  if (area.type === "parish") {
    $("scopeNote").textContent="IEM headlines are exact for this parish. LDH does not expose the daily ED series at parish resolution, so health metrics are hidden.";
  } else {
    $("scopeNote").textContent="LDH daily ED visits are region-level and matched to LIX Louisiana heat headlines. Mississippi is excluded.";
  }
}

function renderAll() {
  const series=dailySeries();
  const label=$("areaSelect").selectedOptions[0]?.textContent || "LIX Louisiana CWA";
  const season = $("seasonSelect").value;
  const years = [...new Set(series.map((d)=>d.date.slice(0,4)))];
  const yearLabel = season === "all" ? (years.length > 1 ? years[0]+"–"+years.at(-1) : years[0] || "All seasons") : season;
  $("timelineHeading").textContent="DAILY TIMELINE · "+yearLabel;
  $("timelineTitle").textContent=label+" · "+yearLabel;
  renderScope();
  renderMetrics(series);
  renderTables(series);
  renderChart(series);
  renderWeatherCorrelations();
  $("noLdhPanel").classList.toggle("hidden",state.analysis.length>0 && state.summary?.ldh_status==="loaded");
}

async function boot() {
  try {
    const [geography,hazardText,analysisText,summary]=await Promise.all([
      fetchJSON("config/geography.json"),
      fetchText("data/heat_hazards_daily.csv"),
      fetchText("data/analysis_region_daily.csv"),
      fetchJSON("data/summary.json")
    ]);

    state.geography=geography;
    state.hazards=parseCSV(hazardText);
    state.analysis=parseCSV(analysisText).filter((r)=>r.date && r.ldh_region);
    state.summary=summary;

    buildAreaOptions();
    buildSeasonOptions();
    resetDatesToSeason();
    renderAll();

    loadWeather();
    for (const metric of WEATHER_METRICS) $(metric.id).addEventListener("change",renderAll);
    $("weatherLag").addEventListener("change",renderWeatherCorrelations);
    $("weatherResponseScale").addEventListener("change",renderWeatherCorrelations);
    $("adjustedPeriod").addEventListener("change",renderWeatherCorrelations);
    $("areaSelect").addEventListener("change",renderAll);
    $("seasonSelect").addEventListener("change",()=>{
      resetDatesToSeason();
      renderAll();
    });
    $("startDate").addEventListener("change",renderAll);
    $("endDate").addEventListener("change",renderAll);
    $("resetDates").addEventListener("click",()=>{
      resetDatesToSeason();
      renderAll();
    });
  } catch (error) {
    console.error(error);
    $("noLdhPanel").classList.remove("hidden");
  }
}

boot();
