/* ---------------------------------------------------------------
   LEC Rollout Coverage
   A signed-in web app. All data (households, transformers, coverage
   polygons, gateway layers) lives in Supabase and is loaded after
   sign-in; nothing sensitive ships with these files.
----------------------------------------------------------------*/
(() => {
const $ = id => document.getElementById(id);

/* ---- tiny persistence, safe in every context ---- */
const store = {
  get(k, d){ try { const v = localStorage.getItem('lce.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v){ try { localStorage.setItem('lce.' + k, JSON.stringify(v)); } catch (e) {} }
};
const savedTheme = store.get('theme', null);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

/* ---- sign-in gate ---- */
const cfg = window.APP_CONFIG || {};
const client = window.supabase && cfg.supabaseUrl && cfg.supabaseKey
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;
const gate = $('gate'), signinForm = $('signin'), loadingBox = $('loading');
function showSignIn(msg){
  gate.hidden = false; signinForm.hidden = false; loadingBox.hidden = true;
  $('gatemsg').textContent = msg || '';
}
function showLoading(msg, failed){
  gate.hidden = false; signinForm.hidden = true; loadingBox.hidden = false;
  $('loadmsg').textContent = msg;
  loadingBox.classList.toggle('failed', !!failed);
}
signinForm.onsubmit = async e => {
  e.preventDefault();
  const btn = signinForm.querySelector('button');
  btn.disabled = true; $('gatemsg').textContent = '';
  const { data, error } = await client.auth.signInWithPassword({
    email: signinForm.email.value.trim(), password: signinForm.password.value
  });
  btn.disabled = false;
  if (error) { showSignIn(error.message); return; }
  signinForm.password.value = '';
  enter(data.user);
};
async function signOut(){
  try { await client.auth.signOut(); } catch (e) {}
  location.reload();
}
$('loadretry').onclick = () => boot();
$('loadsignout').onclick = signOut;

/* ---- data ---- */
async function loadData(sb){
  const q = async p => { const { data, error } = await p; if (error) throw error; return data; };
  const [hh, tr, cov, meta] = await Promise.all([
    q(sb.rpc('households_packed')),
    q(sb.from('transformers').select('code,idx,name,feeder,lat,lng').order('idx')),
    q(sb.storage.from('app-data').download('coverage.json')).then(blob => blob.text()).then(JSON.parse),
    q(sb.from('app_meta').select('key,value'))
  ]);
  if (!hh || !hh.n || !tr.length || !cov.features || !cov.features.length)
    throw new Error('The map data has not been loaded into the database yet.');
  const m = {};
  meta.forEach(r => { m[r.key] = r.value; });
  const pos = new Map(tr.map((t, i) => [t.idx, i]));
  const transformers = tr.map(t => ({ code: t.code, name: t.name, feeder: t.feeder, lat: t.lat, lng: t.lng, n: 0, ex: 0, no3g: 0 }));
  const n = hh.n;
  const flags = Uint8Array.from(hh.cov), status = Uint8Array.from(hh.met);
  const tidx = Uint16Array.from(hh.tr, v => pos.get(v));
  for (let i = 0; i < n; i++){
    const t = transformers[tidx[i]];
    t.n++; if (status[i]) t.ex++; if (!(flags[i] & 18)) t.no3g++;
  }
  return {
    COVERAGE: cov,
    METERS: {
      lat0: hh.lat0, lng0: hh.lng0, n: n, id: hh.id,
      lat: Uint32Array.from(hh.lat), lng: Uint32Array.from(hh.lng),
      flags: flags, status: status, tidx: tidx,
      transformers: transformers, substation: m.substation, generatedAt: m.generated_at
    },
    briefHtml: m.brief_html
  };
}
async function enter(user){
  showLoading('Loading map data…');
  let data;
  try { data = await loadData(client); }
  catch (e) { showLoading('Could not load the map data. ' + (e.message || e), true); return; }
  gate.hidden = true;
  $('app').hidden = false;
  startApp(data, user, client);
}
async function boot(){
  if (!client) { showLoading('The app could not start because its sign-in library did not load. Check your connection and reload.', true); return; }
  showLoading('Starting…');
  const { data } = await client.auth.getSession();
  if (data.session) enter(data.session.user); else showSignIn();
}

/* ---- the app itself, started once the data is in ---- */
function startApp(data, user, sb){
const COVERAGE = data.COVERAGE, METERS = data.METERS;
$('whoami').textContent = user ? user.email : '';
$('signout').onclick = async () => {
  try { await pushChain; } catch (e) {}
  signOut();
};
$('stsource').textContent = 'LECMS ' + METERS.n.toLocaleString('en-GB') + ' households · GSMA z7 · Orange 2017 · Lonestar 2018';

/* ---------------------------------------------------------------
   Map, coverage layers and point probe
   Data: GSMA / Collins Bartholomew operator submissions, decoded
   from the Mapbox vector tilesets behind gsma.com/coverage.
----------------------------------------------------------------*/
const STYLES = {
  'Orange|GSM':            {c:'#F7C393', w:0.7, label:'GSM',  note:'2G'},
  'Orange|3G':             {c:'#E9761C', w:1.1, label:'3G',   note:'UMTS'},
  'Orange|LTE':            {c:'#A93A05', w:1.3, label:'LTE',  note:'4G'},
  'LonestarCell MTN|GSM':  {c:'#9FD0E0', w:0.7, label:'GSM',  note:'2G'},
  'LonestarCell MTN|3G':   {c:'#2A8DA8', w:1.1, label:'3G',   note:'UMTS'},
  'LonestarCell MTN|LTE':  {c:'#08475A', w:1.3, label:'LTE',  note:'4G'}
};
const PLACES = [
  ['Monrovia', 6.3106, -10.8047, 11],
  ['Gbarnga', 6.9956, -9.4722, 11],
  ['Buchanan', 5.8808, -10.0467, 11],
  ['Harper', 4.3750, -7.7169, 11],
  ['Voinjama', 8.4219, -9.7478, 11]
];
const BASEMAPS = [
  ['Streets', 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', 19],
  ['Humanitarian', 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles by HOT', 19],
  ['Muted', 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO', 19],
  ['Dark', 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO', 19]
];

/* ---- geometry helpers ---- */
function ringArea(cs){
  const R = 6371.0088, rad = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < cs.length - 1; i++){
    const a = cs[i], b = cs[i + 1];
    s += (b[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(b[1] * rad));
  }
  return Math.abs(s * R * R / 2);
}
function areaKm2(geom){
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let t = 0;
  for (const p of polys){ t += ringArea(p[0]); for (let i = 1; i < p.length; i++) t -= ringArea(p[i]); }
  return t;
}
function countParts(geom){
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let v = 0;
  for (const p of polys) for (const r of p) v += r.length;
  return { parts: polys.length, verts: v };
}
function inRing(lng, lat, ring){
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function covers(geom, lng, lat){
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const p of polys){
    if (!inRing(lng, lat, p[0])) continue;
    let hole = false;
    for (let i = 1; i < p.length; i++) if (inRing(lng, lat, p[i])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
const fmt = n => Math.round(n).toLocaleString('en-GB');

/* ---- map ---- */
const map = L.map('map', { zoomControl: true, attributionControl: true, minZoom: 5 })
             .setView([6.45, -9.4], 7);
L.control.scale({ imperial: false }).addTo(map);

let baseLayer = null;
const segBase = document.getElementById('basemaps');
function setBasemap(i){
  if (baseLayer) map.removeLayer(baseLayer);
  const b = BASEMAPS[i];
  baseLayer = L.tileLayer(b[1], { attribution: b[2], maxZoom: b[3] }).addTo(map);
  baseLayer.setZIndex(0);
  [...segBase.children].forEach((el, j) => el.setAttribute('aria-pressed', String(j === i)));
  store.set('basemap', i);
}
BASEMAPS.forEach((b, i) => {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = b[0]; btn.setAttribute('aria-pressed', 'false');
  btn.onclick = () => setBasemap(i);
  segBase.appendChild(btn);
});
setBasemap(store.get('basemap', 0));

/* ---- coverage layers ---- */
const entries = [];
const byOperator = {};
COVERAGE.features.forEach(f => {
  (byOperator[f.properties.operator] = byOperator[f.properties.operator] || []).push(f);
});
const TECH_ORDER = { GSM: 0, '3G': 1, LTE: 2 };
const railEl = document.getElementById('controls');
const DEFAULT_ON = ['Orange|3G', 'LonestarCell MTN|3G'];
const savedOn = store.get('layers', null);

Object.keys(byOperator).sort().forEach(op => {
  const feats = byOperator[op].sort((a, b) =>
    TECH_ORDER[a.properties.technology] - TECH_ORDER[b.properties.technology]);

  const block = document.createElement('div');
  block.className = 'opblock';
  const head = document.createElement('div');
  head.className = 'ophead';
  head.innerHTML = '<span class="nm">' + feats[0].properties.operator_full + '</span>';
  const allBtn = document.createElement('button');
  allBtn.className = 'allbtn'; allBtn.type = 'button'; allBtn.textContent = 'hide all';
  head.appendChild(allBtn);
  block.appendChild(head);

  const list = document.createElement('div');
  feats.forEach(f => {
    const key = op + '|' + f.properties.technology;
    const st = STYLES[key];
    const a = areaKm2(f.geometry);
    const c = countParts(f.geometry);

    const layer = L.geoJSON(f, {
      style: { color: st.c, weight: st.w, opacity: 0.95, fillColor: st.c, fillOpacity: 0.42 },
      interactive: true
    });
    layer.bindPopup(
      '<b>' + f.properties.operator_full + '</b><br>' +
      f.properties.technology + ' &middot; submitted ' + f.properties.data_year + '<br>' +
      fmt(a) + ' km&sup2; &middot; ' + c.parts + ' part' + (c.parts === 1 ? '' : 's')
    );

    const on = (savedOn || DEFAULT_ON).indexOf(key) !== -1;
    if (on) layer.addTo(map);

    const btn = document.createElement('button');
    btn.className = 'lyr'; btn.type = 'button';
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML =
      '<span class="sw" style="background:' + st.c + ';border-color:' + st.c + '"></span>' +
      '<span class="lname">' + st.label + '<em>' + st.note + '</em></span>' +
      '<span class="lval">' + fmt(a) + ' km&sup2;</span>';

    const rec = { key: key, op: op, feature: f, layer: layer, btn: btn, style: st, area: a, on: on };
    btn.onclick = () => setLayer(rec, !rec.on);
    list.appendChild(btn);
    entries.push(rec);
  });

  allBtn.onclick = () => {
    const mine = entries.filter(e => e.op === op);
    const turnOff = mine.some(e => e.on);
    mine.forEach(e => setLayer(e, !turnOff));
  };
  block.appendChild(list);
  railEl.appendChild(block);
});

function restack(){
  entries.slice().sort((a, b) => b.area - a.area)
    .forEach(e => { if (e.on) e.layer.bringToFront(); });
}
function setLayer(rec, on){
  rec.on = on;
  rec.btn.setAttribute('aria-pressed', String(on));
  if (on) rec.layer.addTo(map); else map.removeLayer(rec.layer);
  restack();
  syncAll();
}
function syncAll(){
  const on = entries.filter(e => e.on);
  document.getElementById('stvis').textContent = on.length + ' of ' + entries.length;
  const ops = {};
  entries.forEach(e => { ops[e.op] = ops[e.op] || []; ops[e.op].push(e); });
  [...railEl.querySelectorAll('.allbtn')].forEach((b, i) => {
    const op = Object.keys(ops).sort()[i];
    b.textContent = ops[op].some(e => e.on) ? 'hide all' : 'show all';
  });
  store.set('layers', on.map(e => e.key));
  refreshProbe();
}

/* ---- opacity ---- */
const opInput = document.getElementById('opacity');
const opOut = document.getElementById('opacityval');
function applyOpacity(v){
  opOut.textContent = v + '%';
  entries.forEach(e => e.layer.setStyle({ fillOpacity: v / 100 }));
  store.set('opacity', v);
}
opInput.value = store.get('opacity', 24);
opInput.addEventListener('input', () => applyOpacity(+opInput.value));
applyOpacity(+opInput.value);

/* ---- point probe ---- */
const probeEl = document.getElementById('probe');
let probePoint = null, probeMarker = null;

function refreshProbe(){
  if (!probePoint){
    probeEl.innerHTML = '<p class="hint">Click the map to test a location against every loaded layer.</p>';
    return;
  }
  const lat = probePoint.lat, lng = probePoint.lng;
  const rows = entries.map(e => {
    const hit = covers(e.feature.geometry, lng, lat);
    return '<li><span class="dot" style="background:' + (hit ? e.style.c : 'transparent') +
           ';border:1.5px solid ' + (hit ? e.style.c : 'var(--line-2)') + '"></span>' +
           '<span' + (hit ? '' : ' class="no"') + '>' +
           e.feature.properties.operator_full.replace(' Liberia', '') + ' ' + e.style.label +
           (hit ? '' : ' — no coverage') + '</span></li>';
  }).join('');
  const anyHit = entries.some(e => covers(e.feature.geometry, lng, lat));
  probeEl.innerHTML =
    '<p class="coord">' + lat.toFixed(5) + ', ' + lng.toFixed(5) + '</p>' +
    (anyHit ? '<ul>' + rows + '</ul>'
            : '<p class="none">No submitted coverage from either operator at this point.</p><ul>' + rows + '</ul>');
}

function setProbe(latlng){
  probePoint = latlng;
  if (probeMarker) map.removeLayer(probeMarker);
  probeMarker = L.circleMarker(latlng, {
    radius: 5, color: 'var(--ink)', weight: 2, fillColor: '#fff', fillOpacity: 1, className: 'probe-pin'
  }).addTo(map);
  probeMarker.setStyle({ color: getComputedStyle(document.body).color });
  refreshProbe();
}
map.on('click', e => {
  if (placingLayer) { map.closePopup(); addGateway(placingLayer, e.latlng); }
  else setProbe(e.latlng);
});

/* ---- status bar ---- */
const stCursor = document.getElementById('stcursor'), stZoom = document.getElementById('stzoom');
map.on('mousemove', e => { stCursor.textContent = e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4); });
map.on('mouseout', () => { stCursor.textContent = '—'; });
map.on('zoomend', () => { stZoom.textContent = map.getZoom(); });

/* ---- go to ---- */
const placesEl = document.getElementById('places');
PLACES.forEach(p => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = p[0];
  b.onclick = () => { map.setView([p[1], p[2]], p[3]); setProbe(L.latLng(p[1], p[2])); };
  placesEl.appendChild(b);
});
const coordIn = document.getElementById('coordin');
function jump(){
  const m = coordIn.value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m){ coordIn.value = ''; coordIn.placeholder = 'Use: lat, lon'; return; }
  const ll = L.latLng(parseFloat(m[1]), parseFloat(m[2]));
  map.setView(ll, Math.max(map.getZoom(), 10));
  setProbe(ll);
}
document.getElementById('gobtn').onclick = jump;
coordIn.addEventListener('keydown', e => { if (e.key === 'Enter') jump(); });

/* ---- view + export ---- */
const FULL = L.geoJSON(COVERAGE).getBounds();
function fit(){ map.fitBounds(FULL, { padding: [16, 16] }); }
document.getElementById('fitbtn').onclick = fit;
fit();

document.getElementById('dlvisible').onclick = () => {
  const on = entries.filter(e => e.on);
  if (!on.length) return;
  const fc = {
    type: 'FeatureCollection',
    name: 'Liberia mobile coverage (GSMA) — selected layers',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: on.map(e => e.feature)
  };
  const blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'liberia_coverage_selected.geojson';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};

/* ---- theme ---- */
const themeBtn = document.getElementById('themebtn');
function applyTheme(t){
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  store.set('theme', t);
  if (probeMarker) probeMarker.setStyle({ color: getComputedStyle(document.body).color });
}
applyTheme(store.get('theme', null));
themeBtn.onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'light' : 'dark');
};

restack();
syncAll();

/* ---------------------------------------------------------------
   LECMS meter overlay
   Household points and transformer sites from the LEC Management
   System, each tested against the six coverage polygons.
----------------------------------------------------------------*/
const M = { n: METERS.n, lat: METERS.lat, lng: METERS.lng, flags: METERS.flags, status: METERS.status, tidx: METERS.tidx };
const latOf = i => METERS.lat0 + M.lat[i] / 1e6;
const lngOf = i => METERS.lng0 + M.lng[i] / 1e6;
const BIT = { orGsm: 1, or3g: 2, orLte: 4, lsGsm: 8, ls3g: 16, lsLte: 32 };

/* ---- feeders ----
   The number in front of the transformer part of a code is its feeder:
   PAYN-SUB-22KV-02-TRN86 is on feeder 02. Every household belongs to
   its transformer's feeder. */
const FEEDER_COLORS = ['#2A78D6', '#D55181', '#008300', '#4A3AA7', '#EDA100', '#1BAF7A'];
const NO_FEEDER_COLOR = '#7B8A8E';
const feederNo = t => {
  const m = /-(\d+)-[A-Z]+\d+$/.exec(t.code || '') || /-(\d+)$/.exec(t.feeder || '');
  return m ? m[1] : '';
};
const feederNos = [...new Set(METERS.transformers.map(feederNo))].sort((a, b) => (a === '') - (b === '') || a - b);
const feedersOff = store.get('feedersOff', []);
const FEEDERS = feederNos.map((no, k) => ({
  no: no, name: no ? 'Feeder ' + no : 'No feeder in code', full: '',
  color: no && FEEDER_COLORS[k] || NO_FEEDER_COLOR,
  tr: 0, hh: 0, on: feedersOff.indexOf(no) === -1, group: L.layerGroup()
}));
const trFeeder = METERS.transformers.map(t => {
  const k = feederNos.indexOf(feederNo(t)), f = FEEDERS[k];
  f.tr++; f.hh += t.n; if (!f.full) f.full = t.feeder || '';
  return k;
});
const hhFeeder = Uint8Array.from(M.tidx, v => trFeeder[v]);

const VIEWS = [
  { id: 'all',    name: 'All households',            desc: 'existing meter vs not yet metered',
    test: () => true,
    color: i => M.status[i] ? '#2A8DA8' : '#8FA3A8' },
  { id: 'feeder', name: 'By feeder',                 desc: 'coloured by the feeder each household is on',
    test: () => true,
    color: i => FEEDERS[hhFeeder[i]].color },
  { id: 'no3g',   name: 'No 3G from either operator', desc: 'outside both 3G footprints',
    test: i => !(M.flags[i] & (BIT.or3g | BIT.ls3g)), color: () => '#C2410C' },
  { id: 'nolsl',  name: 'Outside Lonestar LTE',       desc: 'Orange LTE only',
    test: i => !(M.flags[i] & BIT.lsLte), color: () => '#E9761C' },
  { id: 'norl',   name: 'Outside Orange LTE',         desc: 'Lonestar LTE only',
    test: i => !(M.flags[i] & BIT.orLte), color: () => '#7A3BAF' },
  { id: 'onelte', name: 'LTE from one operator only',  desc: 'no dual-network fallback',
    test: i => { const a = !!(M.flags[i] & BIT.orLte), b = !!(M.flags[i] & BIT.lsLte); return a !== b; },
    color: i => (M.flags[i] & BIT.orLte) ? '#E9761C' : '#7A3BAF' },
  { id: 'none',   name: 'Hide meters',                desc: '',
    test: () => false, color: () => '#000' }
];
/* counts and the drawn points only include feeders that are switched on */
const viewCount = {};
function countViews(){
  VIEWS.forEach(v => { let c = 0; for (let i = 0; i < M.n; i++) if (FEEDERS[hhFeeder[i]].on && v.test(i)) c++; viewCount[v.id] = c; });
}
countViews();
let activeView = VIEWS.find(v => v.id === store.get('view', 'no3g')) || VIEWS[2];
let visibleIdx = [];
function rebuildIndex(){
  visibleIdx = [];
  for (let i = 0; i < M.n; i++) if (FEEDERS[hhFeeder[i]].on && activeView.test(i)) visibleIdx.push(i);
  document.getElementById('stmeters').textContent =
    activeView.id === 'none' ? 'hidden' : visibleIdx.length.toLocaleString('en-GB') + ' shown';
}

/* ---- canvas overlay ---- */
const MeterCanvas = L.Layer.extend({
  onAdd(map){
    this._map = map;
    this._c = L.DomUtil.create('canvas', 'meter-canvas');
    map.getPanes().overlayPane.appendChild(this._c);
    map.on('move zoom resize zoomend moveend viewreset', this._schedule, this);
    this._schedule();
  },
  onRemove(map){
    map.off('move zoom resize zoomend moveend viewreset', this._schedule, this);
    L.DomUtil.remove(this._c);
  },
  _schedule(){
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  },
  _draw(){
    const map = this._map, c = this._c, size = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== size.x * dpr || c.height !== size.y * dpr){
      c.width = size.x * dpr; c.height = size.y * dpr;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
    }
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (activeView.id === 'none') return;
    const z = map.getZoom();
    const r = z >= 16 ? 4 : z >= 15 ? 3 : z >= 13 ? 2 : 1.6;
    const bounds = map.getBounds().pad(0.05);
    ctx.globalAlpha = z >= 14 ? 0.9 : 0.75;
    let last = null;
    for (const i of visibleIdx){
      const la = latOf(i), ln = lngOf(i);
      if (la < bounds.getSouth() || la > bounds.getNorth() ||
          ln < bounds.getWest()  || ln > bounds.getEast()) continue;
      const p = map.latLngToContainerPoint([la, ln]);
      const col = activeView.color(i);
      if (col !== last){ ctx.fillStyle = col; last = col; }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
});
const meterCanvas = new MeterCanvas();
rebuildIndex();
meterCanvas.addTo(map);

/* ---- view picker ---- */
const viewsEl = document.getElementById('views');
VIEWS.forEach(v => {
  const b = document.createElement('button');
  b.className = 'vw'; b.type = 'button';
  b.setAttribute('aria-pressed', String(v.id === activeView.id));
  b.title = v.desc;
  b.innerHTML = '<span class="rd"></span><span class="vn">' + v.name + '</span><span class="vc"></span>';
  b.onclick = () => {
    activeView = v; store.set('view', v.id);
    [...viewsEl.children].forEach((el, k) => el.setAttribute('aria-pressed', String(VIEWS[k].id === v.id)));
    rebuildIndex(); meterCanvas._schedule(); renderKey();
  };
  viewsEl.appendChild(b);
});
function paintViewCounts(){
  [...viewsEl.children].forEach((el, k) => {
    el.querySelector('.vc').textContent = VIEWS[k].id === 'none' ? '' : viewCount[VIEWS[k].id].toLocaleString('en-GB');
  });
}
paintViewCounts();
function renderKey(){
  const k = document.getElementById('meterkey');
  if (activeView.id === 'all')
    k.innerHTML = '<span><i style="background:#2A8DA8"></i>existing meter</span><span><i style="background:#8FA3A8"></i>not yet metered</span>';
  else if (activeView.id === 'feeder')
    k.innerHTML = FEEDERS.filter(f => f.on).map(f => '<span><i style="background:' + f.color + '"></i>' + f.name + '</span>').join('');
  else if (activeView.id === 'onelte')
    k.innerHTML = '<span><i style="background:#E9761C"></i>Orange LTE only</span><span><i style="background:#7A3BAF"></i>Lonestar LTE only</span>';
  else if (activeView.id === 'none') k.innerHTML = '';
  else k.innerHTML = '<span>' + activeView.desc + '</span>';
}
renderKey();

/* ---- KPIs ---- */
let noneCovered3g = METERS.transformers.reduce((s, t) => s + t.no3g, 0);
document.getElementById('kpis').innerHTML =
  '<div class="kpi"><div class="n">' + M.n.toLocaleString('en-GB') + '</div><div class="l">Households</div></div>' +
  '<div class="kpi"><div class="n">' + METERS.transformers.length + '</div><div class="l">Transformers</div></div>' +
  '<div class="kpi"><div class="n">100%</div><div class="l">2G · LTE reach</div></div>' +
  '<div class="kpi alert"><div class="n">' + noneCovered3g.toLocaleString('en-GB') + '</div><div class="l">No 3G at all</div></div>';
document.getElementById('asof').textContent =
  new Date(METERS.generatedAt).toISOString().slice(0, 10);

/* ---- transformers and substation ---- */
const trLayer = L.layerGroup();
METERS.transformers.forEach((t, k) => {
  const share = t.n ? t.no3g / t.n : 0;
  const f = FEEDERS[trFeeder[k]];
  L.circleMarker([t.lat, t.lng], {
    radius: Math.max(4, Math.min(16, Math.sqrt(t.n) * 0.75)),
    color: f.color, weight: 1.8, fillColor: f.color, fillOpacity: 0.3
  }).bindPopup(
    '<b>' + (t.name || t.code) + '</b><br>' + t.code +
    '<br>' + f.name + (t.feeder ? ' &middot; ' + t.feeder : '') +
    '<br>' + t.n + ' households, ' + t.ex + ' metered' +
    '<br>' + t.no3g + ' with no 3G (' + Math.round(share * 100) + '%)'
  ).addTo(f.group);
});
FEEDERS.forEach(f => { if (f.on) trLayer.addLayer(f.group); });
const subLayer = L.layerGroup();
L.circleMarker([METERS.substation.lat, METERS.substation.lng], {
  radius: 9, color: '#0E1719', weight: 2.5, fillColor: '#FFD43B', fillOpacity: 1
}).bindPopup('<b>' + METERS.substation.name + '</b><br>' + METERS.substation.code +
             '<br>' + METERS.substation.county + ' County').addTo(subLayer);

const assetCtl = document.getElementById('assetctl');
[['Transformer sites', trLayer, '#0A5A70', true],
 ['Paynesville substation', subLayer, '#FFD43B', true]].forEach(([label, layer, col, on]) => {
  const key = 'asset.' + label;
  const start = store.get(key, on);
  if (start) layer.addTo(map);
  const b = document.createElement('button');
  b.className = 'lyr'; b.type = 'button'; b.setAttribute('aria-pressed', String(start));
  b.innerHTML = '<span class="sw" style="background:' + col + ';border-color:' + col + '"></span>' +
                '<span class="lname">' + label + '</span><span class="val"></span>';
  b.onclick = () => {
    const nowOn = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(nowOn));
    if (nowOn) layer.addTo(map); else map.removeLayer(layer);
    store.set(key, nowOn);
  };
  assetCtl.appendChild(b);
});

/* ---- feeders: show, hide or isolate each one ---- */
const fdEl = document.getElementById('feeders'), fdAll = document.getElementById('fdall');
function paintFeeders(){
  const on = FEEDERS.filter(f => f.on);
  FEEDERS.forEach(f => {
    const alone = on.length === 1 && f.on;
    f.btn.setAttribute('aria-pressed', String(f.on));
    f.solo.textContent = alone ? 'all' : 'only';
    f.solo.title = alone ? 'Show every feeder' : 'Show only ' + f.name;
  });
  fdAll.hidden = on.length === FEEDERS.length;
}
function setFeeders(pick){
  const next = FEEDERS.map(pick);
  FEEDERS.forEach((f, k) => {
    f.on = next[k];
    if (f.on) trLayer.addLayer(f.group); else trLayer.removeLayer(f.group);
  });
  store.set('feedersOff', FEEDERS.filter(f => !f.on).map(f => f.no));
  countViews(); paintViewCounts(); rebuildIndex(); meterCanvas._schedule(); renderKey(); paintFeeders();
}
FEEDERS.forEach(f => {
  const row = document.createElement('div');
  row.className = 'fdr';
  f.btn = document.createElement('button');
  f.btn.className = 'lyr'; f.btn.type = 'button'; f.btn.title = f.full;
  f.btn.innerHTML = '<span class="sw" style="background:' + f.color + ';border-color:' + f.color + '"></span>' +
    '<span class="lname">' + f.name + '<em>' + fmt(f.tr) + ' transformer' + (f.tr === 1 ? '' : 's') +
    ' &middot; ' + fmt(f.hh) + ' household' + (f.hh === 1 ? '' : 's') + '</em></span>';
  f.btn.onclick = () => setFeeders(x => x === f ? !x.on : x.on);
  f.solo = document.createElement('button');
  f.solo.className = 'allbtn'; f.solo.type = 'button';
  f.solo.onclick = () => {
    const alone = FEEDERS.every(x => x.on === (x === f));
    setFeeders(x => alone || x === f);
  };
  row.append(f.btn, f.solo);
  fdEl.appendChild(row);
});
fdAll.onclick = () => setFeeders(() => true);
paintFeeders();

/* ---- gateway planning layers ----
   User-named layers of gateway points. Each gateway has a radius and
   is tested against every household point. */
const GW_COLORS = ['#7C3AED', '#0E9F6E', '#DB2777', '#2563EB', '#B45309', '#475569'];
const gwEl = document.getElementById('gwlayers');
const mapWrap = document.querySelector('.mapwrap');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* uuid v4, so ids can be used as database keys */
const uid = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
  (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

/* signed in: layers are shared through the database. Otherwise they stay in this browser. */
const remote = () => !!(sb && user);

let gwLayers = remote() ? [] : store.get('gwLayers', []);
let placingLayer = null;

function saveGw(){
  const vis = store.get('gwOn', {});
  gwLayers.forEach(l => { vis[l.id] = l.on; });
  store.set('gwOn', vis);
  if (remote()) queuePush();
  else store.set('gwLayers', gwLayers.map(l => ({
    id: l.id, name: l.name, color: l.color, radius: l.radius, on: l.on,
    gws: l.gws.map(g => ({ id: g.id, name: g.name, lat: g.lat, lng: g.lng, r: g.r }))
  })));
}
/* households within r metres of a point; mark[] collects them so overlaps count once */
function metersWithin(lat, lng, r, mark){
  /* metres per degree on Leaflet's sphere, so the count matches the drawn circle */
  const kLat = 111194.93, kLng = kLat * Math.cos(lat * Math.PI / 180), r2 = r * r;
  let n = 0, ex = 0;
  for (let i = 0; i < M.n; i++){
    const dy = (latOf(i) - lat) * kLat;
    if (dy > r || dy < -r) continue;
    const dx = (lngOf(i) - lng) * kLng;
    if (dx * dx + dy * dy > r2) continue;
    n++; if (M.status[i]) ex++;
    if (mark) mark[i] = 1;
  }
  return { n: n, ex: ex };
}
function layerStats(ly){
  const mark = new Uint8Array(M.n);
  ly.gws.forEach(g => { g.stat = metersWithin(g.lat, g.lng, g.r, mark); });
  let n = 0, ex = 0;
  for (let i = 0; i < M.n; i++) if (mark[i]) { n++; if (M.status[i]) ex++; }
  ly.stat = { n: n, ex: ex };
}
function gwChanged(ly){ layerStats(ly); saveGw(); renderGw(); }

/* which operators and technologies cover the gateway's own position (its backhaul options) */
function gwCoverageHtml(g){
  const ops = {};
  entries.forEach(e => {
    (ops[e.op] = ops[e.op] || { name: e.feature.properties.operator_full, techs: [] })
      .techs.push({ e: e, hit: covers(e.feature.geometry, g.lng, g.lat) });
  });
  const rows = Object.keys(ops).sort().map(op => {
    const o = ops[op], any = o.techs.some(t => t.hit);
    return '<li' + (any ? '' : ' class="no"') + '><span class="op">' + esc(o.name) + '</span><span class="techs">' +
      o.techs.map(t => '<i' + (t.hit ? ' style="background:' + t.e.style.c + ';border-color:' + t.e.style.c + (t.e.style.label === 'GSM' ? ';color:#0E1719' : '') + '"' : ' class="no"') +
        ' title="' + t.e.style.label + ' (' + t.e.style.note + ')' + (t.hit ? ' covered' : ' not covered') + '">' + t.e.style.label + '</i>').join('') +
      '</span></li>';
  }).join('');
  const none = !Object.values(ops).some(o => o.techs.some(t => t.hit));
  return '<div class="gwcov"><h4>Mobile coverage at this gateway</h4>' +
    (none ? '<p>No submitted coverage from either operator here.</p>' : '') + '<ul>' + rows + '</ul></div>';
}
function gwPopup(ly, g){
  const d = document.createElement('div');
  d.className = 'gwpop';
  d.innerHTML =
    '<input class="gwname" aria-label="Gateway name" value="' + esc(g.name) + '">' +
    '<div class="gwstat"><b>' + fmt(g.stat.n) + '</b> meters within radius' +
    '<span>' + fmt(g.stat.ex) + ' existing &middot; ' + fmt(g.stat.n - g.stat.ex) + ' not yet metered</span></div>' +
    gwCoverageHtml(g) +
    '<label>Radius <input type="number" class="gwprad" min="10" step="10" value="' + g.r + '"> m</label>' +
    '<div class="gwpcoord">' + g.lat.toFixed(6) + ', ' + g.lng.toFixed(6) + '</div>' +
    '<button class="ghost" type="button">Remove gateway</button>';
  d.querySelector('.gwname').onchange = e => { g.name = e.target.value.trim() || g.name; gwChanged(ly); };
  d.querySelector('.gwprad').onchange = e => {
    const v = Math.round(+e.target.value);
    if (!(v > 0)) { e.target.value = g.r; return; }
    g.r = v; g.circle.setRadius(v);
    gwChanged(ly); g.marker.getPopup().update();
  };
  d.querySelector('button').onclick = () => {
    ly.group.removeLayer(g.marker); ly.group.removeLayer(g.circle);
    ly.gws.splice(ly.gws.indexOf(g), 1);
    gwChanged(ly);
  };
  return d;
}
function mountGateway(ly, g){
  g.circle = L.circle([g.lat, g.lng], {
    radius: g.r, color: ly.color, weight: 1.6, fillColor: ly.color, fillOpacity: 0.12, interactive: false
  }).addTo(ly.group);
  g.marker = L.marker([g.lat, g.lng], {
    draggable: true, keyboard: false,
    icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
                      html: '<span class="gwpin" style="background:' + ly.color + '"></span>' })
  }).addTo(ly.group);
  g.marker.bindPopup(() => gwPopup(ly, g), { minWidth: 190 });
  g.marker.bindTooltip(() => esc(g.name) + ' &middot; ' + fmt(g.stat.n) + ' meters', { direction: 'top', offset: [0, -8] });
  g.marker.on('drag', () => {
    const p = g.marker.getLatLng();
    g.lat = p.lat; g.lng = p.lng; g.circle.setLatLng(p);
  });
  g.marker.on('dragend', () => gwChanged(ly));
}
function addGateway(ly, latlng){
  ly.seq = (ly.seq || ly.gws.length) + 1;
  const g = { id: uid(), name: 'Gateway ' + ly.seq, lat: latlng.lat, lng: latlng.lng, r: ly.radius };
  ly.gws.push(g);
  mountGateway(ly, g);
  gwChanged(ly);
}
function setPlacing(ly){
  placingLayer = ly;
  mapWrap.classList.toggle('placing', !!ly);
  if (ly && !ly.on) { ly.on = true; ly.group.addTo(map); saveGw(); }
  renderGw();
}
function renderGw(){
  gwEl.innerHTML = gwLayers.length ? '' :
    '<p class="gwempty">No layers yet. Name one below, then click the map to place gateways.</p>';
  gwLayers.forEach(ly => {
    const placing = placingLayer === ly;
    const card = document.createElement('div');
    card.className = 'gwl';
    card.dataset.placing = String(placing);
    card.innerHTML =
      '<div class="gwrow">' +
        '<button type="button" class="gwsw" aria-pressed="' + ly.on + '" title="Show / hide layer" aria-label="Show or hide layer"' +
          ' style="background:' + ly.color + ';border-color:' + ly.color + '"></button>' +
        '<input class="gwname" aria-label="Layer name" value="' + esc(ly.name) + '">' +
        '<button type="button" class="gwx" title="Delete layer" aria-label="Delete layer">&times;</button>' +
      '</div>' +
      '<div class="gwstat" title="A meter inside several circles is counted once"><b>' + fmt(ly.stat.n) + '</b> meters in range' +
        '<span>' + (ly.stat.n / M.n * 100).toFixed(1) + '% of ' + fmt(M.n) + ' &middot; ' +
        ly.gws.length + ' gateway' + (ly.gws.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="gwrow gwctl">' +
        '<label title="Applies to every gateway in this layer">Radius <input type="number" class="gwrad" min="10" step="10" value="' + ly.radius + '"> m</label>' +
        '<button type="button" class="ghost gwplace" aria-pressed="' + placing + '">' + (placing ? 'Done placing' : 'Place gateways') + '</button>' +
      '</div>';
    card.querySelector('.gwsw').onclick = () => {
      ly.on = !ly.on;
      if (ly.on) ly.group.addTo(map); else { map.removeLayer(ly.group); if (placing) placingLayer = null, mapWrap.classList.remove('placing'); }
      saveGw(); renderGw();
    };
    card.querySelector('.gwname').onchange = e => { ly.name = e.target.value.trim() || ly.name; saveGw(); renderGw(); };
    card.querySelector('.gwx').onclick = () => {
      if (ly.gws.length && !confirm('Delete "' + ly.name + '" and its ' + ly.gws.length + ' gateway(s)?')) return;
      map.removeLayer(ly.group);
      gwLayers.splice(gwLayers.indexOf(ly), 1);
      if (placing) { placingLayer = null; mapWrap.classList.remove('placing'); }
      saveGw(); renderGw();
    };
    card.querySelector('.gwrad').onchange = e => {
      const v = Math.round(+e.target.value);
      if (!(v > 0)) { e.target.value = ly.radius; return; }
      ly.radius = v;
      ly.gws.forEach(g => { g.r = v; g.circle.setRadius(v); });
      gwChanged(ly);
    };
    card.querySelector('.gwplace').onclick = () => setPlacing(placing ? null : ly);
    if (ly.gws.length){
      const ul = document.createElement('ul');
      ul.className = 'gwlist';
      ly.gws.forEach(g => {
        const li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span>' + esc(g.name) + '</span><span>' + fmt(g.stat.n) + '</span>';
        b.onclick = () => {
          if (!ly.on) { ly.on = true; ly.group.addTo(map); saveGw(); renderGw(); }
          map.panTo([g.lat, g.lng]); g.marker.openPopup();
        };
        li.appendChild(b); ul.appendChild(li);
      });
      card.appendChild(ul);
    }
    gwEl.appendChild(card);
  });
}
const gwNewName = document.getElementById('gwnewname');
function addGwLayer(){
  const ly = {
    id: uid(), name: gwNewName.value.trim() || 'Gateway layer ' + (gwLayers.length + 1),
    color: GW_COLORS[gwLayers.length % GW_COLORS.length], radius: 500, on: true, gws: [],
    group: L.layerGroup().addTo(map), stat: { n: 0, ex: 0 }
  };
  gwLayers.push(ly);
  gwNewName.value = '';
  saveGw();
  setPlacing(ly);
}
document.getElementById('gwadd').onclick = addGwLayer;
gwNewName.addEventListener('keydown', e => { if (e.key === 'Enter') addGwLayer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && placingLayer) setPlacing(null); });
function mountLayers(){
  gwLayers.forEach(ly => {
    ly.group = L.layerGroup();
    ly.gws.forEach(g => mountGateway(ly, g));
    if (ly.on) ly.group.addTo(map);
    layerStats(ly);
  });
}

/* ---- sync: gateway layers live in the database and update live between users ----
   `synced` is the last state known to be on the server. Saving sends only the
   fields that differ from it, so two people editing different things never
   overwrite each other. Incoming changes are merged field by field and never
   replace an edit made here that has not been saved yet. */
const gwSyncEl = document.getElementById('gwsync');
const synced = { layers: new Map(), gws: new Map() };
const dirtyLayers = new Set();
let pushChain = Promise.resolve(), pushTimer = 0, retryTimer = 0, renderTimer = 0;
let syncMsg = '', syncErr = false, live = false, eventSeq = 0;
const layerRow = l => ({ id: l.id, name: l.name, color: l.color, radius_m: l.radius });
const gwRow = (l, g) => ({ id: g.id, layer_id: l.id, name: g.name, lat: g.lat, lng: g.lng, radius_m: g.r });
function currentRows(){
  const layers = new Map(), gws = new Map();
  gwLayers.forEach(l => { layers.set(l.id, layerRow(l)); l.gws.forEach(g => gws.set(g.id, gwRow(l, g))); });
  return { layers: layers, gws: gws };
}
function paintSync(){
  const el = gwSyncEl.querySelector('.msg');
  if (!el) return;
  el.textContent = syncMsg;
  el.classList.toggle('err', syncErr);
  el.title = syncMsg;
  const dot = gwSyncEl.querySelector('.live');
  dot.classList.toggle('on', live);
  dot.title = live ? 'Live: changes from other people appear as they happen'
                   : 'Reconnecting: changes from other people may be delayed';
}
function setSync(msg, err){ syncMsg = msg; syncErr = !!err; paintSync(); }

/* the next single database operation needed to bring the server in line with this browser, or null */
function nextOp(){
  const now = currentRows();
  for (const [table, cur, old] of [['gateway_layers', now.layers, synced.layers], ['gateways', now.gws, synced.gws]]){
    const add = [...cur.values()].filter(r => !old.has(r.id)).slice(0, 500);
    if (add.length) return {
      run: () => sb.from(table).upsert(add),
      done: () => add.forEach(r => { if (!old.has(r.id)) old.set(r.id, r); })
    };
    let diff = null, sig = '', ids = [];
    for (const r of cur.values()){
      const o = old.get(r.id), d = {};
      for (const k in r) if (r[k] !== o[k]) d[k] = r[k];
      const s = JSON.stringify(d);
      if (s === '{}') continue;
      if (!diff) { diff = d; sig = s; }
      if (s === sig && ids.length < 100) ids.push(r.id);
    }
    if (diff) return {
      run: () => sb.from(table).update(diff).in('id', ids),
      done: () => ids.forEach(id => { const o = old.get(id); if (o) old.set(id, Object.assign({}, o, diff)); })
    };
  }
  for (const [table, cur, old] of [['gateways', now.gws, synced.gws], ['gateway_layers', now.layers, synced.layers]]){
    const gone = [...old.keys()].filter(id => !cur.has(id)).slice(0, 100);
    if (gone.length) return {
      run: () => sb.from(table).delete().in('id', gone),
      done: () => gone.forEach(id => old.delete(id))
    };
  }
  return null;
}
function queuePush(){
  if (!remote()) return;
  setSync('Saving…');
  clearTimeout(pushTimer); clearTimeout(retryTimer);
  pushTimer = setTimeout(() => { pushChain = pushChain.then(pushRemote); }, 250);
}
async function pushRemote(){
  try {
    for (let op, guard = 0; (op = nextOp()) && guard < 1000; guard++){
      const { error } = await op.run();
      if (error) throw error;
      op.done();
    }
    setSync('Saved');
  } catch (e) {
    setSync('Not saved yet: ' + (e.message || e) + ' Retrying…', true);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(queuePush, 5000);
  }
}

function findGw(id){
  for (const ly of gwLayers){ const g = ly.gws.find(x => x.id === id); if (g) return { ly: ly, g: g }; }
  return null;
}
function dropLayerLocal(ly){
  map.removeLayer(ly.group);
  gwLayers.splice(gwLayers.indexOf(ly), 1);
  if (placingLayer === ly) { placingLayer = null; mapWrap.classList.remove('placing'); }
}
/* merge one row from the server into this browser */
function applyRemoteRow(kind, row){
  if (kind === 'layers'){
    const r = layerRow({ id: row.id, name: row.name, color: row.color, radius: row.radius_m });
    const old = synced.layers.get(r.id);
    synced.layers.set(r.id, r);
    const ly = gwLayers.find(l => l.id === r.id);
    if (!ly){
      if (old) return;                       /* deleted here, delete not saved yet */
      const on = store.get('gwOn', {})[r.id] !== false;
      const made = { id: r.id, name: r.name, color: r.color, radius: r.radius_m, on: on, gws: [],
                     group: L.layerGroup(), stat: { n: 0, ex: 0 } };
      if (on) made.group.addTo(map);
      gwLayers.push(made);
      return;
    }
    if (!old) return;                        /* created here, this is our own insert coming back */
    if (r.name !== old.name && ly.name === old.name) ly.name = r.name;
    if (r.radius_m !== old.radius_m && ly.radius === old.radius_m) ly.radius = r.radius_m;
    return;
  }
  const r = { id: row.id, layer_id: row.layer_id, name: row.name, lat: row.lat, lng: row.lng, radius_m: row.radius_m };
  const old = synced.gws.get(r.id);
  const hit = findGw(r.id);
  if (!hit){
    const ly = gwLayers.find(l => l.id === r.layer_id);
    if (old || !ly) { if (ly || old) synced.gws.set(r.id, r); return; }
    synced.gws.set(r.id, r);
    const g = { id: r.id, name: r.name, lat: r.lat, lng: r.lng, r: r.radius_m };
    g.stat = metersWithin(g.lat, g.lng, g.r);
    ly.gws.push(g);
    mountGateway(ly, g);
    dirtyLayers.add(ly);
    return;
  }
  synced.gws.set(r.id, r);
  if (!old) return;
  const g = hit.g;
  if (r.name !== old.name && g.name === old.name) g.name = r.name;
  if ((r.lat !== old.lat || r.lng !== old.lng) && g.lat === old.lat && g.lng === old.lng){
    g.lat = r.lat; g.lng = r.lng;
    g.marker.setLatLng([g.lat, g.lng]); g.circle.setLatLng([g.lat, g.lng]);
  }
  if (r.radius_m !== old.radius_m && g.r === old.radius_m) { g.r = r.radius_m; g.circle.setRadius(g.r); }
  g.stat = metersWithin(g.lat, g.lng, g.r);
  dirtyLayers.add(hit.ly);
}
function applyRemoteDelete(kind, id){
  if (kind === 'layers'){
    synced.layers.delete(id);
    const ly = gwLayers.find(l => l.id === id);
    if (!ly) return;
    ly.gws.forEach(g => synced.gws.delete(g.id));
    dropLayerLocal(ly);
    return;
  }
  synced.gws.delete(id);
  const hit = findGw(id);
  if (!hit) return;
  hit.ly.group.removeLayer(hit.g.marker); hit.ly.group.removeLayer(hit.g.circle);
  hit.ly.gws.splice(hit.ly.gws.indexOf(hit.g), 1);
  dirtyLayers.add(hit.ly);
}
/* redraw the rail after remote changes, but never underneath someone who is typing in it */
function scheduleRender(){
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && gwEl.contains(a)) { scheduleRender(); return; }
    dirtyLayers.forEach(ly => { if (gwLayers.indexOf(ly) !== -1) layerStats(ly); });
    dirtyLayers.clear();
    renderGw();
  }, 300);
}
function onRemote(kind, p){
  eventSeq++;
  if (p.eventType === 'DELETE') applyRemoteDelete(kind, p.old.id);
  else applyRemoteRow(kind, p.new);
  scheduleRender();
}
async function fetchAll(table){
  const rows = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await sb.from(table).select('*').order('created_at').order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
/* full comparison with the server: on start, and to catch up after being offline */
async function reconcile(){
  for (let attempt = 0; attempt < 3; attempt++){
    const seq = eventSeq;
    let ls, gs;
    try { [ls, gs] = await Promise.all([fetchAll('gateway_layers'), fetchAll('gateways')]); }
    catch (e) {
      if (syncMsg === 'Loading…') setSync('Could not load gateway layers: ' + (e.message || e), true);
      return;
    }
    if (seq !== eventSeq) continue;          /* a live change landed mid-fetch, so fetch again */
    ls.forEach(r => applyRemoteRow('layers', r));
    gs.forEach(r => applyRemoteRow('gws', r));
    const lid = new Set(ls.map(r => r.id)), gid = new Set(gs.map(r => r.id));
    [...synced.gws.keys()].forEach(id => { if (!gid.has(id)) applyRemoteDelete('gws', id); });
    [...synced.layers.keys()].forEach(id => { if (!lid.has(id)) applyRemoteDelete('layers', id); });
    scheduleRender();
    if (syncMsg === 'Loading…' || (syncErr && !nextOp())) setSync('Saved');
    return;
  }
}
function queueReconcile(){ pushChain = pushChain.then(reconcile); return pushChain; }

/* layers made before the app had a database stay in this browser until uploaded */
function uploadLocal(){
  store.get('gwLayers', []).forEach(l => {
    const ly = { id: uid(), name: l.name, color: l.color, radius: l.radius, on: true, group: L.layerGroup().addTo(map),
                 gws: l.gws.map(g => ({ id: uid(), name: g.name, lat: g.lat, lng: g.lng, r: g.r })) };
    ly.gws.forEach(g => mountGateway(ly, g));
    layerStats(ly);
    gwLayers.push(ly);
  });
  store.set('gwLayers', []);
  saveGw(); renderGw(); renderSync();
}
function renderSync(){
  gwSyncEl.innerHTML = '';
  if (!remote()) return;
  const bar = document.createElement('div');
  bar.className = 'gwsyncbar';
  bar.innerHTML = '<span class="live"></span><span class="msg"></span>';
  gwSyncEl.appendChild(bar);
  paintSync();
  const local = store.get('gwLayers', []);
  if (local.length){
    const up = document.createElement('button');
    up.className = 'ghost'; up.type = 'button';
    up.textContent = 'Upload ' + local.length + ' layer' + (local.length === 1 ? '' : 's') + ' saved in this browser';
    up.onclick = uploadLocal;
    gwSyncEl.appendChild(up);
  }
}
mountLayers(); renderGw(); renderSync();
if (remote()){
  setSync('Loading…');
  queueReconcile();
  sb.channel('gateway-edits')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gateway_layers' }, p => onRemote('layers', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gateways' }, p => onRemote('gws', p))
    .subscribe(status => {
      const was = live;
      live = status === 'SUBSCRIBED';
      if (live && !was) queueReconcile();    /* pick up anything missed while disconnected */
      paintSync();
    });
  setInterval(() => { if (!live && !document.hidden) queueReconcile(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) queueReconcile(); });
  window.addEventListener('online', () => { queueReconcile(); queuePush(); });
  window.addEventListener('beforeunload', e => { if (nextOp()) { e.preventDefault(); e.returnValue = ''; } });
}

document.getElementById('gwexport').onclick = () => {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [];
  gwLayers.forEach(ly => ly.gws.forEach(g => lines.push(
    [q(ly.name), q(g.name), g.lat.toFixed(6), g.lng.toFixed(6), g.r, g.stat.n, g.stat.ex, g.stat.n - g.stat.ex].join(','))));
  if (!lines.length) return;
  const blob = new Blob(['layer,gateway,lat,lng,radius_m,meters_in_radius,existing_meter,no_meter\n' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lec_gateways.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};

/* ---- export the current meter selection ---- */
document.getElementById('dlmeters').onclick = () => {
  if (activeView.id === 'none' || !visibleIdx.length) return;
  const tf = METERS.transformers;
  const head = 'lat,lng,transformer_code,transformer_name,feeder,status,orange_gsm,orange_3g,orange_lte,lonestar_gsm,lonestar_3g,lonestar_lte\n';
  const lines = visibleIdx.map(i => {
    const t = tf[M.tidx[i]], f = M.flags[i];
    return [latOf(i).toFixed(6), lngOf(i).toFixed(6), t.code, '"' + (t.name || '').replace(/"/g, '""') + '"',
            t.feeder, M.status[i] ? 'existing_meter' : 'no_meter',
            f & 1 ? 1 : 0, f & 2 ? 1 : 0, f & 4 ? 1 : 0,
            f & 8 ? 1 : 0, f & 16 ? 1 : 0, f & 32 ? 1 : 0].join(',');
  });
  const blob = new Blob([head + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lec_meters_' + activeView.id + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};

/* the rollout area, not the whole country, is the working view */
let maxLat = 0, maxLng = 0;
for (let i = 0; i < M.n; i++){ if (M.lat[i] > maxLat) maxLat = M.lat[i]; if (M.lng[i] > maxLng) maxLng = M.lng[i]; }
const ROLLOUT = L.latLngBounds(
  [METERS.lat0, METERS.lng0],
  [METERS.lat0 + maxLat / 1e6, METERS.lng0 + maxLng / 1e6]
);
document.getElementById('fitbtn').onclick = () => map.fitBounds(ROLLOUT, { padding: [24, 24] });
map.fitBounds(ROLLOUT, { padding: [24, 24] });

/* ---- findings card ---- */
const brief = document.getElementById('brief');
brief.querySelector('.briefbody').innerHTML = data.briefHtml || '';
const infoBtn = document.getElementById('infobtn');
const briefDate = document.getElementById('briefdate');
if (briefDate) briefDate.textContent = new Date(METERS.generatedAt).toISOString().slice(0, 10);
L.DomEvent.disableClickPropagation(brief);
L.DomEvent.disableScrollPropagation(brief);
let briefOpen = false, briefAnim = null;
function setBrief(open, animate){
  briefOpen = open;
  infoBtn.setAttribute('aria-expanded', String(open));
  store.set('briefSeen', true);
  if (briefAnim) { briefAnim.cancel(); briefAnim = null; }
  if (open) brief.hidden = false;
  if (!animate || !brief.animate || matchMedia('(prefers-reduced-motion:reduce)').matches) {
    brief.hidden = !open;
    return;
  }
  // collapse towards (or expand from) the header button
  const b = brief.getBoundingClientRect(), t = infoBtn.getBoundingClientRect();
  const dx = (t.left + t.width / 2) - (b.left + b.width / 2);
  const dy = (t.top + t.height / 2) - (b.top + b.height / 2);
  const min = { transform: `translate(${dx}px,${dy}px) scale(${t.width / b.width},${t.height / b.height})`, opacity: 0 };
  const full = { transform: 'none', opacity: 1 };
  briefAnim = brief.animate(open ? [min, full] : [full, min], { duration: 220, easing: 'cubic-bezier(.4,0,.2,1)' });
  briefAnim.onfinish = () => { briefAnim = null; brief.hidden = !open; };
}
infoBtn.onclick = () => setBrief(!briefOpen, true);
document.getElementById('briefclose').onclick = () => { setBrief(false, true); infoBtn.focus(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && briefOpen) setBrief(false, true); });
setBrief(!store.get('briefSeen', false));

}

if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__lecDev = { startApp: startApp, loadData: loadData };
boot();
})();
