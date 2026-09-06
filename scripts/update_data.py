#!/usr/bin/env python3
"""Build daily LIX heat-headline and LDH region-level ED-visit analysis datasets."""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "geography.json"
LDH_REGION_INPUT = ROOT / "data" / "ldh_heat_region_daily.csv"
LDH_META_INPUT = ROOT / "data" / "ldh_meta.json"
HAZARD_OUTPUT = ROOT / "data" / "heat_hazards_daily.csv"
ANALYSIS_OUTPUT = ROOT / "data" / "analysis_region_daily.csv"
SUMMARY_OUTPUT = ROOT / "data" / "summary.json"

LOCAL_TZ = ZoneInfo("America/Chicago")
START_DATE = date(2023, 4, 1)
IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py"
USER_AGENT = "LIX-Heat-ED-Analysis/2.0 (https://github.com/mefferso/LIX-Heat-ED-Analysis)"

ZONE_FALLBACK = {
    "LAZ034": "Pointe Coupee",
    "LAZ035": "West Feliciana",
    "LAZ036": "East Feliciana",
    "LAZ037": "St. Helena",
    "LAZ039": "Washington",
    "LAZ046": "Iberville",
    "LAZ047": "West Baton Rouge",
    "LAZ048": "East Baton Rouge",
    "LAZ056": "Assumption",
    "LAZ057": "St. James",
    "LAZ058": "St. John the Baptist",
    "LAZ059": "Lafourche",
    "LAZ060": "St. Charles",
    "LAZ064": "St. Bernard",
    "LAZ065": "Terrebonne",
    "LAZ066": "Terrebonne",
    "LAZ067": "Lafourche",
    "LAZ068": "Jefferson",
    "LAZ069": "Plaquemines",
    "LAZ070": "St. Bernard",
    "LAZ071": "Tangipahoa",
    "LAZ076": "St. Tammany",
    "LAZ077": "Orleans",
    "LAZ078": "Orleans",
    "LAZ079": "St. Tammany",
    "LAZ080": "St. Tammany",
    "LAZ081": "Tangipahoa",
    "LAZ082": "Tangipahoa",
    "LAZ083": "Livingston",
    "LAZ084": "Livingston",
    "LAZ085": "Ascension",
    "LAZ086": "Ascension",
    "LAZ087": "Jefferson",
    "LAZ088": "Jefferson",
    "LAZ089": "Plaquemines",
    "LAZ090": "Plaquemines",
    # March 2026 LIX public-zone reconfiguration
    "LAZ091": "Plaquemines",
    "LAZ092": "Jefferson",
    "LAZ093": "Jefferson",
    "LAZ094": "Lafourche",
    "LAZ095": "Lafourche",
    "LAZ096": "Terrebonne",
    "LAZ097": "Terrebonne",
    "LAZ098": "St. Charles",
    "LAZ099": "St. Charles",
    "LAZ100": "St. Charles",
}


def load_geography():
    with CONFIG_PATH.open(encoding="utf-8") as f:
        cfg = json.load(f)
    parishes = {p["name"]: p for p in cfg["parishes"]}
    by_region = defaultdict(list)
    for p in cfg["parishes"]:
        by_region[p["region"]].append(p["name"])
    return cfg, parishes, dict(by_region)


CFG, PARISH_META, PARISHES_BY_REGION = load_geography()
PARISHES = list(PARISH_META)


def request_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8-sig")


