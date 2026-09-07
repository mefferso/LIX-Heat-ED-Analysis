#!/usr/bin/env python3
"""Cache local-day weather from routine IEM airport observations (no server required)."""
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
OUTPUT = ROOT / 'data/weather_daily.csv'
META = ROOT / 'data/weather_meta.json'
LOCAL = ZoneInfo('America/Chicago')
FIELDS = ['date', 'station', 'high_f', 'low_f', 'average_f', 'peak_heat_index_f',
          'temperature_hours', 'heat_index_hours', 'expected_hours']
SOURCE = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'


def heat_index(t, rh):
    """NWS Steadman screening, Rothfusz regression, and humidity adjustments, °F.

    https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
    """
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


def daily_rows(text, start, end, stations):
    reader = csv.DictReader(line for line in text.splitlines() if not line.startswith('#'))
    if not {'station', 'valid', 'tmpf', 'relh'}.issubset(reader.fieldnames or []):
        raise ValueError('Unexpected IEM CSV headers; retaining previous data')
    hours = {}
    for row in reader:
        station = 'K' + row['station'].removeprefix('K')
        if station not in stations:
            continue
        stamp = datetime.fromisoformat(row['valid']).replace(tzinfo=timezone.utc)
        day = stamp.astimezone(LOCAL).date()
        t, rh = number(row['tmpf']), number(row['relh'])
        if not start <= day < end or t is None or not -100 <= t <= 140:
            continue
        # Some AWOS sites send multiple routine reports/hour. Keep the latest
        # valid temperature report, so extra reports do not bias the mean.
        key = (station, stamp.replace(minute=0, second=0, microsecond=0))
        if key not in hours or stamp > hours[key][0]:
            hours[key] = (stamp, day, t, rh if rh is not None and 0 <= rh <= 100 else None)
    grouped = defaultdict(list)
    for (station, _), obs in hours.items():
        grouped[(obs[1], station)].append(obs)
    result = []
    day = start
    while day < end:
        midnight = datetime.combine(day, datetime.min.time(), LOCAL).astimezone(timezone.utc)
        tomorrow = datetime.combine(day+timedelta(days=1), datetime.min.time(), LOCAL).astimezone(timezone.utc)
        for station in stations:
            obs = grouped[(day, station)]
            temps = [o[2] for o in obs]
            his = [heat_index(o[2], o[3]) for o in obs if o[3] is not None]
            result.append(dict(zip(FIELDS, [day.isoformat(), station,
                round(max(temps), 1) if temps else '', round(min(temps), 1) if temps else '',
                round(sum(temps)/len(temps), 1) if temps else '', round(max(his), 1) if his else '',
                len(temps), len(his), int((tomorrow-midnight).total_seconds()/3600)])))
        day += timedelta(days=1)
    return result


def download(start, end, stations):
    params = {'station':[s.removeprefix('K') for s in stations], 'data':['tmpf','relh'],
        'sts':datetime.combine(start, datetime.min.time(), LOCAL).astimezone(timezone.utc).isoformat(),
        'ets':datetime.combine(end, datetime.min.time(), LOCAL).astimezone(timezone.utc).isoformat(),
        'tz':'UTC', 'format':'onlycomma', 'latlon':'no', 'elev':'no', 'missing':'M', 'report_type':'3'}
    request = urllib.request.Request(SOURCE+'?'+urllib.parse.urlencode(params, doseq=True),
        headers={'User-Agent':'LIX-Heat-ED-Analysis/3.0 (github.com/mefferso/LIX-Heat-ED-Analysis)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                text = response.read().decode('utf-8')
            rows = daily_rows(text, start, end, stations)
            for station in stations:
                if not any(r['temperature_hours'] for r in rows if r['station'] == station):
                    raise ValueError(f'No temperatures received for {station}; retaining previous dataset')
            return rows
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3*(attempt+1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--full', action='store_true', help='Rebuild from 2023')
    args = parser.parse_args()
    geo = json.loads((ROOT/'config/geography.json').read_text())
    stations = sorted({s for r in geo['regions'].values() for s in r['weather_stations']})
    end = datetime.now(LOCAL).date()  # completed local days only
    start = date(2023, 1, 1)
    old = []
    if OUTPUT.exists() and not args.full:
        old = list(csv.DictReader(OUTPUT.open()))
        if old:
            start = max(start, date.fromisoformat(max(r['date'] for r in old))-timedelta(days=7))
    rows = [r for r in old if r['date'] < start.isoformat()]
    cursor = start
    while cursor < end:
        stop = min(date(cursor.year+1, 1, 1), end)
        print(f'Fetching {cursor} through {stop} (exclusive): {", ".join(stations)}', flush=True)
        rows.extend(download(cursor, stop, stations))
        cursor = stop
        time.sleep(1.1)  # IEM per-IP throttle
    rows.sort(key=lambda r:(r['date'], r['station']))
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(buffer.getvalue())
    temporary.replace(OUTPUT)
    META.write_text(json.dumps({'generated_at':datetime.now(timezone.utc).isoformat(),
        'source':SOURCE, 'timezone':'America/Chicago', 'stations':stations,
        'period_start':rows[0]['date'], 'period_end':rows[-1]['date'], 'rows':len(rows),
        'method':'Latest routine observation per UTC hour; local-day extrema and arithmetic hourly mean. NWS heat index computed per hour. Blank when no observations; counts indicate partial days.'}, indent=2)+'\n')
    print(f'Saved {len(rows)} station-days', flush=True)


if __name__ == '__main__':
    main()
