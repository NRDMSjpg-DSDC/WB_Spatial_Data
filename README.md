# BEUP & MPLAD WebGIS — Static / GitHub Pages Edition

A browser-based GIS portal for BEUP and MPLAD works. Runs entirely as
static files — **no server, no PHP, no database** — so it hosts directly
on **GitHub Pages** (or any static host, or straight from disk).

## What's in this version
- Point, line, and polygon project geometries, drawn directly on the map
- Demo login with **Admin** / **User** roles (client-side only — see caveat below)
- Data-management functions moved into a top menu bar, shown/hidden by role
- Cascading **District → Block/Municipality → GP/Ward** admin filters
- A collapsible **right-hand dashboard**: MPLAD/BEUP filter, MP/MLA filter,
  Scheme-type filter, total count, status breakdown
- A **data-driven legend**, generated from whatever `work_type` values exist
  in the project data (collapsible)
- A **basemap switcher** (OpenStreetMap / satellite imagery)
- A native Leaflet **scale bar**
- A **footer** with department name and live cursor latitude/longitude
- A **visitor counter** (shared counter via a free API, with a local
  fallback — see caveat below)
- **Outside-district markers**: projects whose coordinates fall outside
  their district's boundary polygon get a distinct warning icon
- Smaller (~40% size) colour-coded project markers
- A **Coordinate View** tool: type lat/lon, jump the map there with a
  temporary pulsing marker — never touches project data
- A **My Location** button using the browser's Geolocation API
- Everything — map, dashboard, attribute table, legend, filters — reads
  from one shared `projects` array, so adding/editing/importing/deleting a
  project updates all of them immediately

## Login (read this first)
This is a **static site with no backend**, so there is no real
authentication — the "login" only decides which buttons the *browser*
shows you. It is not secure and must not be relied on to protect data;
anyone who reads `assets/app.js` can see the demo passwords. Replace this
with real server-side authentication before using this for anything
where access control actually matters.

Demo accounts (shown in the login dialog too):

| Username | Password  | Role  | Can do |
|----------|-----------|-------|--------|
| `admin`  | `admin123`| Admin | Everything: add/edit/delete, import/export CSV & GeoJSON, attribute table |
| `user`   | `user123` | User  | Add Project only |

Not logged in: none of the data-management buttons are shown at all.

## Outside-district detection
This checks each project's coordinates against polygons in
**`data/districts.geojson`**, matched by the project's `district` field.
**The shipped file contains one rough, hand-drawn placeholder boundary for
"Jalpaiguri"** — it is not an authoritative administrative boundary.
Replace it with the real district boundary GeoJSON (e.g. from Survey of
India, LGD, or your state GIS cell) before relying on this for anything
official. Districts with no matching boundary feature are skipped (shown
normally, not flagged) since there's nothing to check them against.

## Gram_Panchayat overlay layer
The same `data/districts.geojson` file also powers a separate, optional
**Gram_Panchayat** overlay layer, toggled on/off from the Basemap/Layer
control (independent of the OSM/Imagery basemap choice). Each polygon is
labelled from its `Gram_Panchayat` property (features with no value there
show no label). To avoid clutter, labels only appear between zoom level 18
and 21 (map zoom beyond the tiles' native 19 uses upscaled imagery so this
range is reachable) — the polygon outlines themselves are always shown
when the layer is switched on, regardless of zoom. Clicking a boundary
opens a popup listing all of its attributes (generated from whatever
properties the feature has — nothing hard-coded).

## Visitor counter
A static site has no server to count visits centrally. This app first
tries a free, keyless counter service (CountAPI) so the number is shared
across all visitors; if that's unreachable (offline, blocked, or the
service is down) it falls back to a **local, per-browser only** count so
the UI never breaks — that fallback is labelled "(local only)" so it's
never mistaken for a real shared total. Before deploying, open
`assets/app.js` and change:
```js
const VISITOR_NAMESPACE = 'beup-mplad-webgis-demo';
```
to something unique to your deployment, or swap in your own counter
service/API if you have one.

## MP/MLA and scheme-type filters
The dashboard's "Name of MP/MLA" and "Type of Scheme" dropdowns are built
from whatever values already exist in your project data (the `mp_mla` and
`work_type` fields) — nothing is hard-coded. Add a project with a new
MP/MLA name or work type and it appears in the filter automatically.

## Deploy to GitHub Pages
1. Push this folder's contents to a GitHub repository (root or `/docs`).
2. Repo **Settings → Pages** → Source: "Deploy from a branch" → pick the
   branch/folder.
3. Save — the site publishes at `https://<username>.github.io/<repo>/`
   within a minute or two. `.nojekyll` is included so `data/`/`assets/`
   are served as-is.

## Run locally
Just open `index.html` — the map still works via a built-in fallback copy
of the sample data. For `data/*.geojson` and GitHub Pages-style behaviour
to work exactly as deployed, serve the folder over HTTP instead, e.g.:
```
python3 -m http.server 8000
```
then open `http://localhost:8000/`. (Browsers block `fetch()` of local
files under `file://`, which is why the fallback exists.)

## How project data persists
- On first visit, data loads from `data/projects.geojson` (or the
  built-in fallback) into the browser's `localStorage`.
- Every add/edit/delete saves to `localStorage` immediately — changes
  persist across reloads **in that browser only**; they are not shared
  with other visitors, since GitHub Pages can't write back to the repo.
- To publish new data for everyone: **Export GeoJSON**, replace
  `data/projects.geojson` in the repo, commit, and push. Visitors with no
  local data already saved will get the new dataset.

## Working with lines and polygons
- Use the drawing toolbar (top-left of the map) for point / polyline /
  polygon / rectangle. Finishing a shape opens the Add Project form with
  that geometry attached.
- Editing a line/polygon project: click **Draw / Redraw Shape on Map** —
  your other field values are kept while you draw the replacement.
- **Clear Shape** drops the attached shape so you can type a plain lat/lon
  point instead.

## Data format
`data/projects.geojson` is a GeoJSON `FeatureCollection`. Geometries can
be `Point`, `LineString`, or `Polygon` (a drawn rectangle is a `Polygon`
too). `properties` holds:

`id, scheme, project_code, name, mp_mla, district, block, gp, village,
work_type, amount, status, sanction_date, completion_date, remarks`

`data/districts.geojson` holds one `Polygon` feature per district, keyed
by a `district` property that must match the project data's `district`
field exactly.

CSV export/import adds `geometry_type` and a `geometry` column (the full
GeoJSON geometry as JSON text) so lines/polygons round-trip through a
spreadsheet; plain lat/lon-only CSVs still import fine as points.

## Notes for production use
This is a strong starting point for demo / internal / GitHub-Pages use.
For a real multi-user government deployment you'll want: a real backend
with proper authentication (the login here is UI-only), an authoritative
district boundary dataset, and a shared database instead of per-browser
`localStorage` so edits are visible to everyone immediately.
