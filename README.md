# LIX Heat ED Analysis

Operational/research dashboard for comparing **heat-related emergency department (ED) visits** in the Louisiana portion of the NWS New Orleans/Baton Rouge (LIX) CWA with **Heat Advisory** and **Excessive/Extreme Heat Warning** days.

## What this project does

- Downloads historical LIX heat headlines from the Iowa Environmental Mesonet (IEM) VTEC archive.
- Converts zone-based heat products to the 22 Louisiana parishes in the LIX CWA.
- Handles the March 2026 LIX forecast-zone changes.
- Recognizes both legacy and newer heat VTEC code families:
  - Heat Advisory: `HT.Y` and `HY.Y`
  - Excessive/Extreme Heat Warning: `EH.W` and `XH.W`
- Merges hazard days with Louisiana Department of Health (LDH) heat-related ED visit data.
- Calculates same-day and 1–3 day lag relationships between headline exposure and ED visits.
- Displays an interactive GitHub Pages dashboard for the whole Louisiana LIX CWA, LDH regions, or individual parishes.

## Geography

The analysis is parish-first. The 22 Louisiana parishes in WFO LIX are grouped into these LDH regions:

- **Region 1 — Southeast / New Orleans:** Jefferson, Orleans, Plaquemines, St. Bernard
- **Region 2 — Capital:** Ascension, East Baton Rouge, East Feliciana, Iberville, Pointe Coupee, West Baton Rouge, West Feliciana
- **Region 3 — South Central (LIX subset):** Assumption, Lafourche, St. Charles, St. James, St. John the Baptist, Terrebonne
- **Region 9 — Northshore:** Livingston, St. Helena, St. Tammany, Tangipahoa, Washington

LDH Region 3 also contains **St. Mary Parish**, but St. Mary is not in the LIX CWA and is intentionally excluded.

Mississippi counties in the LIX CWA are not included in the health analysis because a comparable public daily county-level HRI ED dataset has not yet been identified.

## Data sources

### NWS heat headlines
Iowa Environmental Mesonet NWS Watch/Warning/Advisory VTEC archive:

https://mesonet.agron.iastate.edu/request/gis/watchwarn.phtml

### Heat-related ED visits
Louisiana Department of Health Heat-Related Illness dashboard:

https://ldh.la.gov/page/heat

LDH reports that approximately 90% of Louisiana EDs participate in the syndromic surveillance system. Parish-level HRI counts are based on the patient's parish of residence.

## LDH import

The public LDH heat dashboard is Tableau-based, while the underlying ESSENCE syndromic feed is restricted. Until a stable public machine-readable Tableau endpoint is confirmed, the project uses a deliberately simple import layer.

Put/export normalized daily parish data in:

`data/input/ldh_heat_raw.csv`

Required columns:

```csv
date,parish,ed_visits
2026-07-01,St. Tammany,4
2026-07-01,East Baton Rouge,7
```

The website also allows an LDH CSV to be loaded directly in the browser. Browser uploads remain local to the browser and are not sent anywhere.

## Automated update

`.github/workflows/update-data.yml` runs daily and can also be run manually. It:

1. downloads LIX heat VTEC events from IEM,
2. expands the events to local calendar days and Louisiana parishes,
3. merges any committed LDH input data,
4. regenerates the dashboard CSV/JSON files,
5. commits changed generated data back to the repository.

## GitHub Pages

The site is built from static files in the repository root.

After the files are committed, go to:

**Settings → Pages → Build and deployment → Deploy from a branch → main → /(root) → Save**

Expected site:

https://mefferso.github.io/LIX-Heat-ED-Analysis/

## Analysis notes

The dashboard's headline severity score is parish-coverage weighted:

- no headline = 0
- Heat Advisory = 1
- Excessive/Extreme Heat Warning = 2

For a multi-parish selection, the score is averaged across selected parishes for each day. This lets a headline covering one parish differ from a headline covering the entire selected region.

Correlations are exploratory and **do not imply causation**. HRI ED surveillance has reporting limitations, and the location of illness/exposure may differ from parish of residence.

## Next upgrades

- Stable automated LDH Tableau ingestion if/when a reliable public export endpoint is confirmed
- observed maximum heat index / temperature exposure
- population-normalized HRI rates
- episode-level analysis
- threshold / hit / miss / false-alarm verification based on elevated HRI days
- Mississippi data if a suitable public daily county-level source becomes available
