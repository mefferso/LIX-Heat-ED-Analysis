#!/usr/bin/env python3
"""Build daily LIX Louisiana heat-headline and LDH ED-visit datasets."""

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
LDH_INPUT = ROOT / "data" / "input" / "ldh_heat_raw.csv"
HAZARD_OUTPUT = ROOT / "data" / "heat_hazards_daily.csv"
ANALYSIS_OUTPUT = ROOT / "data" / "analysis_daily.csv"
SUMMARY_OUTPUT = ROOT / "data" / "summary.json"

LOCAL_TZ = ZoneInfo("America/Chicago")
START_DATE = date(2023, 4, 1)
IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py"
USER_AGENT = "LIX-Heat-ED-Analysis/1.0 (https://github.com/mefferso/LIX-Heat-ED-Analysis)"

# Historical/current LIX public-zone mapping needed for 2023-present.
# 2026 replacements are included alongside the retired zone IDs.
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
    # Effective March 2026 reconfiguration
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
    return cfg, parishes


CFG, PARISH_META = load_geography()
PARISHES = list(PARISH_META)
PARISH_NORMALIZED = {}


def text_key(value: str) -> str:
    value = value.lower().replace("&", "and")
    value = re.sub(r"\bparish\b", "", value)
    value = re.sub(r"[^a-z0-9]+", "", value)
    return value


for _p in PARISHES:
    PARISH_NORMALIZED[text_key(_p)] = _p

PARISH_NORMALIZED.update({
    text_key("St John The Baptist"): "St. John the Baptist",
    text_key("Saint John the Baptist"): "St. John the Baptist",
    text_key("St John Baptist"): "St. John the Baptist",
    text_key("St Bernard"): "St. Bernard",
    text_key("Saint Bernard"): "St. Bernard",
    text_key("St Charles"): "St. Charles",
    text_key("Saint Charles"): "St. Charles",
    text_key("St Helena"): "St. Helena",
    text_key("Saint Helena"): "St. Helena",
    text_key("St James"): "St. James",
    text_key("Saint James"): "St. James",
    text_key("St Tammany"): "St. Tammany",
    text_key("Saint Tammany"): "St. Tammany",
})


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

    name_key = text_key(name)
    matches = [p for p in PARISHES if text_key(p) in name_key or name_key in text_key(p)]
    if len(matches) == 1:
        cache[ugc] = matches[0]
        return matches[0]

    raise RuntimeError(
        f"Could not map LIX Louisiana zone {ugc!r} with NWS name {name!r} to a configured parish."
    )


def fetch_iem_rows() -> list[dict[str, str]]:
    end = datetime.now(timezone.utc) + timedelta(days=1)
    params = {
        "accept": "csv",
        "sts": START_DATE.isoformat() + "T00:00Z",
        "ets": end.strftime("%Y-%m-%dT00:00Z"),
        "wfo": "LIX",
        "limitps": "1",
        # Legacy + newer heat code families.
        "phenomena": "HT,EH,HY,XH",
        "significance": "Y,W,Y,W",
    }
    url = IEM_URL + "?" + urllib.parse.urlencode(params, safe=",")
    text = request_text(url)
    return list(csv.DictReader(io.StringIO(text)))


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
        ugc = row_value(row, "NWS_UGC")
        if not ugc.startswith("LAZ"):
            continue

        phenom = row_value(row, "PHENOM", "TYPE").upper()
        sig = row_value(row, "SIG").upper()
        is_advisory = phenom in {"HT", "HY"} and sig == "Y"
        is_warning = phenom in {"EH", "XH"} and sig == "W"
        if not (is_advisory or is_warning):
            continue

        start = parse_vtec_time(row_value(row, "ISSUED"))
        end = parse_vtec_time(row_value(row, "EXPIRED"))
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
                    hazard[key] = {
                        "heat_advisory": 0,
                        "excessive_heat_warning": 0,
                        "hazard_hours": 0.0,
                    }
                if is_advisory:
                    hazard[key]["heat_advisory"] = 1
                if is_warning:
                    hazard[key]["excessive_heat_warning"] = 1
                # Split forecast zones in one parish often share identical valid times.
                # Max avoids double-counting the same clock hours across multiple sub-zones.
                hazard[key]["hazard_hours"] = max(hazard[key]["hazard_hours"], hours)
            cursor_date += timedelta(days=1)

        used_events += 1

    rows = []
    for (d, parish), values in sorted(hazard.items()):
        if values["excessive_heat_warning"]:
            headline = "warning"
        elif values["heat_advisory"]:
            headline = "advisory"
        else:
            headline = "none"
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


