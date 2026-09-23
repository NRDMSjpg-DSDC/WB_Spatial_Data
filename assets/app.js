// BEUP & MPLAD WebGIS — 100% static / browser-side edition.
// Single source of truth: the `projects` array (backed by localStorage,
// seeded from data/projects.geojson). Every view — map, dashboard,
// attribute table, legend, filters — is derived from it and re-rendered
// by renderAll() whenever it changes.

const STORAGE_KEY = 'beup_mplad_projects_v1';
const AUTH_KEY = 'beup_mplad_auth_v1';
const SEED_URL = 'data/projects.geojson';
const DISTRICTS_URL = 'data/districts.geojson';
const GP_LABEL_MIN_ZOOM = 18; // Gram_Panchayat labels only show within this zoom range
const GP_LABEL_MAX_ZOOM = 21;

// Demo, client-side-only credentials. There is no backend here, so this
// only gates which buttons/menus are shown in the UI — it is NOT secure
// authentication. Replace with real server-side auth for production use.
const DEMO_USERS = {
  admin: { password: 'admin123', role: 'admin', label: 'Admin' },
  user:  { password: 'user123',  role: 'user',  label: 'User' }
};

let map, layers = {}, projects = [], nextId = 1;
let districtBoundaries = [];               // [{district, rings:[[ [lon,lat], ... ]]}]
let formGeometry = null;
let pendingGeometry = null;
let redrawDraft = null;
let currentUser = null;                    // {username, role, label} | null
let goToMarker = null, goToBlinkTimer = null;
let myLocationMarker = null, myLocationAccuracyCircle = null;
let osmLayer, imageryLayer;

/* =====================================================================
   BOOTSTRAP
===================================================================== */

document.addEventListener('DOMContentLoaded', async () => {
  if (location.protocol === 'file:') {
    const banner = document.createElement('div');
    banner.className = 'file-protocol-banner';
    banner.textContent = "You're opening this file directly (file://). The app still works using built-in sample data, but for data/*.geojson and GitHub Pages deployment to work fully, serve this folder over http:// — see the README.";
    document.body.prepend(banner);
  }

  initAuth();
  initMap();
  bindStaticHandlers();
  await loadDistrictBoundaries();
  await loadProjects();
  updateVisitorCounter();
});

function bindStaticHandlers() {
  document.getElementById('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    const u = document.getElementById('loginUser').value.trim().toLowerCase();
    const p = document.getElementById('loginPass').value;
    const rec = DEMO_USERS[u];
    if (rec && rec.password === p) {
      currentUser = { username: u, role: rec.role, label: rec.label };
      localStorage.setItem(AUTH_KEY, JSON.stringify(currentUser));
      document.getElementById('loginError').classList.add('hidden');
      closeLogin();
      applyAuthUI();
    } else {
      document.getElementById('loginError').classList.remove('hidden');
    }
  });

  document.getElementById('projectForm').addEventListener('submit', onSubmitProject);
}

/* =====================================================================
   AUTH / ROLES
===================================================================== */

function initAuth() {
  try {
    const stored = localStorage.getItem(AUTH_KEY);
    currentUser = stored ? JSON.parse(stored) : null;
  } catch (e) { currentUser = null; }
  applyAuthUI();
}

function openLogin() {
  document.getElementById('loginForm').reset();
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('loginModal').classList.remove('hidden');
}
function closeLogin() { document.getElementById('loginModal').classList.add('hidden'); }

function logout() {
  currentUser = null;
  localStorage.removeItem(AUTH_KEY);
  applyAuthUI();
}

function applyAuthUI() {
  const loggedIn = !!currentUser;
  document.getElementById('loginBtn').classList.toggle('hidden', loggedIn);
  document.getElementById('logoutBtn').classList.toggle('hidden', !loggedIn);
  const badge = document.getElementById('userBadge');
  badge.classList.toggle('hidden', !loggedIn);
  if (loggedIn) badge.textContent = `${currentUser.label} (${currentUser.username})`;

  const isAdmin = loggedIn && currentUser.role === 'admin';
  const isAny = loggedIn; // admin or user

  document.querySelectorAll('.role-admin').forEach(el => el.classList.toggle('hidden', !isAdmin));
  document.querySelectorAll('.role-any').forEach(el => el.classList.toggle('hidden', !isAny));
  document.getElementById('menuHint').classList.toggle('hidden', loggedIn);

  if (map) renderAll(); // refresh popups so Edit/Delete visibility matches the current role
}

function requireRole(role) {
  if (!currentUser) { alert('Please log in first.'); return false; }
  if (role === 'admin' && currentUser.role !== 'admin') { alert('This function is only available to Admin users.'); return false; }
  return true; // 'any-logged-in' (or any other value) just requires currentUser to exist
}

