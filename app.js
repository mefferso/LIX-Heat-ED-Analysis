const state = {
  geography: null,
  hazards: [],
  committedAnalysis: [],
  summary: null,
  localLdh: null,
  localLdhDates: null,
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
  const response = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load " + path);
  return response.text();
}

async function fetchJSON(path) {
  const response = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load " + path);
  return response.json();
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bparish\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parishLookup() {
  const lookup = new Map();
  state.geography.parishes.forEach((p) => {
    lookup.set(normalizeKey(p.name), p.name);
    lookup.set(p.fips, p.name);
  });
  [
    ["saintbernard", "St. Bernard"],
    ["saintcharles", "St. Charles"],
    ["sainthelena", "St. Helena"],
    ["saintjames", "St. James"],
    ["saintjohnthebaptist", "St. John the Baptist"],
    ["stjohnbaptist", "St. John the Baptist"],
    ["sainttammany", "St. Tammany"]
  ].forEach(([key, name]) => lookup.set(key, name));
  return lookup;
}

function normalizedHeader(headers, candidates) {
  const lookup = new Map(headers.map((h) => [normalizeKey(h), h]));
  for (const candidate of candidates) {
    const found = lookup.get(normalizeKey(candidate));
    if (found) return found;
  }
  return null;
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return String(year) + "-" + String(us[1]).padStart(2, "0") + "-" + String(us[2]).padStart(2, "0");
  }

  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) {
    return [
      dt.getFullYear(),
      String(dt.getMonth() + 1).padStart(2, "0"),
      String(dt.getDate()).padStart(2, "0")
    ].join("-");
  }
  return null;
}

function numberOrZero(value) {
  const n = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function percentChange(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((value - baseline) / baseline) * 100;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;

  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denom = Math.sqrt(dx2 * dy2);
  return denom ? numerator / denom : NaN;
}

function dateRange(start, end) {
  const out = [];
  const cursor = new Date(start + "T12:00:00");
  const finish = new Date(end + "T12:00:00");
  while (cursor <= finish) {
    out.push([
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, "0"),
      String(cursor.getDate()).padStart(2, "0")
    ].join("-"));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function selectedParishes() {
  const value = $("areaSelect").value;
  if (value === "all") return state.geography.parishes.map((p) => p.name);
  if (value.startsWith("region:")) {
    const region = value.split(":")[1];
    return state.geography.parishes.filter((p) => p.region === region).map((p) => p.name);
  }
  if (value.startsWith("parish:")) return [value.slice(7)];
  return state.geography.parishes.map((p) => p.name);
}

function selectedAreaLabel() {
  const selected = $("areaSelect").selectedOptions[0];
  return selected ? selected.textContent : "LIX Louisiana CWA";
}

function buildAreaOptions() {
  const select = $("areaSelect");
  select.innerHTML = "";

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "LIX Louisiana CWA — 22 parishes";
  select.appendChild(all);

  const regionGroup = document.createElement("optgroup");
  regionGroup.label = "LDH regions";
  Object.entries(state.geography.regions).forEach(([id, region]) => {
    const count = state.geography.parishes.filter((p) => p.region === id).length;
    const opt = document.createElement("option");
    opt.value = "region:" + id;
    opt.textContent = region.short_name + " — " + count + " LIX parishes";
    regionGroup.appendChild(opt);
  });
  select.appendChild(regionGroup);

  const parishGroup = document.createElement("optgroup");
  parishGroup.label = "Individual parishes";
  state.geography.parishes
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = "parish:" + p.name;
      opt.textContent = p.name;
      parishGroup.appendChild(opt);
    });
  select.appendChild(parishGroup);
}

function initializeDates() {
  const fallbackEnd = new Date().toISOString().slice(0, 10);
  const end = (state.summary && state.summary.hazard_period_end) || fallbackEnd;
  const year = Number(end.slice(0, 4));
  let start = year + "-04-01";

  if (state.localLdhDates) {
    start = state.localLdhDates.min;
    $("endDate").value = state.localLdhDates.max;
  } else {
    $("endDate").value = end;
  }
  $("startDate").value = start;
}

function hazardIndex() {
  const map = new Map();
  state.hazards.forEach((r) => {
    map.set(r.date + "|" + r.parish, {
      advisory: Number(r.heat_advisory) || 0,
      warning: Number(r.excessive_heat_warning) || 0,
      hours: Number(r.hazard_hours) || 0
    });
  });
  return map;
}

