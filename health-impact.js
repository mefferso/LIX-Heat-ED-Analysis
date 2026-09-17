/*
 * Local heat-health impact thresholds.
 *
 * This intentionally does NOT modify the published LDH/weather datasets or the
 * existing correlation analysis. It reads the same region-day archive and builds
 * a separate, CDC-inspired health-impact view in the browser.
 */
const IMPACT_WARM_MONTHS = new Set([5, 6, 7, 8, 9]);
const IMPACT_TABLE_THRESHOLDS = [104, 105, 106, 107, 108, 109, 110, 111, 113];
let impactProbabilityChart = null;
let impactListenersAttached = false;

function impactFinite(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function impactQuantile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function impactMonth(date) {
  return Number(String(date).slice(5, 7));
}

function impactWarmSeason(rows) {
  return rows.filter((row) => IMPACT_WARM_MONTHS.has(impactMonth(row.date)));
}

function impactPeriodRows(rows, period) {
  if (period === "early") return rows.filter((row) => [5, 6].includes(impactMonth(row.date)));
  if (period === "peak") return rows.filter((row) => [7, 8].includes(impactMonth(row.date)));
  if (period === "late") return rows.filter((row) => impactMonth(row.date) === 9);
  return rows;
}

function impactPerformance(rows, eventCutoff, hiThreshold) {
  const source = rows.filter((row) =>
    Number.isFinite(row.peak_heat_index_f) && Number.isFinite(row.yRate)
  );
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const row of source) {
    const exposed = row.peak_heat_index_f >= hiThreshold;
    const event = row.yRate >= eventCutoff;
    if (exposed && event) tp++;
    else if (exposed) fp++;
    else if (event) fn++;
    else tn++;
  }
  const exposedN = tp + fp;
  const belowN = fn + tn;
  const eventN = tp + fn;
  const nonEventN = fp + tn;
  const eventProbability = exposedN ? tp / exposedN : null;
  const belowProbability = belowN ? fn / belowN : null;
  const sensitivity = eventN ? tp / eventN : null;
  const specificity = nonEventN ? tn / nonEventN : null;
  const riskRatio = eventProbability != null && belowProbability > 0 ? eventProbability / belowProbability : null;

  let rrLow = null, rrHigh = null;
  if (source.length && exposedN && belowN) {
    // Katz log-RR interval with Haldane-Anscombe correction only when a cell is zero.
    let a = tp, b = fp, c = fn, d = tn;
    if ([a, b, c, d].some((v) => v === 0)) {
      a += 0.5; b += 0.5; c += 0.5; d += 0.5;
    }
    const risk1 = a / (a + b);
    const risk0 = c / (c + d);
    if (risk1 > 0 && risk0 > 0) {
      const rr = risk1 / risk0;
      const se = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
      rrLow = Math.exp(Math.log(rr) - 1.96 * se);
      rrHigh = Math.exp(Math.log(rr) + 1.96 * se);
    }
  }

  return {
    n: source.length,
    threshold: hiThreshold,
    tp, fp, fn, tn,
    exposedN, belowN, eventN,
    eventProbability, belowProbability,
    sensitivity, specificity,
    riskRatio, rrLow, rrHigh
  };
}

function impactRiskBins(rows, eventCutoff, width = 2, minCount = 8) {
  const source = rows.filter((row) =>
    Number.isFinite(row.peak_heat_index_f) && Number.isFinite(row.yRate)
  );
  if (!source.length) return [];
  const min = Math.floor(Math.min(...source.map((row) => row.peak_heat_index_f)) / width) * width;
  const max = Math.ceil(Math.max(...source.map((row) => row.peak_heat_index_f)) / width) * width;
  const bins = [];
  for (let lo = min; lo < max; lo += width) {
    const members = source.filter((row) => row.peak_heat_index_f >= lo && row.peak_heat_index_f < lo + width);
    if (members.length < minCount) continue;
    const events = members.filter((row) => row.yRate >= eventCutoff).length;
    bins.push({
      lo,
      hi: lo + width,
      mid: lo + width / 2,
      n: members.length,
      events,
      probability: events / members.length,
      meanRate: members.reduce((sum, row) => sum + row.yRate, 0) / members.length
    });
  }
  return bins;
}