/* =====================================================================
   MAP SETUP: basemaps, scale bar, draw toolbar, legend, basemap
   switcher, cursor coordinates, current-location control
===================================================================== */

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([26.65, 88.78], 9);

  osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19 });
  imageryLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19 });
  osmLayer.addTo(map);

  L.control.scale({ position: 'bottomleft', metric: true, imperial: false }).addTo(map);

  map.on('mousemove', e => {
    document.getElementById('cursorLat').textContent = e.latlng.lat.toFixed(6);
    document.getElementById('cursorLon').textContent = e.latlng.lng.toFixed(6);
  });

  map.on('click', e => {
    if (!document.getElementById('projectModal').classList.contains('hidden') &&
        document.getElementById('latRow').style.display !== 'none') {
      document.getElementById('lat').value = e.latlng.lat.toFixed(6);
      document.getElementById('lon').value = e.latlng.lng.toFixed(6);
    }
  });

  // Gram_Panchayat labels only make sense zoomed in close; hide them
  // outside the GP_LABEL_MIN_ZOOM..GP_LABEL_MAX_ZOOM range, regardless of
  // whether the overlay itself is switched on.
  map.on('zoomend', updateGpLabelVisibility);
  updateGpLabelVisibility();

  initDrawToolbar();
  // Order matters: Leaflet stacks same-corner controls in the order they're
  // added, top to bottom — this gives My Location -> Basemap (top-right).
  // Legend is placed in the bottom section separately (see initLegendControl).
  initCurrentLocationControl();
  initBasemapSwitcher();
  initLegendControl();
}

function updateGpLabelVisibility() {
  const z = map.getZoom();
  map.getContainer().classList.toggle('gp-labels-hidden', z < GP_LABEL_MIN_ZOOM || z > GP_LABEL_MAX_ZOOM);
}

function initDrawToolbar() {
  try {
    if (!L.Control.Draw) throw new Error('Leaflet.Draw did not load');
    const drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: {
        marker: true,
        polyline: { shapeOptions: { color: '#c65d12', weight: 4 } },
        polygon: { shapeOptions: { color: '#c65d12', weight: 2, fillOpacity: 0.25 }, allowIntersection: false },
        rectangle: { shapeOptions: { color: '#c65d12', weight: 2, fillOpacity: 0.25 } },
        circle: false,
        circlemarker: false
      }
    });
    map.addControl(drawControl);
    map.on(L.Draw.Event.CREATED, e => {
      pendingGeometry = e.layer.toGeoJSON().geometry;
      const draft = redrawDraft;
      redrawDraft = null;
      openProject(draft || null);
    });
  } catch (err) {
    console.error('Drawing toolbar unavailable (line/polygon drawing disabled):', err);
  }
}