function committedEdIndex() {
  if (!state.committedAnalysis.length) return { map: null, min: null, max: null };
  const map = new Map();
  let min = null;
  let max = null;
  state.committedAnalysis.forEach((r) => {
    map.set(r.date + "|" + r.parish, numberOrZero(r.ed_visits));
    if (!min || r.date < min) min = r.date;
    if (!max || r.date > max) max = r.date;
  });
  return { map, min, max };
}

function activeEdSource() {
  if (state.localLdh) {
    return {
      map: state.localLdh,
      min: state.localLdhDates.min,
      max: state.localLdhDates.max,
      label: "local LDH CSV"
    };
  }
  const committed = committedEdIndex();
  if (committed.map) return { map: committed.map, min: committed.min, max: committed.max, label: "committed LDH data" };
  return { map: null, min: null, max: null, label: null };
}

function dailySeries() {
  const start = $("startDate").value;
  const end = $("endDate").value;
  if (!start || !end || start > end) return [];

  const parishes = selectedParishes();
  const hazards = hazardIndex();
  const ed = activeEdSource();

  return dateRange(start, end).map((date) => {
    let advisoryOnly = 0;
    let warning = 0;
    let severityTotal = 0;
    let hazardHours = 0;

    parishes.forEach((parish) => {
      const h = hazards.get(date + "|" + parish) || { advisory: 0, warning: 0, hours: 0 };
      if (h.warning) {
        warning++;
        severityTotal += 2;
      } else if (h.advisory) {
        advisoryOnly++;
        severityTotal += 1;
      }
      hazardHours += h.hours;
    });

    const edKnown = Boolean(ed.map && date >= ed.min && date <= ed.max);
    let edVisits = null;
    if (edKnown) {
      edVisits = parishes.reduce((sum, parish) => sum + (ed.map.get(date + "|" + parish) || 0), 0);
    }

    let category = "none";
    if (warning > 0) category = "warning";
    else if (advisoryOnly > 0) category = "advisory";

    return {
      date: date,
      edVisits: edVisits,
      edKnown: edKnown,
      advisoryPct: (advisoryOnly / parishes.length) * 100,
      warningPct: (warning / parishes.length) * 100,
      severity: severityTotal / parishes.length,
      hazardHours: hazardHours,
      category: category
    };
  });
}

function categoryStats(series) {
  const buckets = { none: [], advisory: [], warning: [] };
  series.filter((d) => d.edKnown).forEach((d) => buckets[d.category].push(d.edVisits));

  const stats = {};
  Object.entries(buckets).forEach(([key, values]) => {
    stats[key] = {
      days: values.length,
      mean: mean(values),
      median: median(values)
    };
  });
  return stats;
}

function lagStats(series) {
  const results = [];
  for (let lag = 0; lag <= 3; lag++) {
    const x = [];
    const y = [];
    for (let i = 0; i + lag < series.length; i++) {
      const target = series[i + lag];
      if (!target.edKnown) continue;
      x.push(series[i].severity);
      y.push(target.edVisits);
    }
    results.push({ lag: lag, r: pearson(x, y), n: x.length });
  }
  return results;
}

function renderMetrics(series) {
  const stats = categoryStats(series);
  const baseline = stats.none.mean;

  $("meanNone").textContent = fmt(stats.none.mean);
  $("meanAdvisory").textContent = fmt(stats.advisory.mean);
  $("meanWarning").textContent = fmt(stats.warning.mean);

  const advDelta = percentChange(stats.advisory.mean, baseline);
  const warnDelta = percentChange(stats.warning.mean, baseline);
  $("advisoryDelta").textContent = Number.isFinite(advDelta)
    ? (advDelta >= 0 ? "+" : "") + advDelta.toFixed(0) + "% vs. no headline"
    : "ED visits / day";
  $("warningDelta").textContent = Number.isFinite(warnDelta)
    ? (warnDelta >= 0 ? "+" : "") + warnDelta.toFixed(0) + "% vs. no headline"
    : "ED visits / day";

  const lags = lagStats(series);
  $("corrSame").textContent = fmt(lags[0].r, 2);

  const valid = lags.filter((x) => Number.isFinite(x.r)).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const best = valid[0];
  $("bestLag").textContent = best
    ? (best.lag === 0 ? "Same day" : "+" + best.lag + " day" + (best.lag > 1 ? "s" : ""))
    : "—";
  $("bestLagDetail").textContent = best
    ? "r = " + best.r.toFixed(2) + " • " + best.n + " paired days"
    : "0–3 days tested";
}