function impactThresholdDelta(rows, eventCutoff, candidate, current = 108) {
  if (candidate === current) return {days: 0, events: 0, direction: "same"};
  const low = Math.min(candidate, current);
  const high = Math.max(candidate, current);
  const between = rows.filter((row) =>
    Number.isFinite(row.peak_heat_index_f) && row.peak_heat_index_f >= low && row.peak_heat_index_f < high
  );
  const events = between.filter((row) => Number.isFinite(row.yRate) && row.yRate >= eventCutoff).length;
  return {
    days: between.length,
    events,
    direction: candidate < current ? "lower" : "higher"
  };
}

function impactPct(value, digits = 0) {
  return Number.isFinite(value) ? (value * 100).toFixed(digits) + "%" : "—";
}

function impactRate(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function impactRR(stats) {
  if (!Number.isFinite(stats.riskRatio)) return "—";
  const ci = Number.isFinite(stats.rrLow) && Number.isFinite(stats.rrHigh)
    ? ` (${stats.rrLow.toFixed(1)}–${stats.rrHigh.toFixed(1)})`
    : "";
  return stats.riskRatio.toFixed(1) + "×" + ci;
}

function impactArchivePairs() {
  if (typeof state === "undefined" || !state.geography || !state.analysis?.length || state.weatherStatus !== "loaded") return [];
  const area = selectedArea();
  if (!area.regions?.length || area.type === "parish") return [];
  const dates = state.analysis.map((row) => row.date).filter(Boolean).sort();
  if (!dates.length) return [];
  const result = weatherPairs({
    analysis: state.analysis,
    regionWeather: state.weatherRegion,
    regions: area.regions,
    geography: state.geography,
    start: dates[0],
    end: dates.at(-1),
    season: "all",
    lag: 0,
    metricKeys: ["peak_heat_index_f"]
  });
  return impactWarmSeason(result.pairs);
}

function renderImpactProbabilityChart(rows, eventCutoff, percentileLabel) {
  const canvas = document.getElementById("impactProbabilityChart");
  if (!canvas || typeof Chart === "undefined") return;
  if (impactProbabilityChart) impactProbabilityChart.destroy();

  const bins = impactRiskBins(rows, eventCutoff);
  const maxProbability = bins.length ? Math.max(...bins.map((b) => b.probability * 100)) : 0;
  const yMax = Math.min(100, Math.max(20, Math.ceil(maxProbability / 10) * 10));
  const datasets = [{
    type: "line",
    label: `Probability of ≥${percentileLabel} ED-rate day`,
    data: bins.map((b) => ({x: b.mid, y: b.probability * 100, ...b})),
    borderColor: "#17212b",
    backgroundColor: "#17212b",
    borderWidth: 2.5,
    pointRadius: 4,
    pointHoverRadius: 6,
    tension: 0.18
  }];
  datasets.push({
    type: "line",
    label: "108°F advisory criterion",
    data: [{x: 108, y: 0}, {x: 108, y: yMax}],
    borderColor: "#c57b16",
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0
  });
  datasets.push({
    type: "line",
    label: "113°F warning criterion",
    data: [{x: 113, y: 0}, {x: 113, y: yMax}],
    borderColor: "#c23b3b",
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0
  });

  impactProbabilityChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {type: "linear", title: {display: true, text: "Daily peak heat index (°F)"}},
        y: {beginAtZero: true, max: yMax, title: {display: true, text: `Chance of ≥${percentileLabel} ED-rate day`}, ticks: {callback: (v) => v + "%"}}
      },
      plugins: {
        legend: {labels: {boxWidth: 12}},
        tooltip: {
          filter: (item) => Number.isFinite(item.raw?.n),
          callbacks: {
            title: (items) => items[0] ? `${items[0].raw.lo.toFixed(0)}–<${items[0].raw.hi.toFixed(0)}°F` : "",
            label: (item) => [
              `High-impact days: ${item.raw.events}/${item.raw.n} (${item.parsed.y.toFixed(1)}%)`,
              `Mean ED rate: ${item.raw.meanRate.toFixed(2)} /100k`
            ]
          }
        }
      }
    }
  });
}

