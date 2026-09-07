#!/usr/bin/env python3
"""Cache station observations and build resilient regional heat-exposure metrics."""
import argparse
import csv
import io
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/weather_daily.csv"
REGION_OUTPUT = ROOT / "data/weather_region_daily.csv"
META = ROOT / "data/weather_meta.json"
LOCAL = ZoneInfo("America/Chicago")
FIELDS = [
    "date", "station", "high_f", "low_f", "average_f", "peak_heat_index_f",
    "morning_low_f", "hi_hours_105", "hi_hours_108",
    "temperature_hours", "heat_index_hours", "expected_hours",
]
REGION_FIELDS = [
    "date", "ldh_region", "high_f", "low_f", "average_f", "peak_heat_index_f",
    "morning_low_f", "hi_hours_105", "hi_hours_108",
    "hi_2day_mean_f", "hi_3day_mean_f", "consecutive_hi108_days",
    "temperature_hours", "heat_index_hours", "expected_hours",
    "weather_sources", "fallback_used", "source_count", "population_2020",
]
SOURCE = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
MIN_REGION_COVERAGE = 0.75
ARCHIVE_SCHEMA_VERSION = 2
CORE_FIELDS = ("high_f", "low_f", "average_f", "peak_heat_index_f")


def heat_index(t, rh):
    """NWS Steadman screening + Rothfusz regression and humidity adjustments, °F."""
    simple = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094)
    hi = (simple + t) / 2
    if hi < 80:
        return hi
    hi = (-42.379 + 2.04901523*t + 10.14333127*rh - 0.22475541*t*rh
          - 0.00683783*t*t - 0.05481717*rh*rh + 0.00122874*t*t*rh
          + 0.00085282*t*rh*rh - 0.00000199*t*t*rh*rh)
    if rh < 13 and 80 <= t <= 112:
        hi -= (13-rh)/4 * math.sqrt((17-abs(t-95))/17)
    elif rh > 85 and 80 <= t <= 87:
        hi += (rh-85)/10 * (87-t)/5
    return hi


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def mean(values):
    vals = [v for v in values if v is not None and math.isfinite(v)]
    return sum(vals) / len(vals) if vals else None


def fmt(value, digits=1):
    return "" if value is None or not math.isfinite(value) else f"{value:.{digits}f}"


def daily_rows(text, start, end, stations):
    reader = csv.DictReader(line for line in text.splitlines() if not line.startswith("#"))
    if not {"station", "valid", "tmpf", "relh"}.issubset(reader.fieldnames or []):
        raise ValueError("Unexpected IEM CSV headers; retaining previous data")
    hours = {}
    for row in reader:
        station = "K" + row["station"].removeprefix("K")
        if station not in stations:
            continue
        stamp = datetime.fromisoformat(row["valid"]).replace(tzinfo=timezone.utc)
        local_stamp = stamp.astimezone(LOCAL)
        day = local_stamp.date()
        t, rh = number(row["tmpf"]), number(row["relh"])
        if not start <= day < end or t is None or not -100 <= t <= 140:
            continue
        # Keep latest valid temperature report in each UTC hour so reporting cadence
        # does not bias daily means. RH stays paired to that same observation.
        key = (station, stamp.replace(minute=0, second=0, microsecond=0))
        if key not in hours or stamp > hours[key][0]:
            hours[key] = (
                stamp, local_stamp, day, t,
                rh if rh is not None and 0 <= rh <= 100 else None,
            )

    grouped = defaultdict(list)
    for (station, _), obs in hours.items():
        grouped[(obs[2], station)].append(obs)

    result = []
    day = start
    while day < end:
        midnight = datetime.combine(day, datetime.min.time(), LOCAL).astimezone(timezone.utc)
        tomorrow = datetime.combine(day + timedelta(days=1), datetime.min.time(), LOCAL).astimezone(timezone.utc)
        for station in stations:
            obs = grouped[(day, station)]
            temps = [o[3] for o in obs]
            his = [heat_index(o[3], o[4]) for o in obs if o[4] is not None]
            morning = [o[3] for o in obs if o[1].hour < 12]
            result.append(dict(zip(FIELDS, [
                day.isoformat(), station,
                round(max(temps), 1) if temps else "",
                round(min(temps), 1) if temps else "",
                round(sum(temps)/len(temps), 1) if temps else "",
                round(max(his), 1) if his else "",
                round(min(morning), 1) if morning else "",
                sum(1 for x in his if x >= 105),
                sum(1 for x in his if x >= 108),
                len(temps), len(his),
                int((tomorrow-midnight).total_seconds()/3600),
            ])))
        day += timedelta(days=1)
    return result