function renderCategoryTable(series) {
  const stats = categoryStats(series);
  const baseline = stats.none.mean;
  const labels = {
    none: ["No headline", "none"],
    advisory: ["Heat Advisory", "advisory"],
    warning: ["Heat Warning", "warning"]
  };

  $("categoryTable").innerHTML = ["none", "advisory", "warning"].map((key) => {
    const s = stats[key];
    const delta = key === "none" ? 0 : percentChange(s.mean, baseline);
    const deltaText = key === "none"
      ? "baseline"
      : Number.isFinite(delta)
        ? (delta >= 0 ? "+" : "") + delta.toFixed(0) + "%"
        : "—";

    return "<tr>" +
      '<td><span class="tag ' + labels[key][1] + '">' + labels[key][0] + "</span></td>" +
      "<td>" + s.days + "</td>" +
      "<td>" + fmt(s.mean) + "</td>" +
      "<td>" + fmt(s.median) + "</td>" +
      "<td>" + deltaText + "</td>" +
      "</tr>";
  }).join("");
}

function renderLagTable(series) {
  const lags = lagStats(series);
  $("lagTable").innerHTML = lags.map((item) => {
    const label = item.lag === 0 ? "Same day" : "+" + item.lag + " day" + (item.lag > 1 ? "s" : "");
    return "<tr><td>" + label + "</td><td>" + fmt(item.r, 2) + "</td><td>" + item.n + "</td></tr>";
  }).join("");
}

function renderChart(series) {
  const context = $("timelineChart").getContext("2d");
  const hasEd = series.some((d) => d.edKnown);

  if (state.chart) state.chart.destroy();

  state.chart = new Chart(context, {
    type: "bar",
    data: {
      labels: series.map((d) => d.date),
      datasets: [
        {
          type: "line",
          label: "Heat-related ED visits",
          data: series.map((d) => d.edKnown ? d.edVisits : null),
          yAxisID: "yEd",
          borderColor: "#236fa1",
          backgroundColor: "#236fa1",
          borderWidth: 2.2,
          pointRadius: series.length > 120 ? 0 : 1.6,
          pointHoverRadius: 4,
          tension: 0.15,
          spanGaps: false,
          order: 0
        },
        {
          label: "Heat Advisory coverage",
          data: series.map((d) => d.advisoryPct),
          yAxisID: "yCoverage",
          backgroundColor: "rgba(233, 162, 59, 0.62)",
          borderWidth: 0,
          stack: "headline",
          order: 2
        },
        {
          label: "Heat Warning coverage",
          data: series.map((d) => d.warningPct),
          yAxisID: "yCoverage",
          backgroundColor: "rgba(217, 74, 74, 0.67)",
          borderWidth: 0,
          stack: "headline",
          order: 1
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: false,
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { maxTicksLimit: 14, autoSkip: true, maxRotation: 0 }
        },
        yEd: {
          type: "linear",
          position: "left",
          beginAtZero: true,
          display: hasEd,
          title: { display: hasEd, text: "Heat-related ED visits" },
          grid: { color: "rgba(80, 100, 120, .11)" }
        },
        yCoverage: {
          type: "linear",
          position: "right",
          stacked: true,
          beginAtZero: true,
          min: 0,
          max: 100,
          title: { display: true, text: "Parish headline coverage (%)" },
          grid: { drawOnChartArea: !hasEd },
          ticks: { callback: (value) => value + "%" }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterBody(items) {
              const idx = items[0] && items[0].dataIndex;
              const d = series[idx];
              if (!d) return "";
              return [
                "Severity score: " + d.severity.toFixed(2),
                "Mean headline hours/parish: " + (d.hazardHours / selectedParishes().length).toFixed(1)
              ];
            }
          }
        }
      }
    }
  });
}