function renderImpactThresholdTable(rows, eventCutoff, candidate) {
  const body = document.getElementById("impactThresholdTable");
  if (!body) return;
  body.replaceChildren();
  const currentStats = impactPerformance(rows, eventCutoff, 108);
  for (const threshold of IMPACT_TABLE_THRESHOLDS) {
    const stats = impactPerformance(rows, eventCutoff, threshold);
    const delta = impactThresholdDelta(rows, eventCutoff, threshold, 108);
    const tr = document.createElement("tr");
    if (threshold === 108) tr.classList.add("impact-current-row");
    if (threshold === candidate && threshold !== 108) tr.classList.add("impact-candidate-row");
    let daysVs108 = "0";
    let eventsVs108 = "0";
    if (delta.direction === "lower") {
      daysVs108 = `+${delta.days}`;
      eventsVs108 = `+${delta.events}`;
    } else if (delta.direction === "higher") {
      daysVs108 = `−${delta.days}`;
      eventsVs108 = `−${delta.events}`;
    }
    const cells = [
      threshold + "°F",
      String(stats.exposedN),
      impactPct(stats.eventProbability, 1),
      impactPct(stats.sensitivity, 0),
      impactPct(stats.specificity, 0),
      impactRR(stats),
      daysVs108,
      eventsVs108
    ];
    cells.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === 0 && threshold === 108) td.textContent += " · current";
      if (index === 0 && threshold === candidate && threshold !== 108) td.textContent += " · compare";
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  const note = document.getElementById("impactThresholdTableNote");
  if (note) {
    note.textContent = `Sensitivity = share of high-impact days captured at or above the HI threshold. Specificity = share of other days kept below it. RR compares high-impact-day risk above vs. below the threshold (95% CI in parentheses). Current 108°F captures ${impactPct(currentStats.sensitivity, 0)} of selected high-impact days in this evaluation period.`;
  }
}