def download(start, end, stations):
    params = {
        "station": [s.removeprefix("K") for s in stations],
        "data": ["tmpf", "relh"],
        "sts": datetime.combine(start, datetime.min.time(), LOCAL).astimezone(timezone.utc).isoformat(),
        "ets": datetime.combine(end, datetime.min.time(), LOCAL).astimezone(timezone.utc).isoformat(),
        "tz": "UTC", "format": "onlycomma", "latlon": "no", "elev": "no",
        "missing": "M", "report_type": "3",
    }
    request = urllib.request.Request(
        SOURCE + "?" + urllib.parse.urlencode(params, doseq=True),
        headers={"User-Agent": "LIX-Heat-ED-Analysis/4.0 (github.com/mefferso/LIX-Heat-ED-Analysis)"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                text = response.read().decode("utf-8")
            rows = daily_rows(text, start, end, stations)
            if not any(r["temperature_hours"] for r in rows):
                raise ValueError("No temperatures received from any configured station")
            return rows
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))


def station_coverage(row):
    expected = number(row.get("expected_hours"))
    th = number(row.get("temperature_hours"))
    hh = number(row.get("heat_index_hours"))
    if not expected or th is None or hh is None:
        return 0.0
    return min(th/expected, hh/expected)


def row_complete(row, coverage=MIN_REGION_COVERAGE):
    # Ancillary fields must not invalidate observed core weather. In particular,
    # pre-upgrade rows have no morning low or duration metrics.
    return (
        station_coverage(row) >= coverage
        and all(number(row.get(k)) is not None for k in CORE_FIELDS)
    )


def needs_archive_rebuild(old, metadata, stations):
    """Migrate historical calculations and new stations, not just the last week."""
    if not old:
        return True
    if metadata.get("schema_version") != ARCHIVE_SCHEMA_VERSION:
        return True
    if set(metadata.get("stations", [])) != set(stations):
        return True
    # Detect partially migrated archives even if newer headers were written over
    # old rows. Duration zero is valid; blank on an observed day is not.
    return any(
        not set(FIELDS).issubset(row)
        or (number(row.get("heat_index_hours")) not in (None, 0)
            and any(number(row.get(k)) is None for k in ("hi_hours_105", "hi_hours_108")))
        for row in old
    )


def validate_archive(rows, region_rows, old, cfg):
    """Reject empty/partial provider responses before replacing published data."""
    if not rows or not any(row_complete(r) for r in rows):
        raise ValueError("No usable weather received; retaining previous archive")
    for candidate, previous, area_key, fields in (
        (rows, old, "station", CORE_FIELDS),
        (region_rows, build_region_rows(old, cfg), "ldh_region", CORE_FIELDS),
    ):
        def counts(source):
            out = defaultdict(int)
            for row in source:
                if all(number(row.get(k)) is not None for k in fields):
                    out[(row["date"][:4], row[area_key])] += 1
            return out
        before, after = counts(previous), counts(candidate)
        for key, n in before.items():
            if n - after[key] > max(3, n * 0.05):
                raise ValueError(
                    f"Weather coverage regression for {key}: {n} -> {after[key]} days; "
                    "retaining previous archive"
                )


def population_by_region(cfg):
    out = defaultdict(int)
    for p in cfg["parishes"]:
        out[p["region"]] += int(p.get("population_2020") or 0)
    return dict(out)