function initBasemapSwitcher() {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'leaflet-bar basemap-switcher');
      const btn = L.DomUtil.create('a', 'basemap-btn', div);
      btn.href = '#'; btn.title = 'Basemap / Layers'; btn.innerHTML = '🗺️';
      const panel = L.DomUtil.create('div', 'basemap-panel hidden', div);
      panel.innerHTML = `
        <label><input type="radio" name="basemap" value="osm" checked> OpenStreetMap</label>
        <label><input type="radio" name="basemap" value="imagery"> Imagery (Satellite)</label>
        <hr>
        <label><input type="checkbox" id="gpLayerToggle"> Gram_Panchayat</label>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(btn, 'click', ev => { ev.preventDefault(); panel.classList.toggle('hidden'); });
      panel.querySelectorAll('input[name="basemap"]').forEach(radio => {
        radio.addEventListener('change', () => {
          if (radio.value === 'imagery') { map.removeLayer(osmLayer); imageryLayer.addTo(map); }
          else { map.removeLayer(imageryLayer); osmLayer.addTo(map); }
        });
      });
      panel.querySelector('#gpLayerToggle').addEventListener('change', ev => {
        if (!gpLayer) return; // still loading data/districts.geojson
        if (ev.target.checked) gpLayer.addTo(map);
        else map.removeLayer(gpLayer);
      });
      return div;
    }
  });
  map.addControl(new Ctl());
}

const LEGEND_COLORS = ['#c65d12', '#2b7a78', '#3454d1', '#7d2ae8', '#c9184a', '#2f9e44', '#e67700', '#495057'];
function colorForWorkType(type) {
  const key = String(type || 'Other');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return LEGEND_COLORS[hash % LEGEND_COLORS.length];
}

let legendControlDiv = null, legendCollapsed = false;
function initLegendControl() {
  const Ctl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'legend-control');
      L.DomEvent.disableClickPropagation(div);
      legendControlDiv = div;
      renderLegend();
      return div;
    }
  });
  map.addControl(new Ctl());
}

function renderLegend() {
  if (!legendControlDiv) return;
  const types = [...new Set(projects.map(p => p.work_type).filter(Boolean))].sort();
  const rows = types.map(t => `<div class="legend-row"><span class="legend-swatch" style="background:${colorForWorkType(t)}"></span>${esc(t)}</div>`).join('');
  legendControlDiv.innerHTML = `
    <div class="legend-head" onclick="toggleLegend()">Legend ${legendCollapsed ? '▸' : '▾'}</div>
    <div class="legend-body ${legendCollapsed ? 'hidden' : ''}">
      ${rows || '<div class="legend-row muted">No work types yet</div>'}
      <div class="legend-row"><span class="legend-swatch outside-swatch">⚠</span>Outside District</div>
    </div>`;
}
function toggleLegend() { legendCollapsed = !legendCollapsed; renderLegend(); }

function initCurrentLocationControl() {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      const btn = L.DomUtil.create('a', 'locate-btn', div);
      btn.href = '#'; btn.title = 'My Location'; btn.innerHTML = '📍';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(btn, 'click', ev => { ev.preventDefault(); useMyLocation(); });
      return div;
    }
  });
  map.addControl(new Ctl());
}

/* =====================================================================
   DATA LOADING (localStorage + seed geojson, with file:// fallback)
===================================================================== */

const EMBEDDED_SEED = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [88.78, 26.65]}, "properties": {"scheme": "BEUP", "project_code": "BEUP-001", "name": "Construction of Community Hall", "district": "Jalpaiguri", "block": "Mal", "gp": "Sample GP", "village": "Sample Village", "work_type": "Building", "amount": "2500000", "status": "Approved", "sanction_date": "2026-04-15", "completion_date": "", "remarks": "Demo record", "mp_mla": "Shri A. Roy, MP", "id": 1}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [88.72, 26.55]}, "properties": {"scheme": "MPLAD", "project_code": "MPLAD-001", "name": "Improvement of Rural Road", "district": "Jalpaiguri", "block": "Maynaguri", "gp": "Sample GP", "village": "Sample Village", "work_type": "Road", "amount": "1800000", "status": "Ongoing", "sanction_date": "2026-05-20", "completion_date": "", "remarks": "Demo record", "mp_mla": "Smt. B. Sarkar, MLA", "id": 2}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [89.0, 26.58]}, "properties": {"scheme": "BEUP", "project_code": "BEUP-002", "name": "Installation of Drinking Water Facility", "district": "Jalpaiguri", "block": "Dhupguri", "gp": "Sample GP", "village": "Sample Village", "work_type": "Water", "amount": "850000", "status": "Completed", "sanction_date": "2025-08-10", "completion_date": "2026-02-20", "remarks": "Demo record — outside the sample district boundary on purpose", "mp_mla": "Shri A. Roy, MP", "id": 3}}, {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[88.7, 26.6], [88.72, 26.61], [88.74, 26.615], [88.76, 26.62]]}, "properties": {"scheme": "MPLAD", "project_code": "MPLAD-002", "name": "Upgradation of Village Approach Road", "district": "Jalpaiguri", "block": "Mal", "gp": "Sample GP", "village": "Sample Village", "work_type": "Road", "amount": "3200000", "status": "Ongoing", "sanction_date": "2026-03-01", "completion_date": "", "remarks": "Demo line record", "mp_mla": "Smt. B. Sarkar, MLA", "id": 4}}, {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[88.775, 26.645], [88.782, 26.645], [88.782, 26.652], [88.775, 26.652], [88.775, 26.645]]]}, "properties": {"scheme": "BEUP", "project_code": "BEUP-003", "name": "Renovation of Village Pond", "district": "Jalpaiguri", "block": "Mal", "gp": "Sample GP", "village": "Sample Village", "work_type": "Water Body", "amount": "1200000", "status": "Proposed", "sanction_date": "", "completion_date": "", "remarks": "Demo polygon record", "mp_mla": "Shri C. Barman, MLA", "id": 5}}]};

async function loadProjects() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    projects = JSON.parse(stored);
  } else {
    projects = await fetchSeed();
    saveProjects();
  }
  nextId = projects.reduce((m, p) => Math.max(m, +p.id || 0), 0) + 1;
  refreshFilterOptions(true);
  renderAll();
}

async function fetchSeed() {
  try {
    const r = await fetch(SEED_URL, { cache: 'no-store' });
    if (r.ok) return geojsonToProjects(await r.json());
  } catch (e) { /* fall through to embedded fallback */ }
  return geojsonToProjects(EMBEDDED_SEED);
}

const EMBEDDED_DISTRICTS = {"type":"FeatureCollection","features":[{"type":"Feature","properties":{"district":"Jalpaiguri","Gram_Panchayat":"Sample GP"},"geometry":{"type":"Polygon","coordinates":[[[88.60,26.50],[88.85,26.50],[88.85,26.70],[88.60,26.70],[88.60,26.50]]]}}]};

let districtsFC = null, gpLayer = null;

async function loadDistrictBoundaries() {
  let fc = null;
  try {
    const r = await fetch(DISTRICTS_URL, { cache: 'no-store' });
    if (r.ok) fc = await r.json();
  } catch (e) { /* no boundary file reachable (e.g. file://) */ }
  if (!fc || !Array.isArray(fc.features)) fc = EMBEDDED_DISTRICTS;

  districtsFC = fc;
  districtBoundaries = fc.features
    .filter(f => f.geometry && f.geometry.type === 'Polygon')
    .map(f => ({ district: (f.properties || {}).district || '', rings: f.geometry.coordinates }));

  buildGramPanchayatLayer();
}

// Selectable overlay layer (independent of the OSM/Imagery basemap radio
// buttons) built from data/districts.geojson. Displayed as "Gram_Panchayat"
// in the layer toolbar per spec, with each polygon labelled from its
// properties.Gram_Panchayat attribute (skipped when empty/null). Labels are
// only shown within GP_LABEL_MIN_ZOOM..GP_LABEL_MAX_ZOOM via
// updateGpLabelVisibility(); the polygon boundaries themselves are always
// visible when the overlay is on, regardless of zoom. Clicking a boundary
// opens a popup listing all of its attributes.
function buildGramPanchayatLayer() {
  if (!districtsFC) return;
  gpLayer = L.geoJSON(districtsFC, {
    style: { color: '#3454d1', weight: 2, fillOpacity: 0.08, dashArray: '4,3' },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      const label = props.Gram_Panchayat;
      if (label !== undefined && label !== null && String(label).trim() !== '') {
        layer.bindTooltip(esc(String(label)), { permanent: true, direction: 'center', className: 'gp-label' });
      }
      // Click the boundary to see all of its attributes — built generically
      // from whatever properties the feature actually has, nothing hard-coded.
      const rows = Object.keys(props).map(k => `<tr><td class="gp-popup-key">${esc(k)}</td><td>${esc(props[k])}</td></tr>`).join('');
      layer.bindPopup(`<div class="gp-popup"><div class="popup-title">Gram Panchayat / District Boundary</div><table>${rows || '<tr><td>No attributes</td></tr>'}</table></div>`);
    }
  });
  // Off by default; toggled on via the checkbox in the basemap/layer panel.
}

function geojsonToProjects(fc) {
  if (!fc || !Array.isArray(fc.features)) return [];
  return fc.features.map((f, i) => {
    const props = f.properties || {};
    const geom = f.geometry || null;
    let lat = '', lon = '';
    if (geom && geom.type === 'Point') { lon = geom.coordinates[0]; lat = geom.coordinates[1]; }
    return {
      id: props.id ?? (i + 1),
      scheme: props.scheme ?? '',
      project_code: props.project_code ?? '',
      name: props.name ?? '',
      mp_mla: props.mp_mla ?? '',
      district: props.district ?? '',
      block: props.block ?? '',
      gp: props.gp ?? '',
      village: props.village ?? '',
      work_type: props.work_type ?? '',
      amount: props.amount ?? '',
      status: props.status ?? '',
      geometry_type: geom ? geom.type : (props.geometry_type || ''),
      geometry: geom,
      lat, lon,
      sanction_date: props.sanction_date ?? '',
      completion_date: props.completion_date ?? '',
      remarks: props.remarks ?? ''
    };
  });
}

function saveProjects() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

async function resetToSeed() {
  if (!confirm('Discard all local changes and reload the original sample data?')) return;
  localStorage.removeItem(STORAGE_KEY);
  await loadProjects();
}

/* =====================================================================
   OUTSIDE-DISTRICT DETECTION (ray-casting point-in-polygon)
===================================================================== */

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Returns true (outside), false (inside), or null (no boundary on file for
// that district, so it cannot be determined).
function isOutsideDistrict(p) {
  if (!p.district || !p.geometry) return null;
  const boundary = districtBoundaries.find(b => b.district.trim().toLowerCase() === p.district.trim().toLowerCase());
  if (!boundary) return null;
  const [lon, lat] = representativePoint(p.geometry);
  if (lon == null) return null;
  return !boundary.rings.some(ring => pointInRing(lon, lat, ring));
}

function representativePoint(g) {
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'LineString') return g.coordinates[Math.floor(g.coordinates.length / 2)];
  if (g.type === 'Polygon') return g.coordinates[0][0];
  return [null, null];
}

/* =====================================================================
   FILTER OPTIONS (dynamic, derived from project data)
===================================================================== */

function refreshFilterOptions(resetSelections) {
  const districts = [...new Set(projects.map(p => p.district).filter(Boolean))].sort();
  fillSelect('cDistrict', districts, resetSelections);

  const district = val('cDistrict');
  const blocks = [...new Set(projects.filter(p => !district || p.district === district).map(p => p.block).filter(Boolean))].sort();
  fillSelect('cBlock', blocks, resetSelections);

  const block = val('cBlock');
  const gps = [...new Set(projects.filter(p => (!district || p.district === district) && (!block || p.block === block)).map(p => p.gp).filter(Boolean))].sort();
  fillSelect('cGP', gps, resetSelections);

  const mplaList = [...new Set(projects.map(p => p.mp_mla).filter(Boolean))].sort();
  fillSelect('dMPMLA', mplaList, resetSelections);

  const workTypes = [...new Set(projects.map(p => p.work_type).filter(Boolean))].sort();
  fillSelect('dWorkType', workTypes, resetSelections);
}

function fillSelect(id, values, resetSelection) {
  const el = document.getElementById(id);
  const keep = resetSelection ? '' : el.value;
  el.innerHTML = '<option value="">All</option>' + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values.includes(keep)) el.value = keep;
}

function onDistrictChange() {
  refreshFilterOptions(false);
  document.getElementById('cBlock').value = '';
  document.getElementById('cGP').value = '';
  refreshFilterOptions(false);
  zoomToFiltered();
  renderAll();
}
function onBlockChange() {
  document.getElementById('cGP').value = '';
  refreshFilterOptions(false);
  zoomToFiltered();
  renderAll();
}
function onGPChange() { zoomToFiltered(); renderAll(); }

function clearAdminFilters() {
  ['cDistrict', 'cBlock', 'cGP', 'fStatus'].forEach(id => document.getElementById(id).value = '');
  refreshFilterOptions(false);
  map.setView([26.65, 88.78], 9);
  renderAll();
}

function zoomToFiltered() {
  const visible = projects.filter(matchesAdminFilters);
  const pts = [];
  visible.forEach(p => { if (p.geometry) collectLatLngs(p.geometry, pts); });
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
}
function collectLatLngs(g, out) {
  if (g.type === 'Point') out.push([g.coordinates[1], g.coordinates[0]]);
  else if (g.type === 'LineString') g.coordinates.forEach(c => out.push([c[1], c[0]]));
  else if (g.type === 'Polygon') g.coordinates.forEach(r => r.forEach(c => out.push([c[1], c[0]])));
}

/* =====================================================================
   FILTERING + RENDER (single entry point keeps everything in sync)
===================================================================== */

function matchesAdminFilters(p) {
  const district = val('cDistrict'), block = val('cBlock'), gp = val('cGP'), status = val('fStatus');
  if (district && p.district !== district) return false;
  if (block && p.block !== block) return false;
  if (gp && p.gp !== gp) return false;
  if (status && p.status !== status) return false;
  return true;
}
function matchesDashboardFilters(p) {
  const scheme = val('dScheme'), mpmla = val('dMPMLA'), workType = val('dWorkType');
  if (scheme && p.scheme !== scheme) return false;
  if (mpmla && p.mp_mla !== mpmla) return false;
  if (workType && p.work_type !== workType) return false;
  return true;
}
function matchesFilters(p) { return matchesAdminFilters(p) && matchesDashboardFilters(p); }

function renderAll() {
  const visible = projects.filter(matchesFilters);
  Object.values(layers).forEach(l => map.removeLayer(l));
  layers = {};
  visible.forEach(addFeature);
  updateDashboard(visible);
  renderLegend();
}

function addFeature(p) {
  if (!p.geometry || !p.geometry.type) return;
  const g = p.geometry;
  const outside = isOutsideDistrict(p);
  let layer;
  if (g.type === 'Point') {
    layer = L.marker([g.coordinates[1], g.coordinates[0]], { icon: outside ? outsideIcon() : pointIcon(p.work_type) });
  } else if (g.type === 'LineString') {
    layer = L.polyline(g.coordinates.map(c => [c[1], c[0]]), { color: outside ? '#d90429' : colorForWorkType(p.work_type), weight: outside ? 5 : 4, dashArray: outside ? '6,4' : null });
  } else if (g.type === 'Polygon') {
    const rings = g.coordinates.map(ring => ring.map(c => [c[1], c[0]]));
    layer = L.polygon(rings, { color: outside ? '#d90429' : colorForWorkType(p.work_type), weight: 2, fillOpacity: 0.25, dashArray: outside ? '6,4' : null });
  } else if (g.type === 'MultiLineString') {
    layer = L.polyline(g.coordinates.map(line => line.map(c => [c[1], c[0]])), { color: colorForWorkType(p.work_type), weight: 4 });
  } else if (g.type === 'MultiPolygon') {
    const polys = g.coordinates.map(poly => poly.map(ring => ring.map(c => [c[1], c[0]])));
    layer = L.polygon(polys, { color: colorForWorkType(p.work_type), weight: 2, fillOpacity: 0.25 });
  } else { return; }
  layer.addTo(map);
  layer.bindPopup(popupHtml(p, outside));
  layers[p.id] = layer;
}

// Icons are ~40% the size of Leaflet's default marker (25x41 -> ~10x16
// footprint), rendered as small SVG divIcons so we can colour-code by
// work type and keep a distinct outside-district symbol.
function pointIcon(workType) {
  const color = colorForWorkType(workType);
  return L.divIcon({
    className: 'proj-icon',
    html: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}" stroke="#fff" stroke-width="1.5"/></svg>`,
    iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8]
  });
}
function outsideIcon() {
  return L.divIcon({
    className: 'proj-icon outside-icon',
    html: `<svg width="18" height="18" viewBox="0 0 18 18"><polygon points="9,1 17,16 1,16" fill="#d90429" stroke="#fff" stroke-width="1.2"/><text x="9" y="14" font-size="9" text-anchor="middle" fill="#fff">!</text></svg>`,
    iconSize: [18, 18], iconAnchor: [9, 16], popupAnchor: [0, -16]
  });
}