function renderImpactSeasonTable(allRows, eventCutoff) {
  const body = document.getElementById("impactSeasonTable");
  if (!body) return;
  body.replaceChildren();
  const groups = [
    ["May–June", "early"],
    ["July–August", "peak"],
    ["September", "late"]
  ];
  for (const [label, key] of groups) {
    const rows = impactPeriodRows(allRows, key);
    const eventN = rows.filter((row) => row.yRate >= eventCutoff).length;
    const s106 = impactPerformance(rows, eventCutoff, 106);
    const s108 = impactPerformance(rows, eventCutoff, 108);
    const s113 = impactPerformance(rows, eventCutoff, 113);
    const tr = document.createElement("tr");
    [
      label,
      String(rows.length),
      rows.length ? impactPct(eventN / rows.length, 1) : "—",
      impactPct(s106.eventProbability, 1),
      impactPct(s108.eventProbability, 1),
      impactPct(s113.eventProbability, 1)
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function renderHealthImpactAnalysis() {
  const root = document.getElementById("healthImpactPanel");
  if (!root) return;
  if (typeof state === "undefined" || state.weatherStatus === "loading") {
    const scope = document.getElementById("impactScope");
    if (scope) scope.textContent = "Loading the local LDH + weather archive…";
    return;
  }
  if (state.weatherStatus !== "loaded") {
    const scope = document.getElementById("impactScope");
    if (scope) scope.textContent = "Regional weather data are unavailable, so health-impact threshold analysis cannot be calculated.";
    return;
  }

  const allRows = impactArchivePairs();
  const scope = document.getElementById("impactScope");
  if (!allRows.length) {
    if (scope) scope.textContent = "No complete warm-season LDH + peak-HI pairs are available for this area.";
    return;
  }

  const areaLabel = document.getElementById("areaSelect")?.selectedOptions?.[0]?.textContent || "Selected area";
  const benchmarkQ = Number(document.getElementById("impactBenchmark")?.value || "0.95");
  const percentileLabel = Math.round(benchmarkQ * 100) + "th-percentile";
  const period = document.getElementById("impactPeriod")?.value || "all";
  const candidate = Number(document.getElementById("impactCandidate")?.value || "106");
  const rates = allRows.map((row) => row.yRate).filter(Number.isFinite);
  const p50 = impactQuantile(rates, 0.50);
  const p90 = impactQuantile(rates, 0.90);
  const p95 = impactQuantile(rates, 0.95);
  const eventCutoff = impactQuantile(rates, benchmarkQ);
  const rows = impactPeriodRows(allRows, period);

  if (scope) {
    const years = [...new Set(allRows.map((row) => row.date.slice(0, 4)))].sort();
    scope.textContent = `${areaLabel} · ${allRows.length} complete May–September days across ${years[0]}–${years.at(-1)}. The ED-rate benchmark always uses the full May–September archive; the evaluation-period control only changes which days are tested against it.`;
  }

  document.getElementById("impactMedianRate").textContent = impactRate(p50);
  document.getElementById("impactP90Rate").textContent = impactRate(p90);
  document.getElementById("impactP95Rate").textContent = impactRate(p95);
  document.getElementById("impactPairedDays").textContent = String(allRows.length);

  const current = impactPerformance(rows, eventCutoff, 108);
  const compare = impactPerformance(rows, eventCutoff, candidate);
  document.getElementById("impact108Risk").textContent = impactPct(current.eventProbability, 1);
  document.getElementById("impact108Sensitivity").textContent = impactPct(current.sensitivity, 0);
  document.getElementById("impactCandidateRisk").textContent = impactPct(compare.eventProbability, 1);
  document.getElementById("impactCandidateLabel").textContent = `Chance at ≥${candidate}°F`;

  const summary = document.getElementById("impactComparisonSummary");
  const delta = impactThresholdDelta(rows, eventCutoff, candidate, 108);
  if (summary) {
    if (candidate < 108) {
      summary.textContent = `In this archive, lowering a hypothetical trigger from 108°F to ${candidate}°F would flag ${delta.days} additional days and capture ${delta.events} additional ≥${percentileLabel} ED-rate days. Sensitivity changes from ${impactPct(current.sensitivity, 0)} at 108°F to ${impactPct(compare.sensitivity, 0)} at ${candidate}°F; the high-impact-day probability among flagged days changes from ${impactPct(current.eventProbability, 1)} to ${impactPct(compare.eventProbability, 1)}.`;
    } else if (candidate > 108) {
      summary.textContent = `In this archive, raising a hypothetical trigger from 108°F to ${candidate}°F would remove ${delta.days} flagged days but miss ${delta.events} ≥${percentileLabel} ED-rate days that were captured at 108°F. Sensitivity changes from ${impactPct(current.sensitivity, 0)} to ${impactPct(compare.sensitivity, 0)}.`;
    } else {
      summary.textContent = `The comparison threshold is the current 108°F advisory criterion. It captures ${impactPct(current.sensitivity, 0)} of ≥${percentileLabel} ED-rate days in the selected evaluation period; ${impactPct(current.eventProbability, 1)} of days reaching ≥108°F are high-impact days by this definition.`;
    }
  }

  renderImpactProbabilityChart(rows, eventCutoff, percentileLabel);
  renderImpactThresholdTable(rows, eventCutoff, candidate);
  renderImpactSeasonTable(allRows, eventCutoff);
}

function initHealthImpactAnalysis() {
  const root = document.getElementById("healthImpactPanel");
  if (!root) return;
  if (!impactListenersAttached) {
    ["areaSelect", "impactBenchmark", "impactPeriod", "impactCandidate"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", renderHealthImpactAnalysis);
    });
    impactListenersAttached = true;
  }

  let attempts = 0;
  const waitForArchive = () => {
    attempts++;
    if (typeof state !== "undefined" && state.geography && state.analysis?.length && state.weatherStatus !== "loading") {
      renderHealthImpactAnalysis();
      return;
    }
    if (attempts < 240) setTimeout(waitForArchive, 250);
  };
  waitForArchive();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initHealthImpactAnalysis();
}

if (typeof module !== "undefined") module.exports = {
  impactFinite,
  impactQuantile,
  impactWarmSeason,
  impactPeriodRows,
  impactPerformance,
  impactRiskBins,
  impactThresholdDelta
};
