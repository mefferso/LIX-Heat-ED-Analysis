# LIX Heat ED Analysis

Automated analysis of **NWS LIX heat headlines** and **Louisiana Department of Health heat-related emergency department visits** for the Louisiana portion of the WFO New Orleans/Baton Rouge CWA.

Live dashboard:

https://mefferso.github.io/LIX-Heat-ED-Analysis/

## What is automated

A GitHub Actions pipeline retrieves and processes both sides of the comparison with no local server and no manual HAR/CSV workflow.

### NWS / IEM heat headlines

The pipeline queries the Iowa Environmental Mesonet NWS Watch/Warning/Advisory VTEC archive for WFO LIX from 2023 through the present.

Recognized heat products include both legacy and newer VTEC code families:

- Heat Advisory: `HT.Y`, `HY.Y`
- Excessive / Extreme Heat Warning: `EH.W`, `XH.W`

The archive is expanded from forecast-zone events to local calendar days and mapped to the 22 Louisiana parishes in the LIX CWA. Historical and current LIX public-zone configurations are supported, including the March 2026 zone reconfiguration.

### LDH heat-related ED visits

The pipeline launches headless Chromium with Playwright and reads the public LDH **Heat-Related Illness** Tableau dashboard.

It automatically retrieves daily HRI ED counts for:

- 2023
- 2024
- 2025
- 2026

and for the four LDH regions relevant to the Louisiana side of LIX:

- Region 1 — Southeast
- Region 2 — Capital Region
- Region 3 — South Central
- Region 9 — Northshore

The extraction uses Tableau's public anonymous session and the `HRI Epi Curve` worksheet data. No user cookies, credentials, browser export, HAR file, or manual download are required.

LDH states that the HRI dashboard data are preliminary and refresh weekly during the warm season.

## Geography

The IEM/NWS side is parish-first.

### Region 1 — Southeast

- Jefferson
- Orleans
- Plaquemines
- St. Bernard

### Region 2 — Capital

- Ascension
- East Baton Rouge
- East Feliciana
- Iberville
- Pointe Coupee
- West Baton Rouge
- West Feliciana

### Region 3 — South Central

LIX parishes:

- Assumption
- Lafourche
- St. Charles
- St. James
- St. John the Baptist
- Terrebonne

**Important:** LDH Region 3 also contains **St. Mary Parish**, which is outside the LIX CWA. The public LDH daily region series cannot separate St. Mary from the rest of Region 3, so South Central ED counts include St. Mary. The dashboard calls this out rather than pretending the geographic match is exact.

### Region 9 — Northshore

- Livingston
- St. Helena
- St. Tammany
- Tangipahoa
- Washington

### Mississippi

Mississippi counties in the LIX CWA are not included in the health analysis because a comparable public daily county-level HRI ED series has not been identified.

## Generated data

### `data/ldh_heat_region_daily.csv`

Automated LDH region/day HRI ED series.

Columns:

```text
date
season
ldh_region
region_name
ed_visits
source_updated
```

### `data/heat_hazards_daily.csv`

Daily IEM/NWS heat headline status for every Louisiana LIX parish.

Columns:

```text
date
parish
ldh_region
heat_advisory
excessive_heat_warning
headline
hazard_hours
```

### `data/analysis_region_daily.csv`

Merged LDH + IEM analysis table.

For each LDH region/day it includes:

- HRI ED visits
- number and percentage of LIX parishes under Heat Advisory
- number and percentage under Excessive/Extreme Heat Warning
- coverage-weighted headline severity score
- mean headline hours per LIX parish

### `data/summary.json`

Pipeline status, coverage dates, source timestamps, row counts, and validation information.

## Dashboard analysis

The GitHub Pages dashboard supports:

- individual 2023, 2024, 2025, and 2026 seasons
- combined 2023–2026 view
- entire Louisiana LIX CWA
- Southeast
- Capital
- South Central
- Northshore
- toggles for daily high, low, average temperature, and peak heat index

Health metrics include:

- mean ED visits on no-headline days
- mean ED visits on Heat Advisory days
- mean ED visits on warning days
- percent difference from no-headline days
- Pearson correlation
- 0-, 1-, 2-, and 3-day lag correlations

The area selector offers the combined Louisiana CWA and four LDH regions.

## Headline severity

Each LIX parish/day is scored:

- no heat headline = 0
- Heat Advisory = 1
- Excessive/Extreme Heat Warning = 2

For a region or the full Louisiana LIX CWA, the daily severity score is averaged across the selected LIX parishes. This retains partial headline coverage instead of treating a headline covering one parish as equivalent to one covering the entire area.

## Automation

The production GitHub Action runs the data pipeline on a schedule and can also be started manually.

The workflow:

1. starts an anonymous LDH Tableau session in headless Chromium,
2. retrieves 2023–2026 HRI ED data for Regions 1, 2, 3, and 9,
3. retrieves the LIX heat-product history from IEM,
4. maps heat products to Louisiana LIX parishes and local dates,
5. builds the merged region/day analysis,
6. validates the generated files,
7. commits changed data back to the repository,
8. GitHub Pages republishes the dashboard.

If LDH changes its Tableau workbook structure and extraction fails, the Action fails rather than silently replacing the data with zeros.

## Data sources

Louisiana Department of Health Heat-Related Illness dashboard:

https://ldh.la.gov/page/heat

Iowa Environmental Mesonet NWS Watch/Warning/Advisory archive:

https://mesonet.agron.iastate.edu/request/gis/watchwarn.phtml

## Interpretation

This is an exploratory operational/public-health analysis, not a causal study. Heat headlines are not randomized exposure. Weather severity, behavior, demographics, access to cooling, location of exposure, healthcare-seeking behavior, and surveillance/reporting practices can all affect ED visits.

This project is not an official NWS or LDH product.


## Weather overlays

Daily weather is cached in `data/weather_daily.csv`. The independent **Update airport weather** Action refreshes the last eight days daily and supports manual runs; `python scripts/update_weather.py --full` rebuilds the archive from January 2023. A failed source request leaves the previous dataset intact and does not block the LDH pipeline.

| Area | Airport observations |
| --- | --- |
| Capital | KBTR |
| Northshore | KASD (Slidell) |
| Southeast | KMSY and KNEW, plotted separately |
| South Central | KHUM |
| LIX Louisiana CWA | All five stations, plotted separately |

Toggle high, low, average, or peak heat index above the timeline. Colors identify variables; line patterns identify stations. Weather uses a separate °F axis. Dates on the horizontal axis are MM-DD, with the selected year or year range in the heading and full dates in tooltips.

The [IEM routine airport observation archive](https://mesonet.agron.iastate.edu/request/download.phtml) supplies temperature and relative humidity. We keep the latest valid temperature report per UTC hour to avoid giving airports with multiple routine reports per hour extra weight. Days follow America/Chicago midnight boundaries, including 23/25-hour DST days. High and low are the extrema of those sampled hourly temperatures, **not official daily climate maxima/minima**. Average is the arithmetic mean of available hourly temperatures, **not (high + low)/2**.

Peak heat index is the maximum of hourly values calculated using the [NWS heat-index equation](https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml), with the initial Steadman screening and the Rothfusz low/high-humidity adjustments. Temperature and humidity always come from the same observation. Missing humidity cannot generate a heat-index value. No-observation days remain blank and graph lines do not bridge them. Partial days use available hours and tooltips show valid/expected hour counts; sparse observations may miss the actual daily extremes. Only completed local calendar days are cached.
