#!/usr/bin/env python3
"""Build regional daily outdoor WBGT using the Liljegren method.

Adapted from fill_wbgt_v3.py supplied for this project. Uses Open-Meteo ERA5-Land
(or ERA5 fallback), hourly temperature/dew point/RH/pressure/wind/radiation,
solar geometry at the radiation-hour midpoint, Erbs direct-radiation fallback,
and ECMWF thermofeel.calculate_wbgt_liljegren.

Output is regional mean of parish-point daily maximum WBGT. It is intentionally
separate from the airport-observation archive because defensible outdoor WBGT
needs wind and radiation inputs that ASOS temperature/RH alone cannot provide.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ.setdefault("THERMOFEEL_NO_NUMBA", "1")

import numpy as np
import pandas as pd
import requests
import thermofeel

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config/geography.json"
OUTPUT = ROOT / "data/wbgt_region_daily.csv"
META = ROOT / "data/wbgt_meta.json"
TIMEZONE = "America/Chicago"
TZINFO = ZoneInfo(TIMEZONE)
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
MODEL_CANDIDATES = ("era5_land", "era5")
START_DATE = date(2023, 1, 1)
ARCHIVE_LAG_DAYS = 5
FIELDS = ["date", "ldh_region", "regional_wbgt_max_f", "wbgt_points",
          "wbgt_expected_points", "source_model"]
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "LIX-Heat-ED-Analysis-WBGT/1.0"})


def cosine_solar_zenith(local_dt: datetime, latitude: float, longitude: float) -> float:
    n = local_dt.timetuple().tm_yday
    hour = local_dt.hour + local_dt.minute / 60.0 + local_dt.second / 3600.0
    gamma = 2.0 * math.pi / 365.0 * (n - 1 + (hour - 12.0) / 24.0)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2.0 * gamma) - 0.040849 * math.sin(2.0 * gamma)
    )
    decl = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2.0 * gamma) + 0.000907 * math.sin(2.0 * gamma)
        - 0.002697 * math.cos(3.0 * gamma) + 0.00148 * math.sin(3.0 * gamma)
    )
    utc_offset_hours = local_dt.utcoffset().total_seconds() / 3600.0
    time_offset = eqtime + 4.0 * longitude - 60.0 * utc_offset_hours
    true_solar_minutes = (hour * 60.0 + time_offset) % 1440.0
    hour_angle = math.radians(true_solar_minutes / 4.0 - 180.0)
    lat = math.radians(latitude)
    cosz = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)
    return float(np.clip(cosz, -1.0, 1.0))


def earth_sun_distance_factor(doy: np.ndarray) -> np.ndarray:
    doy = np.asarray(doy, dtype=float)
    b = 2.0 * np.pi * (doy - 1.0) / 365.0
    return (1.00011 + 0.034221 * np.cos(b) + 0.00128 * np.sin(b)
            + 0.000719 * np.cos(2.0 * b) + 7.7e-05 * np.sin(2.0 * b))


def approximate_direct_erbs(ghi, cossza, doy):
    ghi = np.asarray(ghi, dtype=float)
    cossza = np.asarray(cossza, dtype=float)
    doy = np.asarray(doy, dtype=float)
    e0 = earth_sun_distance_factor(doy)
    min_cos = 0.065
    toa_horizontal = 1361.0 * e0 * np.maximum(cossza, min_cos)
    daylight = (cossza > min_cos) & np.isfinite(ghi) & (ghi > 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        kt = np.where(daylight, ghi / toa_horizontal, 0.0)
    kt = np.clip(kt, 0.0, 1.0)
    kd = np.where(
        kt <= 0.22, 1.0 - 0.09 * kt,
        np.where(kt <= 0.80,
                 0.9511 - 0.1604 * kt + 4.388 * kt**2 - 16.638 * kt**3 + 12.336 * kt**4,
                 0.165),
    )
    direct_horizontal = np.where(daylight, ghi * (1.0 - kd), 0.0)
    return np.clip(direct_horizontal, 0.0, np.maximum(ghi, 0.0))


def rh_from_t_td(t_c, td_c):
    t_c = np.asarray(t_c, dtype=float)
    td_c = np.asarray(td_c, dtype=float)
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        a, b = 17.625, 243.04
        rh = 100.0 * np.exp((a * td_c) / (b + td_c) - (a * t_c) / (b + t_c))
    return np.clip(rh, 0.0, 100.0)


def surface_pressure_from_mslp(mslp_hpa, elev_m, t_c):
    mslp_hpa = np.asarray(mslp_hpa, dtype=float)
    t_k = np.asarray(t_c, dtype=float) + 273.15
    return mslp_hpa * np.exp(-9.80665 * float(elev_m) / (287.05 * t_k))


def request_json(params: dict, attempts: int = 4):
    last = None
    for n in range(1, attempts + 1):
        try:
            r = SESSION.get(OPEN_METEO_URL, params=params, timeout=180)
            r.raise_for_status()
            payload = r.json()
            if isinstance(payload, dict) and payload.get("error"):
                raise RuntimeError(payload.get("reason") or str(payload))
            return payload
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            last = exc
            if n < attempts:
                time.sleep(1.5 * n)
    raise RuntimeError(f"Open-Meteo request failed after {attempts} attempts: {last}")


def fetch_region(points, start_date: date, end_date: date, model: str):
    params = {
        "latitude": ",".join(str(p[1]) for p in points),
        "longitude": ",".join(str(p[2]) for p in points),
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "hourly": ",".join([
            "temperature_2m", "dew_point_2m", "relative_humidity_2m",
            "surface_pressure", "pressure_msl", "wind_speed_10m",
            "shortwave_radiation", "direct_radiation",
        ]),
        "temperature_unit": "celsius",
        "wind_speed_unit": "ms",
        "timezone": TIMEZONE,
        "models": model,
        "cell_selection": "land",
    }
    payload = request_json(params)
    locations = payload if isinstance(payload, list) else [payload]
    if len(locations) != len(points):
        raise RuntimeError(f"Open-Meteo returned {len(locations)} locations for {len(points)} points")

    point_daily = []
    for (label, lat, lon), loc in zip(points, locations):
        h = loc.get("hourly") or {}
        if not h.get("time"):
            raise RuntimeError(f"{label}: no hourly time series")
        n = len(h["time"])

        def arr(name):
            vals = h.get(name)
            if vals is None:
                return np.full(n, np.nan, dtype=float)
            return pd.to_numeric(pd.Series(vals), errors="coerce").to_numpy(float)

        local_dt = [datetime.fromisoformat(str(x)).replace(tzinfo=TZINFO) for x in h["time"]]
        dates = np.array([x.date() for x in local_dt], dtype=object)
        t_c, td_c = arr("temperature_2m"), arr("dew_point_2m")
        rh_api, p_sfc_api, p_msl = arr("relative_humidity_2m"), arr("surface_pressure"), arr("pressure_msl")
        wind, ghi, direct_api = arr("wind_speed_10m"), arr("shortwave_radiation"), arr("direct_radiation")

        rh_calc = rh_from_t_td(t_c, td_c)
        rh = np.clip(np.where(np.isfinite(rh_api), rh_api, rh_calc), 0.0, 100.0)
        elev_m = float(loc.get("elevation") or 0.0)
        p_calc = surface_pressure_from_mslp(p_msl, elev_m, t_c)
        pressure = np.where(np.isfinite(p_sfc_api), p_sfc_api, p_calc)
        ghi = np.where(np.isfinite(ghi), np.maximum(ghi, 0.0), np.nan)

        rad_mid_dt = [x - timedelta(minutes=30) for x in local_dt]
        cosz = np.array([cosine_solar_zenith(x, lat, lon) for x in rad_mid_dt], dtype=float)
        doy = np.array([x.timetuple().tm_yday for x in rad_mid_dt], dtype=float)
        direct_est = approximate_direct_erbs(ghi, cosz, doy)
        direct = np.where(np.isfinite(direct_api), np.maximum(direct_api, 0.0), direct_est)
        direct = np.where(np.isfinite(ghi), np.minimum(direct, ghi), np.nan)
        fdir = np.divide(direct, ghi, out=np.zeros_like(ghi),
                         where=np.isfinite(ghi) & (ghi > 1.0))
        fdir = np.clip(fdir, 0.0, 0.9)
        fdir = np.where(cosz >= 0.00873, fdir, 0.0)

        valid = (
            np.isfinite(t_c) & np.isfinite(rh) & np.isfinite(pressure)
            & np.isfinite(wind) & np.isfinite(ghi) & np.isfinite(fdir)
            & np.isfinite(cosz) & (ghi > 5.0) & (cosz > 0.00873)
        )
        if not valid.any():
            raise RuntimeError(f"{label}: no valid daylight WBGT input hours")

        wbgt_f = np.full(n, np.nan, dtype=float)
        with np.errstate(all="ignore"):
            wbgt_k = thermofeel.calculate_wbgt_liljegren(
                t_c[valid] + 273.15, rh[valid], pressure[valid], wind[valid],
                ghi[valid], fdir[valid], cosz[valid],
            )
        wbgt_f[valid] = (np.asarray(wbgt_k, dtype=float) - 273.15) * 9.0 / 5.0 + 32.0
        wbgt_f[(wbgt_f < 45.0) | (wbgt_f > 125.0)] = np.nan
        if not np.isfinite(wbgt_f).any():
            raise RuntimeError(f"{label}: Liljegren solver returned no finite WBGT")

        daily = pd.DataFrame({"date": dates, "wbgt_f": wbgt_f}).groupby(
            "date", as_index=False
        ).agg(wbgt_max_f=("wbgt_f", "max"))
        daily["point"] = label
        point_daily.append(daily)

    all_points = pd.concat(point_daily, ignore_index=True)
    regional = all_points.groupby("date", as_index=False).agg(
        regional_wbgt_max_f=("wbgt_max_f", "mean"),
        wbgt_points=("wbgt_max_f", "count"),
    )
    regional["source_model"] = model
    regional["wbgt_expected_points"] = len(points)
    return regional


def chunks(start: date, end: date, days: int = 365):
    cursor = start
    while cursor <= end:
        stop = min(end, cursor + timedelta(days=days - 1))
        yield cursor, stop
        cursor = stop + timedelta(days=1)


def load_config():
    cfg = json.loads(CONFIG.read_text())
    return {rid: [tuple(x) for x in region.get("wbgt_points", [])]
            for rid, region in cfg["regions"].items() if region.get("wbgt_points")}


def read_old():
    if not OUTPUT.exists():
        return []
    with OUTPUT.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Rebuild WBGT from 2023")
    args = parser.parse_args()
    regions = load_config()
    end = datetime.now(TZINFO).date() - timedelta(days=ARCHIVE_LAG_DAYS)
    if end < START_DATE:
        raise RuntimeError("WBGT archive end precedes configured start")

    old = read_old()
    start = START_DATE
    if old and not args.full:
        last = max(date.fromisoformat(r["date"]) for r in old if r.get("date"))
        start = max(START_DATE, last - timedelta(days=14))

    rows = [r for r in old if r["date"] < start.isoformat()]
    for rid, points in regions.items():
        print(f"Region {rid}: {len(points)} points, {start} through {end}", flush=True)
        frames = []
        for a, b in chunks(start, end):
            last_error = None
            for model in MODEL_CANDIDATES:
                try:
                    frame = fetch_region(points, a, b, model)
                    frames.append(frame)
                    print(f"  {a}..{b}: {model}, {len(frame)} days", flush=True)
                    last_error = None
                    break
                except Exception as exc:
                    last_error = exc
                    print(f"  {a}..{b}: {model} failed: {exc}", flush=True)
            if last_error is not None:
                raise RuntimeError(f"Region {rid} {a}..{b}: no usable model: {last_error}")
            time.sleep(0.8)
        if not frames:
            continue
        data = pd.concat(frames, ignore_index=True)
        for _, r in data.iterrows():
            if not np.isfinite(r["regional_wbgt_max_f"]):
                continue
            rows.append({
                "date": r["date"].isoformat() if hasattr(r["date"], "isoformat") else str(r["date"]),
                "ldh_region": rid,
                "regional_wbgt_max_f": f"{float(r['regional_wbgt_max_f']):.2f}",
                "wbgt_points": int(r["wbgt_points"]),
                "wbgt_expected_points": int(r["wbgt_expected_points"]),
                "source_model": str(r["source_model"]),
            })

    dedup = {(r["date"], r["ldh_region"]): r for r in rows}
    rows = [dedup[k] for k in sorted(dedup)]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=FIELDS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    temp = OUTPUT.with_suffix(".tmp")
    temp.write_text(buf.getvalue())
    temp.replace(OUTPUT)
    META.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": OPEN_METEO_URL,
        "method": "Liljegren outdoor WBGT via ECMWF thermofeel; regional value is mean of configured parish-point daily maxima.",
        "models": list(MODEL_CANDIDATES),
        "timezone": TIMEZONE,
        "archive_lag_days": ARCHIVE_LAG_DAYS,
        "period_start": rows[0]["date"] if rows else None,
        "period_end": rows[-1]["date"] if rows else None,
        "rows": len(rows),
        "regions": sorted(regions),
    }, indent=2) + "\n")
    print(f"Saved {len(rows)} regional WBGT days", flush=True)


if __name__ == "__main__":
    if not hasattr(thermofeel, "calculate_wbgt_liljegren"):
        raise SystemExit("thermofeel must provide calculate_wbgt_liljegren")
    main()
