#!/usr/bin/env python3
"""Build adjusted heat-health model summaries for the dashboard.

Models are fitted at region-day resolution so combined-CWA analysis does not
average four regions equally. The response is ED count with a log-population
offset. Each candidate exposure is modeled nonlinearly with a cubic B-spline
and adjusted for year, month, day-of-week, and region (for combined models).
A discrete negative-binomial model is preferred; Poisson GLM is a fallback.
"""
from __future__ import annotations

import csv
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

ROOT = Path(__file__).resolve().parents[1]
ANALYSIS = ROOT / "data/analysis_region_daily.csv"
WEATHER = ROOT / "data/weather_region_daily.csv"
WBGT = ROOT / "data/wbgt_region_daily.csv"
OUTPUT = ROOT / "data/advanced_analysis.json"

METRICS = [
    ("high_f", "High temperature", "°F"),
    ("low_f", "Low temperature", "°F"),
    ("average_f", "Average temperature", "°F"),
    ("peak_heat_index_f", "Peak heat index", "°F"),
    ("regional_wbgt_max_f", "Outdoor WBGT", "°F"),
    ("morning_low_f", "Overnight / morning low", "°F"),
    ("hi_hours_105", "Hours with HI ≥105°F", "hours"),
    ("hi_hours_108", "Hours with HI ≥108°F", "hours"),
    ("hi_2day_mean_f", "2-day mean peak HI", "°F"),
    ("hi_3day_mean_f", "3-day mean peak HI", "°F"),
    ("consecutive_hi108_days", "Consecutive HI ≥108°F days", "days"),
]


def read_csv(path):
    if not path.exists():
        return pd.DataFrame()
    return pd.read_csv(path)


def merge_data():
    a = read_csv(ANALYSIS)
    w = read_csv(WEATHER)
    if a.empty or w.empty:
        return pd.DataFrame()
    keys = ["date", "ldh_region"]
    df = a.merge(w, on=keys, how="left", suffixes=("", "_wx"))
    b = read_csv(WBGT)
    if not b.empty:
        df = df.merge(b[["date", "ldh_region", "regional_wbgt_max_f"]], on=keys, how="left")
    else:
        df["regional_wbgt_max_f"] = np.nan
    df["date"] = pd.to_datetime(df["date"])
    df["year"] = df["date"].dt.year.astype(str)
    df["month"] = df["date"].dt.month.astype(str)
    df["dow"] = df["date"].dt.dayofweek.astype(str)
    df["ldh_region"] = df["ldh_region"].astype(str)
    df["health_population_2020"] = pd.to_numeric(df["health_population_2020"], errors="coerce")
    df["ed_visits"] = pd.to_numeric(df["ed_visits"], errors="coerce")
    df["ed_visits_per_100k"] = pd.to_numeric(df["ed_visits_per_100k"], errors="coerce")
    for key, _, _ in METRICS:
        df[key] = pd.to_numeric(df.get(key), errors="coerce")
    return df


def fit_one(data, metric, include_region):
    cols = ["ed_visits", "health_population_2020", metric, "year", "month", "dow"]
    if include_region:
        cols.append("ldh_region")
    d = data[cols].replace([np.inf, -np.inf], np.nan).dropna().copy()
    if len(d) < 80 or d[metric].nunique() < 8:
        return {"n": int(len(d)), "status": "insufficient_data"}

    # Avoid spline knots becoming unstable from tiny extreme tails.
    qlo, qhi = d[metric].quantile([0.01, 0.99])
    d = d[(d[metric] >= qlo) & (d[metric] <= qhi)].copy()
    if len(d) < 80:
        return {"n": int(len(d)), "status": "insufficient_data"}

    terms = [f"bs({metric}, df=4, degree=3)", "C(year)", "C(month)", "C(dow)"]
    if include_region:
        terms.append("C(ldh_region)")
    formula = "ed_visits ~ " + " + ".join(terms)
    offset = np.log(d["health_population_2020"].clip(lower=1))

    kind = "negative_binomial"
    try:
        model = smf.negativebinomial(formula, data=d, offset=offset).fit(disp=0, maxiter=200)
    except Exception:
        kind = "poisson_fallback"
        model = smf.glm(
            formula, data=d, family=sm.families.Poisson(), offset=offset
        ).fit()

    p50, p90 = [float(x) for x in d[metric].quantile([0.50, 0.90])]
    prototype = d.iloc[[len(d)//2]].copy()
    low = prototype.copy()
    high = prototype.copy()
    low[metric] = p50
    high[metric] = p90
    pop = float(prototype["health_population_2020"].iloc[0])
    pred_low = float(np.asarray(model.predict(low, offset=np.log([pop])))[0])
    pred_high = float(np.asarray(model.predict(high, offset=np.log([pop])))[0])
    rr = pred_high / pred_low if pred_low > 0 else None

    return {
        "status": "ok",
        "model": kind,
        "n": int(len(d)),
        "aic": float(model.aic) if math.isfinite(float(model.aic)) else None,
        "p50": p50,
        "p90": p90,
        "rate_ratio_p90_vs_p50": float(rr) if rr is not None and math.isfinite(rr) else None,
    }


def model_group(df, regions, summer_only=False):
    d = df[df["ldh_region"].isin(regions)].copy()
    if summer_only:
        d = d[d["date"].dt.month.isin([6, 7, 8])]
    include_region = len(regions) > 1
    results = {}
    for key, label, unit in METRICS:
        result = fit_one(d, key, include_region)
        result["label"] = label
        result["unit"] = unit
        results[key] = result
    valid = [(k, v["aic"]) for k, v in results.items()
             if v.get("status") == "ok" and v.get("aic") is not None]
    if valid:
        best = min(a for _, a in valid)
        for k, aic in valid:
            results[k]["delta_aic"] = float(aic - best)
    return results


def main():
    df = merge_data()
    if df.empty:
        OUTPUT.write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(),
                                      "status": "no_data", "groups": {}}, indent=2) + "\n")
        return

    groups = {
        "all": ["1", "2", "3", "9"],
        "1": ["1"], "2": ["2"], "3": ["3"], "9": ["9"],
    }
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "ok",
        "method": (
            "Region-day count models with log(population) offset; cubic B-spline exposure; "
            "adjusted for year, month, day-of-week, and region for combined models. "
            "Discrete negative binomial preferred; Poisson fallback if fitting fails."
        ),
        "groups": {},
    }
    for name, regions in groups.items():
        payload["groups"][name] = {
            "all_months": model_group(df, regions, False),
            "jja": model_group(df, regions, True),
        }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote adjusted analysis for {len(groups)} groups")


if __name__ == "__main__":
    main()