function popupHtml(p, outside) {
  const shape = p.geometry && p.geometry.type !== 'Point' ? ` <i>(${p.geometry.type})</i>` : '';
  const warn = outside ? '<div class="popup-warning">⚠ Outside the mapped district boundary</div>' : '';
  return `<div class="popup-title">${esc(p.name)}${shape}</div>${warn}<b>${esc(p.scheme)}</b> | ${esc(p.status)}<br>Project ID: ${esc(p.project_code)}<br>MP/MLA: ${esc(p.mp_mla||'—')}<br>Amount: ₹${num(p.amount)}<br>${esc(p.district||'')} ${esc(p.block||'')} ${esc(p.gp||'')}<br><button class="action-btn role-admin ${isAdminNow()?'':'hidden'}" onclick="editProject(${p.id})">Edit</button> <button class="action-btn role-admin ${isAdminNow()?'':'hidden'}" onclick="deleteProject(${p.id})">Delete</button>`;
}
function isAdminNow() { return !!currentUser && currentUser.role === 'admin'; }

/* =====================================================================
   DASHBOARD
===================================================================== */

function updateDashboard(list) {
  const rows = list || projects;
  document.getElementById('total').textContent = rows.length;
  const statuses = ['Proposed', 'Approved', 'Ongoing', 'Completed'];
  document.getElementById('statusBreakdown').innerHTML = statuses.map(s =>
    `<div class="stat-row small"><b>${rows.filter(x => x.status === s).length}</b><span>${s}</span></div>`).join('');
  const total = rows.reduce((s, x) => s + (parseFloat(x.amount) || 0), 0);
  document.getElementById('cost').textContent = '₹' + total.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/* =====================================================================
   CRUD
===================================================================== */

function openProject(p = null) {
  if (!requireRole('any-logged-in')) return;
  document.getElementById('projectModal').classList.remove('hidden');
  document.getElementById('modalTitle').textContent = p && p.id ? 'Edit Project' : 'Add Project';
  document.getElementById('projectForm').reset();
  document.getElementById('id').value = '';

  formGeometry = pendingGeometry || (p && p.geometry) || null;
  pendingGeometry = null;

  if (p) Object.keys(p).forEach(k => {
    if (k === 'geometry') return;
    const e = document.getElementById(k);
    if (e) e.value = p[k] ?? '';
  });

  updateGeometryUI();
}
function closeProject() { document.getElementById('projectModal').classList.add('hidden'); }
function editProject(id) {
  if (!requireRole('admin')) return;
  const p = projects.find(x => x.id == id);
  if (p) openProject(p);
}

function updateGeometryUI() {
  const info = document.getElementById('geomInfo');
  const latRow = document.getElementById('latRow');
  const lonRow = document.getElementById('lonRow');
  if (!formGeometry || formGeometry.type === 'Point') {
    latRow.style.display = ''; lonRow.style.display = '';
    if (formGeometry && formGeometry.type === 'Point') {
      document.getElementById('lat').value = formGeometry.coordinates[1];
      document.getElementById('lon').value = formGeometry.coordinates[0];
    }
    info.textContent = '';
  } else {
    latRow.style.display = 'none'; lonRow.style.display = 'none';
    const n = formGeometry.type === 'Polygon' ? formGeometry.coordinates[0].length : formGeometry.coordinates.length;
    info.textContent = `Shape captured: ${formGeometry.type} (${n} vertices). Click "Save Project" to keep it, or "Draw / Redraw Shape" to replace it.`;
  }
}

function requestRedraw() {
  const draft = {};
  [...document.querySelectorAll('#projectForm input,#projectForm select,#projectForm textarea')].forEach(x => { if (x.id) draft[x.id] = x.value; });
  redrawDraft = draft;
  closeProject();
  alert('Use the drawing toolbar in the top-left of the map to draw a point, line, or polygon. Your other project details have been kept.');
}
function clearGeometry() {
  formGeometry = null;
  document.getElementById('lat').value = '';
  document.getElementById('lon').value = '';
  updateGeometryUI();
}

function deleteProject(id) {
  if (!requireRole('admin')) return;
  if (!confirm('Delete this project?')) return;
  projects = projects.filter(p => p.id != id);
  saveProjects();
  refreshFilterOptions(false);
  renderAll();
}

function onSubmitProject(e) {
  e.preventDefault();
  const data = {};
  [...e.target.querySelectorAll('input,select,textarea')].forEach(x => { if (x.id) data[x.id] = x.value; });

  let geometry = (formGeometry && formGeometry.type !== 'Point') ? formGeometry : null;
  if (!geometry) {
    if (data.lat !== '' && data.lon !== '') {
      geometry = { type: 'Point', coordinates: [parseFloat(data.lon), parseFloat(data.lat)] };
    } else { geometry = null; }
  }
  if (!geometry) { alert('Please set a location: click the map, type latitude/longitude, or draw a shape.'); return; }

  data.geometry = geometry;
  data.geometry_type = geometry.type;
  if (geometry.type !== 'Point') { data.lat = ''; data.lon = ''; }

  if (data.id) {
    if (!requireRole('admin')) return;
    const idx = projects.findIndex(pr => pr.id == data.id);
    if (idx === -1) return alert('Save failed: record not found');
    data.id = +data.id;
    projects[idx] = { ...projects[idx], ...data };
  } else {
    data.id = nextId++;
    projects.unshift(data);
  }
  formGeometry = null;
  saveProjects();
  refreshFilterOptions(false);
  closeProject();
  renderAll();
}

/* =====================================================================
   ATTRIBUTE TABLE
===================================================================== */

function openTable() {
  if (!requireRole('admin')) return;
  const t = document.getElementById('projectTable');
  const cols = ['id', 'scheme', 'project_code', 'name', 'mp_mla', 'district', 'block', 'gp', 'village', 'work_type', 'amount', 'status', 'geometry_type', 'lat', 'lon', 'sanction_date', 'completion_date', 'remarks'];
  t.innerHTML = '<tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '<th>Action</th></tr>' +
    projects.map(p => '<tr>' + cols.map(c => '<td>' + esc(p[c] ?? '') + '</td>').join('') + '<td><button class="action-btn" onclick="closeTable();editProject(' + p.id + ')">Edit</button></td></tr>').join('');
  document.getElementById('tableModal').classList.remove('hidden');
}
function closeTable() { document.getElementById('tableModal').classList.add('hidden'); }

/* =====================================================================
   IMPORT / EXPORT
===================================================================== */

function exportGeoJSON() {
  if (!requireRole('admin')) return;
  const fc = {
    type: 'FeatureCollection',
    features: projects.filter(p => p.geometry).map(p => {
      const { geometry, lat, lon, ...properties } = p;
      return { type: 'Feature', geometry, properties };
    })
  };
  download(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' }), 'beup_mplad_projects.geojson');
}

function downloadCSV() {
  if (!requireRole('admin')) return;
  const cols = ['scheme', 'project_code', 'name', 'mp_mla', 'district', 'block', 'gp', 'village', 'work_type', 'amount', 'status', 'geometry_type', 'lat', 'lon', 'geometry', 'sanction_date', 'completion_date', 'remarks'];
  const csv = [cols.join(','), ...projects.map(p => cols.map(c => csvCell(c === 'geometry' ? (p.geometry ? JSON.stringify(p.geometry) : '') : p[c])).join(','))].join('\n');
  download(new Blob([csv], { type: 'text/csv' }), 'beup_mplad_projects.csv');
}

async function importCSV(input) {
  if (!requireRole('admin')) { input.value = ''; return; }
  const file = input.files[0]; if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) { alert('CSV has no records'); return; }
  const headers = rows[0].map(x => x.trim());
  let count = 0;
  for (const row of rows.slice(1)) {
    if (row.every(c => c === '')) continue;
    const obj = { id: nextId++ };
    headers.forEach((h, i) => obj[h] = row[i] ?? '');
    if (obj.geometry) {
      try { obj.geometry = JSON.parse(obj.geometry); obj.geometry_type = obj.geometry.type; }
      catch (e) { obj.geometry = null; }
    } else if (obj.lat !== '' && obj.lon !== '' && obj.lat != null && obj.lon != null) {
      obj.geometry = { type: 'Point', coordinates: [parseFloat(obj.lon), parseFloat(obj.lat)] };
      obj.geometry_type = 'Point';
    } else { obj.geometry = null; }
    projects.unshift(obj);
    count++;
  }
  saveProjects();
  alert(count + ' records imported');
  input.value = '';
  refreshFilterOptions(false);
  renderAll();
}

async function importGeoJSON(input) {
  if (!requireRole('admin')) { input.value = ''; return; }
  const file = input.files[0]; if (!file) return;
  try {
    const fc = JSON.parse(await file.text());
    const imported = geojsonToProjects(fc).map(p => ({ ...p, id: nextId++ }));
    projects = imported.concat(projects);
    saveProjects();
    alert(imported.length + ' records imported');
    input.value = '';
    refreshFilterOptions(false);
    renderAll();
  } catch (e) {
    alert('Could not read that file as GeoJSON: ' + e.message);
  }
}

function parseCSV(text) {
  return text.trim().split(/\r?\n/).map(line => {
    let a = [], cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      let c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { a.push(cur); cur = ''; }
      else cur += c;
    }
    a.push(cur);
    return a;
  });
}

