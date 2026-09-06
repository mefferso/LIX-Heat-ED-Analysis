# LDH heat-related ED visit input

The automated IEM/NWS hazard side of this project is fully self-contained. The Louisiana Department of Health public heat dashboard is hosted in Tableau, but its direct CSV export endpoint is not currently exposed as a stable public URL.

## Permanent project data

Normalize/export the LDH parish-by-day data into `ldh_heat_raw.csv` with these columns:

```csv
date,parish,ed_visits
2026-07-01,St. Tammany,4
2026-07-01,East Baton Rouge,7
```

Then commit the file to `data/input/ldh_heat_raw.csv`.

The GitHub Action will automatically rebuild `data/analysis_daily.csv`.

## Temporary/local analysis

You do not have to commit health data just to explore it.

Open the GitHub Pages dashboard and use **Load LDH CSV locally**. The browser parser accepts common header variants such as:

- Date / Visit Date / Encounter Date
- Parish / Patient Parish / Parish of Residence
- ED Visits / HRI ED Visits / Heat-Related ED Visits / Count

The selected file is processed only in the browser and is not uploaded anywhere.

## Geography rules

Only the 22 Louisiana parishes in the LIX CWA are retained. Any rows for parishes outside LIX are ignored.

St. Mary Parish is intentionally excluded even though it belongs to LDH Region 3 (South Central), because St. Mary is outside the LIX CWA.