def build_region_rows(station_rows, cfg):
    by_key = {(r["date"], r["station"]): r for r in station_rows}
    pops = population_by_region(cfg)
    dates = sorted({r["date"] for r in station_rows})
    rows = []

    for d in dates:
        for rid, region in cfg["regions"].items():
            primary = list(region.get("weather_stations", []))
            fallback = list(region.get("weather_fallback_stations", []))
            primary_good = [by_key.get((d, s)) for s in primary]
            primary_good = [r for r in primary_good if r and row_complete(r)]
            used = primary_good

            # Preserve the intended multi-station Southeast mean when possible.
            # If no primary station meets QC, use the first qualified fallback.
            if not used:
                used = []
                for s in fallback:
                    r = by_key.get((d, s))
                    if r and row_complete(r):
                        used = [r]
                        break

            if not used:
                rows.append({k: "" for k in REGION_FIELDS} | {
                    "date": d, "ldh_region": rid, "population_2020": pops.get(rid, 0),
                    "weather_sources": "", "fallback_used": "", "source_count": 0,
                })
                continue

            def av(key):
                return mean([number(r.get(key)) for r in used])

            sources = [r["station"] for r in used]
            expected = mean([number(r.get("expected_hours")) for r in used])
            row = {
                "date": d, "ldh_region": rid,
                "high_f": fmt(av("high_f")),
                "low_f": fmt(av("low_f")),
                "average_f": fmt(av("average_f")),
                "peak_heat_index_f": fmt(av("peak_heat_index_f")),
                "morning_low_f": fmt(av("morning_low_f")),
                "hi_hours_105": fmt(av("hi_hours_105"), 2),
                "hi_hours_108": fmt(av("hi_hours_108"), 2),
                "hi_2day_mean_f": "", "hi_3day_mean_f": "",
                "consecutive_hi108_days": "",
                "temperature_hours": fmt(av("temperature_hours"), 2),
                "heat_index_hours": fmt(av("heat_index_hours"), 2),
                "expected_hours": fmt(expected, 2),
                "weather_sources": "/".join(sources),
                "fallback_used": 1 if any(s not in primary for s in sources) else 0,
                "source_count": len(sources),
                "population_2020": pops.get(rid, 0),
            }
            rows.append(row)

    # Persistence features are calculated within each region on actual consecutive dates.
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["ldh_region"]].append(row)
    for region_rows in grouped.values():
        region_rows.sort(key=lambda r: r["date"])
        streak = 0
        for i, row in enumerate(region_rows):
            hi = number(row["peak_heat_index_f"])
            previous_date = date.fromisoformat(region_rows[i-1]["date"]) if i else None
            current_date = date.fromisoformat(row["date"])
            consecutive = i and (current_date - previous_date).days == 1
            streak = streak + 1 if hi is not None and hi >= 108 and consecutive else (1 if hi is not None and hi >= 108 else 0)
            row["consecutive_hi108_days"] = streak if hi is not None else ""

            for window, key in ((2, "hi_2day_mean_f"), (3, "hi_3day_mean_f")):
                if i + 1 < window:
                    continue
                subset = region_rows[i-window+1:i+1]
                ds = [date.fromisoformat(x["date"]) for x in subset]
                vals = [number(x["peak_heat_index_f"]) for x in subset]
                if all(v is not None for v in vals) and all((ds[j]-ds[j-1]).days == 1 for j in range(1, len(ds))):
                    row[key] = fmt(sum(vals)/len(vals))

    return sorted(rows, key=lambda r: (r["date"], r["ldh_region"]))


def write_csv(path, rows, fields):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(buf.getvalue())
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Rebuild from 2023")
    args = parser.parse_args()
    cfg = json.loads((ROOT / "config/geography.json").read_text())
    all_stations = sorted({
        s for r in cfg["regions"].values()
        for s in list(r.get("weather_stations", [])) + list(r.get("weather_fallback_stations", []))
    })
    end = datetime.now(LOCAL).date()  # completed local days only
    start = date(2023, 1, 1)
    old = []
    if OUTPUT.exists():
        old = list(csv.DictReader(OUTPUT.open()))
    metadata = json.loads(META.read_text()) if META.exists() else {}
    rebuild = args.full or needs_archive_rebuild(old, metadata, all_stations)
    if old and not rebuild:
        start = max(start, date.fromisoformat(max(r["date"] for r in old)) - timedelta(days=7))
    elif old:
        print("Backfilling the full weather archive for schema/station changes", flush=True)

    rows = [r for r in old if r["date"] < start.isoformat()]
    cursor = start
    while cursor < end:
        stop = min(date(cursor.year + 1, 1, 1), end)
        print(f"Fetching {cursor} through {stop} (exclusive): {', '.join(all_stations)}", flush=True)
        fresh = download(cursor, stop, all_stations)
        rows.extend(fresh)
        counts = {s: sum(number(r["temperature_hours"]) or 0 for r in fresh if r["station"] == s)
                  for s in all_stations}
        print("  valid temperature-hours: " + ", ".join(f"{s}={int(counts[s])}" for s in all_stations), flush=True)
        cursor = stop
        time.sleep(1.1)

    rows.sort(key=lambda r: (r["date"], r["station"]))
    region_rows = build_region_rows(rows, cfg)
    validate_archive(rows, region_rows, old, cfg)
    write_csv(OUTPUT, rows, FIELDS)
    write_csv(REGION_OUTPUT, region_rows, REGION_FIELDS)

    fallback_days = {
        rid: sum(1 for r in region_rows if r["ldh_region"] == rid and str(r["fallback_used"]) == "1")
        for rid in cfg["regions"]
    }
    META.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": ARCHIVE_SCHEMA_VERSION,
        "source": SOURCE,
        "timezone": "America/Chicago",
        "stations": all_stations,
        "period_start": rows[0]["date"],
        "period_end": rows[-1]["date"],
        "rows": len(rows),
        "regional_rows": len(region_rows),
        "regional_min_coverage": MIN_REGION_COVERAGE,
        "fallback_days": fallback_days,
        "method": (
            "Latest routine observation per UTC hour; local-day extrema and arithmetic hourly mean. "
            "NWS heat index computed per hour. Regional analysis uses configured primary stations meeting "
            "75% daily temperature/heat-index coverage, then explicit fallbacks. Morning low is 00-11 local. "
            "Persistence fields use consecutive regional days."
        ),
    }, indent=2) + "\n")
    print(f"Saved {len(rows)} station-days and {len(region_rows)} region-days", flush=True)


if __name__ == "__main__":
    main()