/* =====================================================================
   COORDINATE VIEW TOOL (temporary blinking marker — never touches data)
===================================================================== */

function goToCoordinates() {
  const lat = parseFloat(document.getElementById('viewLat').value);
  const lon = parseFloat(document.getElementById('viewLon').value);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    alert('Invalid coordinates. Please enter valid latitude and longitude values.');
    return;
  }
  if (goToMarker) { map.removeLayer(goToMarker); goToMarker = null; }
  if (goToBlinkTimer) { clearTimeout(goToBlinkTimer); goToBlinkTimer = null; }

  goToMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'goto-icon', html: '<div class="pulse-ring"></div><div class="pulse-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] })
  }).addTo(map);
  goToMarker.bindPopup(`Coordinate View<br>Latitude: ${lat.toFixed(6)}<br>Longitude: ${lon.toFixed(6)}`).openPopup();
  map.setView([lat, lon], 15);

  goToBlinkTimer = setTimeout(() => { if (goToMarker) { map.removeLayer(goToMarker); goToMarker = null; } }, 30000);
}

/* =====================================================================
   CURRENT LOCATION (browser Geolocation API)
===================================================================== */

function useMyLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by this browser/device.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (myLocationMarker) map.removeLayer(myLocationMarker);
      if (myLocationAccuracyCircle) map.removeLayer(myLocationAccuracyCircle);

      myLocationMarker = L.marker([latitude, longitude], {
        icon: L.divIcon({ className: 'myloc-icon', html: '<div class="myloc-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
      }).addTo(map);

      if (accuracy) {
        myLocationAccuracyCircle = L.circle([latitude, longitude], { radius: accuracy, color: '#1d4ed8', fillOpacity: 0.08, weight: 1 }).addTo(map);
      }

      myLocationMarker.on('click', () => {
        document.getElementById('locInfoBody').innerHTML =
          `Latitude: ${latitude.toFixed(6)}<br>Longitude: ${longitude.toFixed(6)}` +
          (accuracy ? `<br>Accuracy: ${Math.round(accuracy)} metres` : '');
        document.getElementById('locInfoModal').classList.remove('hidden');
      });

      map.setView([latitude, longitude], 15);
    },
    err => {
      if (err.code === err.PERMISSION_DENIED) alert('Location permission was denied. Please enable location access in your browser to use this function.');
      else alert('Unable to determine your current location. Please check your device location settings and browser permissions.');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}
function closeLocInfo() { document.getElementById('locInfoModal').classList.add('hidden'); }

/* =====================================================================
   VISITOR COUNTER
   Purely static hosting has no server to count visits centrally. This
   tries a free, keyless counter API (CountAPI) so the number is shared
   across all visitors; if that's unreachable (offline, blocked, or the
   service is down) it falls back to a local-only, per-browser count so
   the UI never breaks. Set your own unique NAMESPACE before deploying so
   your count isn't shared with other sites using the same demo namespace.
===================================================================== */

const VISITOR_NAMESPACE = 'beup-mplad-webgis-demo'; // change this to something unique for your deployment
const VISITOR_KEY = 'visits';

async function updateVisitorCounter() {
  try {
    const r = await fetch(`https://api.countapi.xyz/hit/${VISITOR_NAMESPACE}/${VISITOR_KEY}`);
    if (r.ok) { const d = await r.json(); document.getElementById('visitorCount').textContent = pad(d.value); return; }
    throw new Error('bad response');
  } catch (e) {
    const n = (parseInt(localStorage.getItem('local_visit_count') || '0', 10)) + 1;
    localStorage.setItem('local_visit_count', n);
    document.getElementById('visitorCount').textContent = pad(n) + ' (local only)';
  }
}
function pad(n) { return String(n).padStart(6, '0'); }

/* =====================================================================
   HELPERS
===================================================================== */

function csvCell(v) { v = v ?? ''; return '"' + String(v).replaceAll('"', '""') + '"'; }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
function val(id) { return document.getElementById(id).value; }
function num(v) { return (parseFloat(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function esc(v) { return String(v).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])); }