function renderStatus() {
  const hasCommitted = state.committedAnalysis.length > 0;
  const usingLocal = Boolean(state.localLdh);
  $("statusDot").className = "status-dot " + ((hasCommitted || usingLocal) ? "ok" : "warn");

  if (usingLocal) {
    $("dataStatus").textContent = "IEM + local LDH data active";
    $("dataUpdated").textContent = state.localLdhDates.min + " through " + state.localLdhDates.max;
  } else if (hasCommitted) {
    const ed = committedEdIndex();
    $("dataStatus").textContent = "IEM + LDH data active";
    $("dataUpdated").textContent = ed.min + " through " + ed.max;
  } else {
    $("dataStatus").textContent = "IEM headlines active • LDH pending";
    const updated = state.summary && state.summary.generated_at
      ? new Date(state.summary.generated_at).toLocaleString()
      : "generated data loaded";
    $("dataUpdated").textContent = updated;
  }

  $("noLdhPanel").classList.toggle("hidden", hasCommitted || usingLocal);
}

function renderAll() {
  const series = dailySeries();
  $("timelineTitle").textContent = selectedAreaLabel();
  renderChart(series);
  renderMetrics(series);
  renderCategoryTable(series);
  renderLagTable(series);
  renderStatus();
}

async function handleLdhFile(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("That CSV has no data rows.");

  const headers = Object.keys(rows[0]);
  const dateCol = normalizedHeader(headers, ["date", "visit date", "visit_date", "encounter date"]);
  const parishCol = normalizedHeader(headers, ["parish", "patient parish", "parish of residence", "patient parish of residence"]);
  const countCol = normalizedHeader(headers, ["ed_visits", "ed visits", "HRI ED visits", "heat-related ED visits", "visits", "count"]);

  if (!dateCol || !parishCol || !countCol) {
    throw new Error("I need date, parish, and ED-visit count columns. Found: " + headers.join(", "));
  }

  const lookup = parishLookup();
  const map = new Map();
  let min = null;
  let max = null;
  let accepted = 0;
  let ignored = 0;

  rows.forEach((row) => {
    const date = parseDate(row[dateCol]);
    const parish = lookup.get(normalizeKey(row[parishCol]));
    const value = Number(String(row[countCol] || "").replace(/,/g, ""));

    if (!date || !parish || !Number.isFinite(value)) {
      ignored++;
      return;
    }

    const key = date + "|" + parish;
    map.set(key, (map.get(key) || 0) + value);
    if (!min || date < min) min = date;
    if (!max || date > max) max = date;
    accepted++;
  });

  if (!accepted) throw new Error("I couldn't match any rows to LIX Louisiana parishes.");

  state.localLdh = map;
  state.localLdhDates = { min: min, max: max };
  $("startDate").value = min;
  $("endDate").value = max;

  const message = $("uploadMessage");
  message.classList.remove("hidden");
  message.textContent =
    "Loaded " + accepted.toLocaleString() + " LDH rows from " + file.name +
    " (" + min + " through " + max + ")." +
    (ignored ? " Ignored " + ignored + " rows that could not be matched." : "") +
    " Nothing was uploaded to a server.";
  renderAll();
}

async function boot() {
  try {
    const [geography, hazardText, analysisText, summary] = await Promise.all([
      fetchJSON("config/geography.json"),
      fetchText("data/heat_hazards_daily.csv"),
      fetchText("data/analysis_daily.csv"),
      fetchJSON("data/summary.json")
    ]);

    state.geography = geography;
    state.hazards = parseCSV(hazardText);
    state.committedAnalysis = parseCSV(analysisText).filter((r) => r.date && r.parish);
    state.summary = summary;

    buildAreaOptions();
    initializeDates();
    renderAll();

    $("areaSelect").addEventListener("change", renderAll);
    $("startDate").addEventListener("change", renderAll);
    $("endDate").addEventListener("change", renderAll);
    $("resetDates").addEventListener("click", () => {
      initializeDates();
      renderAll();
    });

    $("ldhFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        await handleLdhFile(file);
      } catch (error) {
        const message = $("uploadMessage");
        message.classList.remove("hidden");
        message.textContent = "Could not use that LDH file: " + error.message;
      }
    });
  } catch (error) {
    console.error(error);
    $("dataStatus").textContent = "Data load failed";
    $("dataUpdated").textContent = error.message;
    $("statusDot").className = "status-dot warn";
  }
}

boot();