def parse_vtec_time(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if re.fullmatch(r"\d{12}", value):
        return datetime.strptime(value, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    if re.fullmatch(r"\d{14}", value):
        return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def resolve_parish_from_zone(ugc: str, cache: dict[str, str]) -> str:
    ugc = ugc.strip().upper()
    if ugc in cache:
        return cache[ugc]
    if ugc in ZONE_FALLBACK:
        cache[ugc] = ZONE_FALLBACK[ugc]
        return cache[ugc]

    api = f"https://api.weather.gov/zones/forecast/{urllib.parse.quote(ugc)}"
    try:
        raw = json.loads(request_text(api))
        name = raw.get("properties", {}).get("name", "")
    except Exception as exc:
        raise RuntimeError(f"Unknown LIX Louisiana zone {ugc}; NWS API lookup failed: {exc}") from exc

    def key(v):
        return re.sub(r"[^a-z0-9]+", "", v.lower().replace("parish", ""))

    matches = [p for p in PARISHES if key(p) in key(name) or key(name) in key(p)]
    if len(matches) == 1:
        cache[ugc] = matches[0]
        return matches[0]

    raise RuntimeError(f"Could not map LIX Louisiana zone {ugc!r} ({name!r}) to a configured parish.")


def fetch_iem_rows() -> list[dict[str, str]]:
    end = datetime.now(timezone.utc) + timedelta(days=1)
    params = {
        "accept": "csv",
        "sts": START_DATE.isoformat() + "T00:00Z",
        "ets": end.strftime("%Y-%m-%dT00:00Z"),
        "wfo": "LIX",
        "limitps": "1",
        "phenomena": "HT,EH,HY,XH",
        "significance": "Y,W,Y,W",
    }
    url = IEM_URL + "?" + urllib.parse.urlencode(params, safe=",")
    return list(csv.DictReader(io.StringIO(request_text(url))))


def row_value(row: dict[str, str], *names: str) -> str:
    upper = {k.upper(): v for k, v in row.items() if k}
    for name in names:
        if name.upper() in upper:
            return (upper[name.upper()] or "").strip()
    return ""


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def build_hazard_grid(iem_rows: list[dict[str, str]]):
    today = datetime.now(LOCAL_TZ).date()
    hazard = {}
    for d in daterange(START_DATE, today):
        for parish in PARISHES:
            hazard[(d.isoformat(), parish)] = {
                "heat_advisory": 0,
                "excessive_heat_warning": 0,
                "hazard_hours": 0.0,
            }

    zone_cache = {}
    used_events = 0

    for row in iem_rows:
        ugc = row_value(row, "NWS_UGC", "UGC")
        if not ugc.startswith("LAZ"):
            continue

        phenom = row_value(row, "PHENOM", "PHENOMENA", "TYPE").upper()
        sig = row_value(row, "SIG", "SIGNIFICANCE").upper()
        is_advisory = phenom in {"HT", "HY"} and sig == "Y"
        is_warning = phenom in {"EH", "XH"} and sig == "W"
        if not (is_advisory or is_warning):
            continue

        start = parse_vtec_time(row_value(row, "ISSUED", "UTC_ISSUE"))
        end = parse_vtec_time(row_value(row, "EXPIRED", "UTC_EXPIRE"))
        if not start or not end or end <= start:
            continue

        parish = resolve_parish_from_zone(ugc, zone_cache)
        local_start = start.astimezone(LOCAL_TZ)
        local_end = end.astimezone(LOCAL_TZ)

        cursor_date = local_start.date()
        while cursor_date <= local_end.date():
            day_start = datetime.combine(cursor_date, time.min, tzinfo=LOCAL_TZ)
            next_day = day_start + timedelta(days=1)
            overlap_start = max(local_start, day_start)
            overlap_end = min(local_end, next_day)
            hours = max(0.0, (overlap_end - overlap_start).total_seconds() / 3600.0)
            if hours > 0:
                key = (cursor_date.isoformat(), parish)
                if key not in hazard:
                    hazard[key] = {"heat_advisory": 0, "excessive_heat_warning": 0, "hazard_hours": 0.0}
                if is_advisory:
                    hazard[key]["heat_advisory"] = 1
                if is_warning:
                    hazard[key]["excessive_heat_warning"] = 1
                # One parish may contain multiple forecast sub-zones. Do not double-count clock hours.
                hazard[key]["hazard_hours"] = max(hazard[key]["hazard_hours"], hours)
            cursor_date += timedelta(days=1)
        used_events += 1

    rows = []
    for (d, parish), values in sorted(hazard.items()):
        headline = (
            "warning" if values["excessive_heat_warning"]
            else "advisory" if values["heat_advisory"]
            else "none"
        )
        rows.append({
            "date": d,
            "parish": parish,
            "ldh_region": PARISH_META[parish]["region"],
            "heat_advisory": values["heat_advisory"],
            "excessive_heat_warning": values["excessive_heat_warning"],
            "headline": headline,
            "hazard_hours": f'{values["hazard_hours"]:.2f}',
        })
    return rows, used_events, zone_cache


def load_ldh_region_rows():
    if not LDH_REGION_INPUT.exists():
        return []

    out = []
    with LDH_REGION_INPUT.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        required = {"date", "season", "ldh_region", "region_name", "ed_visits"}
        if not required.issubset(set(reader.fieldnames or [])):
            raise RuntimeError(f"LDH region CSV is missing columns. Found: {reader.fieldnames}")
        for row in reader:
            region = row["ldh_region"].strip()
            if region not in CFG["regions"]:
                continue
            try:
                parsed = date.fromisoformat(row["date"].strip())
                visits = int(float(row["ed_visits"]))
                season = int(row["season"])
            except (ValueError, TypeError):
                continue
            if parsed.year != season or season not in {2023, 2024, 2025, 2026}:
                continue
            out.append({
                "date": parsed.isoformat(),
                "season": season,
                "ldh_region": region,
                "region_name": row["region_name"].strip(),
                "ed_visits": visits,
                "source_updated": row.get("source_updated", "").strip(),
            })
    return out


def build_region_analysis(hazard_rows, ldh_rows):
    hazard_lookup = {(r["date"], r["parish"]): r for r in hazard_rows}
    rows = []

    for ldh in ldh_rows:
        region = ldh["ldh_region"]
        parishes = PARISHES_BY_REGION.get(region, [])
        if not parishes:
            continue

        advisory = 0
        warning = 0
        hours_total = 0.0

        for parish in parishes:
            h = hazard_lookup.get((ldh["date"], parish))
            if not h:
                continue
            if h["headline"] == "warning":
                warning += 1
            elif h["headline"] == "advisory":
                advisory += 1
            hours_total += float(h["hazard_hours"])

        n = len(parishes)
        headline = "warning" if warning else "advisory" if advisory else "none"
        rows.append({
            "date": ldh["date"],
            "season": ldh["season"],
            "ldh_region": region,
            "region_name": ldh["region_name"],
            "ed_visits": ldh["ed_visits"],
            "lix_parish_count": n,
            "advisory_parishes": advisory,
            "warning_parishes": warning,
            "advisory_pct": f"{advisory / n * 100:.2f}",
            "warning_pct": f"{warning / n * 100:.2f}",
            "severity_score": f"{(advisory + 2 * warning) / n:.4f}",
            "headline": headline,
            "mean_hazard_hours": f"{hours_total / n:.2f}",
        })

    return sorted(rows, key=lambda r: (r["date"], r["ldh_region"]))


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    iem_rows = fetch_iem_rows()
    hazard_rows, used_events, zone_cache = build_hazard_grid(iem_rows)
    write_csv(
        HAZARD_OUTPUT,
        hazard_rows,
        ["date", "parish", "ldh_region", "heat_advisory", "excessive_heat_warning", "headline", "hazard_hours"],
    )

    ldh_rows = load_ldh_region_rows()
    analysis_rows = build_region_analysis(hazard_rows, ldh_rows)
    write_csv(
        ANALYSIS_OUTPUT,
        analysis_rows,
        [
            "date", "season", "ldh_region", "region_name", "ed_visits", "lix_parish_count",
            "advisory_parishes", "warning_parishes", "advisory_pct", "warning_pct",
            "severity_score", "headline", "mean_hazard_hours",
        ],
    )

    advisory_parish_days = sum(1 for r in hazard_rows if r["headline"] == "advisory")
    warning_parish_days = sum(1 for r in hazard_rows if r["headline"] == "warning")
    headline_dates = {r["date"] for r in hazard_rows if r["headline"] != "none"}

    ldh_meta = {}
    if LDH_META_INPUT.exists():
        try:
            ldh_meta = json.loads(LDH_META_INPUT.read_text(encoding="utf-8"))
        except Exception:
            ldh_meta = {}

    ldh_dates = sorted({r["date"] for r in ldh_rows})
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "iem_status": "ok",
        "iem_rows_received": len(iem_rows),
        "heat_event_zone_rows_used": used_events,
        "mapped_zone_count": len(zone_cache),
        "hazard_rows": len(hazard_rows),
        "advisory_parish_days": advisory_parish_days,
        "warning_parish_days": warning_parish_days,
        "unique_lix_la_headline_days": len(headline_dates),
        "hazard_period_start": START_DATE.isoformat(),
        "hazard_period_end": datetime.now(LOCAL_TZ).date().isoformat(),
        "ldh_status": "loaded" if ldh_rows else "no_data",
        "ldh_rows": len(ldh_rows),
        "ldh_years": sorted({r["season"] for r in ldh_rows}),
        "ldh_regions": sorted({r["ldh_region"] for r in ldh_rows}),
        "ldh_period_start": ldh_dates[0] if ldh_dates else None,
        "ldh_period_end": ldh_dates[-1] if ldh_dates else None,
        "ldh_source_updated": ldh_meta.get("source_updated"),
        "ldh_fetched_at": ldh_meta.get("fetched_at"),
        "analysis_region_rows": len(analysis_rows),
        "south_central_note": "LDH Region 3 includes St. Mary Parish, which is outside the LIX CWA.",
    }
    SUMMARY_OUTPUT.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
