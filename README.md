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
- 2020 Census health-population denominator
- ED visits per 100,000
- number and percentage of LIX parishes under Heat Advisory
- number and percentage under Excessive/Extreme Heat Warning
- coverage-weighted headline severity score
- mean headline hours per LIX parish

Region 3 rates include St. Mary Parish in the denominator because St. Mary is included in the LDH Region 3 ED numerator. LIX headline/weather geography still excludes St. Mary.

### `data/weather_region_daily.csv`

QC'd regional exposure series used for heat-health comparisons. Primary airport observations are used when they meet the daily coverage requirement; configured fallback airports are used when a primary station does not. The file records the source station(s) and whether a fallback was used.

It also contains:

- daily high, low, hourly average, and peak heat index
- 00–11 local morning/overnight low
- hours with heat index ≥105°F and ≥108°F
- 2-day and 3-day mean peak heat index
- consecutive days with peak heat index ≥108°F
- regional 2020 Census population used for combined population weighting

### `data/wbgt_region_daily.csv`

Outdoor WBGT archive calculated with the Liljegren method through ECMWF `thermofeel`. Inputs come from Open-Meteo ERA5-Land with ERA5 fallback and include temperature, humidity/dew point, pressure, wind, shortwave radiation, direct-radiation fallback, and solar geometry. The regional value is the mean of configured parish-point daily maximum WBGT values.

### `data/advanced_analysis.json`

Adjusted archive-level model summaries. Region-day ED counts are modeled with a log(population) offset, nonlinear cubic-spline exposure, and adjustment for year, month, day-of-week, plus region for the combined-CWA model. Negative binomial is preferred; Poisson is used only as a fit fallback.

### `data/summary.json`

Pipeline status, coverage dates, source timestamps, row counts, population-source metadata, and validation information.

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


## Weather / ED analysis

The bottom of the dashboard compares heat-related ED response with five core exposure variables:

- daily high temperature
- daily low temperature
- hourly average temperature
- peak hourly heat index
- outdoor Liljegren WBGT

The user can display raw ED counts or population-normalized ED visits per 100,000. For the full LIX Louisiana area, regional weather exposure is population-weighted rather than averaged equally across four regions.

Each core scatterplot includes:

- year-colored daily observations
- Pearson `r` and `r²`
- a locally weighted nonlinear mean-response curve
- an approximate pointwise 95% local uncertainty band
- hover dates, ED response, and regional weather-source provenance
- 108°F Heat Advisory and 113°F warning reference lines on peak-HI plots
- 2°F exposure bins for peak HI and WBGT

The page also estimates a continuous two-slope breakpoint for peak HI and WBGT. The breakpoint search is constrained to the middle 60% of observed exposure values to reduce tail leverage, and a bootstrap interval is shown as a stability diagnostic. It is exploratory and is **not** automatically an operational threshold.

### Duration and persistence metrics

A separate ranking compares:

- overnight / morning low
- hours with HI ≥105°F
- hours with HI ≥108°F
- 2-day mean peak HI
- 3-day mean peak HI
- consecutive HI ≥108°F days

These metrics are intended to test whether sustained thermal load explains ED visits better than one afternoon maximum.

### Adjusted model comparison

The dashboard also displays archive-level adjusted model results from `data/advanced_analysis.json`. These are fitted at region-day resolution, avoiding an equal-weight combined-region weather average. Models use ED counts with a log population offset and adjust for year, month, day-of-week, and region in the combined analysis.

Exposure is represented with a cubic B-spline. Negative binomial is preferred, with Poisson fallback only when the negative-binomial fit fails. The table reports ΔAIC and the adjusted model response ratio between the median and 90th-percentile exposure. All-month and June–August-only results can be viewed.

These adjusted results are still observational and exploratory. They reduce several obvious confounders but do not establish causation or out-of-sample forecast skill.

### WBGT methodology

The WBGT method is based on the project-supplied `fill_wbgt_v3.py` approach and has been converted into an automated regional archive. It uses the physically based Liljegren solver in ECMWF `thermofeel`, not a temperature/humidity-only shortcut.

Open-Meteo's standard hourly shortwave radiation is treated as a preceding-hour mean, with solar geometry evaluated at the hour midpoint. Direct radiation is used when available; otherwise it is estimated from global shortwave radiation with the Erbs decomposition. Relative humidity and surface pressure have documented meteorological fallbacks when the primary fields are missing.

## Weather overlays and airport archive methodology

Daily airport observations remain cached in `data/weather_daily.csv` for the timeline overlays. The requested primary overlays are unchanged:

| Area | Primary airport overlay |
| --- | --- |
| Capital | KBTR |
| Northshore | KASD (Slidell) |
| Southeast | KMSY and KNEW |
| South Central | KHUM |
| LIX Louisiana CWA | All five primary stations |

The regional **analysis** layer is more resilient than the visual overlay layer. It uses the primary stations above when they meet ≥75% daily temperature and heat-index coverage, with explicit fallback chains configured in `config/geography.json`. Every regional day records the station source and whether a fallback was used; fallback substitution is never silent.

The IEM routine airport observation archive supplies temperature and relative humidity. The latest valid temperature report per UTC hour is retained so airports with extra routine reports do not get extra weight. Days follow America/Chicago local-calendar boundaries, including 23/25-hour DST days. High and low are extrema of sampled hourly observations; average is the arithmetic mean of available hourly observations.

Peak heat index uses the NWS Steadman/Rothfusz approach with humidity adjustments. Morning/overnight low is the minimum sampled temperature from 00–11 local. Duration variables count hourly heat-index observations at or above 105°F and 108°F. Multi-day variables require consecutive regional dates.

The weather/WBGT Action refreshes the airport archive, regional exposure series, WBGT archive, and adjusted model summary. WBGT reanalysis intentionally trails real time by several days; it is a retrospective analysis variable, not an operational real-time observation.

The airport updater records its archive schema version in `data/weather_meta.json`.
Schema or configured-station changes trigger a full historical backfill automatically;
ordinary updates refresh the latest week. Missing ancillary metrics do not discard
otherwise qualified high/low/average temperature or peak heat index. A coverage-loss
guard checks station-year and region-year counts before replacing the saved archive.

Run `node tests/archive.cjs` to check the actual published CSVs through the dashboard's
loader and pairing code. It verifies coverage in every available season/area, populated
scatter plots, and all five core adjusted models. Both data workflows run this check
before committing their output. Observation gaps that fail the 75% coverage rule remain
missing rather than being interpolated.

Population values come from the 2020 U.S. Census PL 94-171 Louisiana parish population table and are stored in `config/geography.json`.