def parse_date(value: str) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value[:10], fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def normalize_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def detect_column(fieldnames, candidates):
    lookup = {normalize_header(x): x for x in (fieldnames or [])}
    for cand in candidates:
        key = normalize_header(cand)
        if key in lookup:
            return lookup[key]
    return None


def normalize_ldh_rows():
    if not LDH_INPUT.exists():
        return {}, []

    with LDH_INPUT.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        date_col = detect_column(reader.fieldnames, ["date", "visit date", "visit_date", "encounter date"])
        parish_col = detect_column(
            reader.fieldnames,
            ["parish", "patient parish", "parish of residence", "patient parish of residence"],
        )
        count_col = detect_column(
            reader.fieldnames,
            ["ed_visits", "ed visits", "hri ed visits", "heat-related ed visits", "visits", "count"],
        )

        if not (date_col and parish_col and count_col):
            # A header-only starter file is valid.
            if reader.fieldnames == ["date", "parish", "ed_visits"]:
                return {}, []
            raise RuntimeError(
                "LDH CSV needs recognizable date, parish, and ED-visit count columns. "
                f"Found: {reader.fieldnames}"
            )

        data = defaultdict(float)
        source_rows = []
        for row in reader:
            if not any((v or "").strip() for v in row.values()):
                continue
            d = parse_date(row.get(date_col, ""))
            raw_parish = row.get(parish_col, "")
            parish = PARISH_NORMALIZED.get(text_key(raw_parish))
            if not d or not parish:
                continue
            raw_count = (row.get(count_col, "") or "").replace(",", "").strip()
            try:
                count = float(raw_count)
            except ValueError:
                continue
            data[(d, parish)] += count
            source_rows.append((d, parish, count))

    return data, source_rows


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

    ldh_map, ldh_source_rows = normalize_ldh_rows()
    analysis_rows = []

    if ldh_source_rows:
        ldh_dates = [date.fromisoformat(d) for d, _, _ in ldh_source_rows]
        first_ldh, last_ldh = min(ldh_dates), max(ldh_dates)
        hazard_lookup = {(r["date"], r["parish"]): r for r in hazard_rows}

        for d in daterange(first_ldh, last_ldh):
            ds = d.isoformat()
            for parish in PARISHES:
                h = hazard_lookup.get((ds, parish), {
                    "ldh_region": PARISH_META[parish]["region"],
                    "heat_advisory": 0,
                    "excessive_heat_warning": 0,
                    "headline": "none",
                    "hazard_hours": "0.00",
                })
                count = ldh_map.get((ds, parish), 0.0)
                analysis_rows.append({
                    "date": ds,
                    "parish": parish,
                    "ldh_region": h["ldh_region"],
                    "ed_visits": int(count) if float(count).is_integer() else count,
                    "heat_advisory": h["heat_advisory"],
                    "excessive_heat_warning": h["excessive_heat_warning"],
                    "headline": h["headline"],
                    "hazard_hours": h["hazard_hours"],
                })

    write_csv(
        ANALYSIS_OUTPUT,
        analysis_rows,
        ["date", "parish", "ldh_region", "ed_visits", "heat_advisory", "excessive_heat_warning", "headline", "hazard_hours"],
    )

    phenom_counts = defaultdict(int)
    sig_counts = defaultdict(int)
    ugc_prefix_counts = defaultdict(int)
    for row in iem_rows:
        phenom_counts[row_value(row, "PHENOM", "TYPE") or "(blank)"] += 1
        sig_counts[row_value(row, "SIG") or "(blank)"] += 1
        ugc = row_value(row, "NWS_UGC")
        ugc_prefix_counts[(ugc[:3] if ugc else "(blank)")] += 1

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "iem_status": "ok",
        "iem_rows_received": len(iem_rows),
        "iem_columns": list(iem_rows[0].keys()) if iem_rows else [],
        "iem_phenom_counts": dict(sorted(phenom_counts.items())),
        "iem_sig_counts": dict(sorted(sig_counts.items())),
        "iem_ugc_prefix_counts": dict(sorted(ugc_prefix_counts.items())),
        "iem_sample": iem_rows[:2],
        "heat_event_zone_rows_used": used_events,
        "mapped_zone_count": len(zone_cache),
        "hazard_rows": len(hazard_rows),
        "hazard_period_start": START_DATE.isoformat(),
        "hazard_period_end": datetime.now(LOCAL_TZ).date().isoformat(),
        "ldh_status": "loaded" if ldh_source_rows else "no_data",
        "ldh_source_rows": len(ldh_source_rows),
        "analysis_rows": len(analysis_rows),
    }
    SUMMARY_OUTPUT.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
