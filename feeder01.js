/* ---------------------------------------------------------------
   Feeder 01 map
   A second view inside the signed-in app, behind the "Feeder 01 map"
   switch in the top bar. It shows the households in one CSV and
   nothing else, so an export (say, a feeder with its outliers taken
   out) can be checked on the map before it is accepted. Switching
   flips between the two views in place: no page load, so the main
   map, its data and the sign-in are left exactly as they were.
   It opens on all the Feeder 01 households,
   built from the database after sign-in (see below). "Open another CSV" swaps in a
   file from this computer for this tab only; that file is read in the
   browser and nothing is sent anywhere.
----------------------------------------------------------------*/
(() => {
const $ = id => document.getElementById(id);
const store = {
  get(k, d){ try { const v = localStorage.getItem('lce.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
};
const fmt = n => Math.round(n).toLocaleString('en-GB');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---- the switch ---- */
const toggle = $('feedertoggle'), view = $('feederview'), dlBtn = $('fddownload');
let map = null, shown = null;      /* shown: the file on the map, for the download */
function setView(on){
  view.hidden = !on;
  dlBtn.hidden = !on || !shown;
  toggle.setAttribute('aria-checked', String(on));
  toggle.title = on ? 'Switch back to the main map' : 'Switch to the Feeder 01 map';
  if (!on) return;
  if (!map) makeMap(); else map.invalidateSize();
  setBasemap();
  loadFeeder();
}

/* ---- the Feeder 01 households themselves ----
   Built from the database the app already signs in to: every household
   on a Feeder 01 transformer, with nothing left out. (Until 2026-11-10 a
   fixed list of 156 far-off households was hidden; that list is in the
   git history and in feeder01_outliers_removed.csv outside the repo.)
   Distances use the flat-earth approximation of the 2026-11-05 export
   (110,540 m per degree of latitude, 111,320 m x cos(mid latitude) per
   degree of longitude). */
const FEEDER = '22KV-PAYN-SUB-01', FEEDER_NAME = 'Feeder 01, all households';
const HEAD = ['household_id', 'sp_id', 'lat', 'lng', 'transformer_code', 'transformer_name', 'transformer_lat', 'transformer_lng',
  'feeder_no', 'feeder', 'status', 'installed_at', 'orange_gsm', 'orange_3g', 'orange_lte', 'lonestar_gsm', 'lonestar_3g', 'lonestar_lte',
  'dist_to_own_transformer_m', 'dist_to_nearest_feeder_transformer_m'];
const metres = (a, b, c, d) => Math.hypot((c - a) * 110540, (d - b) * 111320 * Math.cos((a + c) / 2 * Math.PI / 180));
const txt = v => v === null || v === undefined ? '' : String(v);

let sb = null, trList = null, fetching = false;
window.feeder01 = { attach(client, transformers){ sb = client; trList = transformers || []; if (!view.hidden) loadFeeder(); } };

async function feederRows(){
  const trs = trList.filter(t => t.feeder === FEEDER);
  if (!trs.length) throw new Error('No Feeder 01 transformers were found.');
  const byCode = new Map(trs.map(t => [t.code, t]));
  const hh = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await sb.from('households')
      .select('id,sp_id,lat,lng,transformer_code,has_meter,installed_at,cov')
      .in('transformer_code', trs.map(t => t.code)).order('id').range(from, from + 999);
    if (error) throw error;
    hh.push.apply(hh, data);
    if (data.length < 1000) break;
  }
  const feederNo = (FEEDER.match(/(\d+)$/) || ['', ''])[1];
  const rows = [HEAD];
  hh.forEach(h => {
    const t = byCode.get(h.transformer_code);
    let near = Infinity;
    trs.forEach(x => { near = Math.min(near, metres(h.lat, h.lng, x.lat, x.lng)); });
    rows.push([txt(h.id), txt(h.sp_id), txt(h.lat), txt(h.lng), h.transformer_code, txt(t.name), txt(t.lat), txt(t.lng),
      feederNo, FEEDER, h.has_meter ? 'existing_meter' : 'no_meter', txt(h.installed_at)]
      .concat([1, 2, 4, 8, 16, 32].map(b => h.cov & b ? '1' : '0'))
      .concat(String(Math.round(metres(h.lat, h.lng, t.lat, t.lng))), String(Math.round(near))));
  });
  return rows;
}
function loadFeeder(){
  if (shown || fetching || !sb || !sb.from || !trList) return;
  fetching = true;
  dropState('Loading the Feeder 01 households…', '');
  feederRows()
    .then(rows => { if (!shown) showRows(FEEDER_NAME, rows, trList.filter(t => t.feeder === FEEDER)); })
    .catch(e => dropState('', 'Could not load the Feeder 01 households. ' + (e.message || e) + ' You can open a CSV from this computer instead.'))
    .finally(() => { fetching = false; });
}
function dropState(loading, error){
  $('fddrop').hidden = false;
  $('fdloading').hidden = !loading; $('fdloading').textContent = loading;
  $('fdpick').hidden = !!loading;
  $('fddropmsg').textContent = error;
}
toggle.onclick = () => setView(view.hidden);

/* ---- map ----
   Built the first time the view is opened, when its box has a size. The
   basemap follows the Streets / Humanitarian choice in the top bar. */
const BASEMAPS = [
  ['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'],
  ['https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles by HOT']
];
let baseLayer = null, baseNow = -1;
function setBasemap(){
  const i = BASEMAPS[store.get('basemap', 0)] ? store.get('basemap', 0) : 0;
  if (!map || i === baseNow) return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(BASEMAPS[i][0], { attribution: BASEMAPS[i][1], maxZoom: 19 }).addTo(map);
  baseNow = i;
}
/* the main map's buttons store the choice first; this runs as the click bubbles up */
$('basemaps').addEventListener('click', () => { if (!view.hidden) setBasemap(); });

const points = L.featureGroup(), sites = L.featureGroup();
function makeMap(){
  map = L.map('feedermap', { zoomControl: true, minZoom: 5, zoomSnap: 0.5, zoomDelta: 0.5, preferCanvas: true })
         .setView([6.30, -10.72], 12);
  L.control.scale({ imperial: false }).addTo(map);
  map.on('mousemove', e => { $('fdcursor').textContent = e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5); });
  points.addTo(map); sites.addTo(map);
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) || 'null');
    if (kept) show(kept.name, kept.text);
  } catch (e) {}
}

/* ---- CSV ---- */
function parseCSV(text){
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r'){
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0]);
}

/* households in blue; the feeder's transformers, when the file has their
   locations, in yellow on top so the feeder itself stands out */
const BLUE = '#1F5FD1', YELLOW = '#FFD000', EDGE = '#5C4500';
const STATUS = { existing_meter: 'existing meter', no_meter: 'not yet metered' };
const popTable = (head, r) => '<table class="feederpop">' +
  head.map((h, k) => r[k] ? '<tr><th>' + esc(h) + '</th><td>' + esc(r[k]) + '</td></tr>' : '').join('') + '</table>';

/* ---- household popup in plain words ----
   The export's columns, said the way a person would: the meter status as
   words, distances in m or km, and the six 0/1 coverage columns as one
   small table per operator (same look as the gateway popup on the main
   map). Columns it does not know are still shown, with tidied names. */
const COV_OPS = [
  ['Orange', 'orange', ['#F7C393', '#E9761C', '#A93A05']],
  ['Lonestar Cell MTN', 'lonestar', ['#9FD0E0', '#2A8DA8', '#08475A']]
];
const COV_TECH = [['gsm', '2G', 'GSM, calls and SMS'], ['3g', '3G', 'UMTS data'], ['lte', '4G', 'LTE data']];
const HH_KNOWN = new Set(['household_id', 'sp_id', 'lat', 'lng', 'lon', 'transformer_code', 'transformer_name',
  'transformer_lat', 'transformer_lng', 'feeder_no', 'feeder', 'status', 'installed_at', 'record_type',
  'dist_to_own_transformer_m', 'dist_to_nearest_feeder_transformer_m']);
COV_OPS.forEach(o => COV_TECH.forEach(t => HH_KNOWN.add(o[1] + '_' + t[0])));
const yes = v => /^(1|true|yes|y)$/i.test(String(v || '').trim());
const distText = v => { const m = parseFloat(v); return !isFinite(m) ? '' : m < 1000 ? fmt(m) + ' m' : (m / 1000).toFixed(1) + ' km'; };
const tidy = h => { const s = String(h).replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const words = s => s ? tidy(String(s).toLowerCase()) : '';
function householdPopup(head, r){
  const v = name => { const k = head.indexOf(name); return k === -1 ? '' : (r[k] || '').trim(); };
  const rows = [];
  const add = (label, value) => { if (value) rows.push('<tr><th>' + esc(label) + '</th><td>' + esc(value) + '</td></tr>'); };
  const trn = v('transformer_code'), short = (trn.match(/TRN\d+$/) || [trn])[0];
  add('Meter', STATUS[v('status')] ? tidy(STATUS[v('status')]) : v('status'));
  add('Supply point', v('sp_id'));
  add('Transformer', [short, v('transformer_name')].filter(Boolean).join(' · '));
  add('Distance to its transformer', distText(v('dist_to_own_transformer_m')));
  add('Nearest Feeder ' + (v('feeder_no') || '01') + ' transformer', distText(v('dist_to_nearest_feeder_transformer_m')));
  add('Feeder', v('feeder_no') ? v('feeder_no') + (v('feeder') ? ' (' + v('feeder') + ')' : '') : v('feeder'));
  add('Installed', v('installed_at') ? v('installed_at').slice(0, 10) : '');
  const lat = parseFloat(v('lat')), lng = parseFloat(v('lng') || v('lon'));
  add('Location', isFinite(lat) && isFinite(lng) ? lat.toFixed(5) + ', ' + lng.toFixed(5) : '');
  head.forEach((h, k) => { if (!HH_KNOWN.has(h)) add(tidy(h), (r[k] || '').trim()); });

  let cov = '';
  if (COV_OPS.some(o => COV_TECH.some(t => head.indexOf(o[1] + '_' + t[0]) !== -1))){
    const items = COV_OPS.map(([name, key, colours]) => {
      const techs = COV_TECH.map(([t, label, note], i) => {
        const hit = yes(v(key + '_' + t));
        return '<i' + (hit ? ' style="background:' + colours[i] + ';border-color:' + colours[i] + (i === 0 ? ';color:#0E1719' : '') + '"' : ' class="no"') +
          ' title="' + label + ' (' + note + ') ' + (hit ? 'covered' : 'not covered') + '">' + label + '</i>';
      });
      const any = COV_TECH.some(([t]) => yes(v(key + '_' + t)));
      return '<li' + (any ? '' : ' class="no"') + '><span class="op">' + name + '</span><span class="techs">' + techs.join('') + '</span></li>';
    }).join('');
    const no3g = !COV_OPS.some(o => yes(v(o[1] + '_3g')));
    cov = '<div class="gwcov hhcov"><h4>Mobile coverage here</h4>' +
      (no3g ? '<p>No 3G from either operator.</p>' : '') + '<ul>' + items + '</ul>' +
      '<div class="hhcovnote">Filled: covered. Crossed out: not covered. From the operators\' 2017–18 coverage maps, not a signal test.</div></div>';
  }
  return '<div class="hhpop"><div class="hhtitle">Household ' + esc(v('household_id') || '') + '</div>' +
    '<table class="feederpop">' + rows.join('') + '</table>' + cov + '</div>';
}

function show(name, text){ showRows(name, parseCSV(text)); }
/* allTrs: for the database view, every transformer on the feeder, so the
   ones with no households on this map are drawn too (hollow, 0 households) */
function showRows(name, rows, allTrs){
  rows = rows.slice();
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const la = head.indexOf('lat'), ln = head.indexOf('lng') !== -1 ? head.indexOf('lng') : head.indexOf('lon');
  const st = head.indexOf('status');
  if (la === -1 || ln === -1) throw new Error('The file needs "lat" and "lng" columns.');
  const tc = head.indexOf('transformer_code'), tn = head.indexOf('transformer_name'),
        tla = head.indexOf('transformer_lat'), tln = head.indexOf('transformer_lng');
  points.clearLayers(); sites.clearLayers();
  const counts = {}, trs = new Map(), kept = []; let skipped = 0;
  const rt = head.indexOf('record_type');
  rows.forEach(r => {
    if (rt !== -1 && r[rt] === 'transformer') return;
    const lat = parseFloat(r[la]), lng = parseFloat(r[ln]);
    if (!isFinite(lat) || !isFinite(lng)) { skipped++; return; }
    kept.push(r);
    const s = STATUS[r[st]];
    if (s) counts[s] = (counts[s] || 0) + 1;
    if (tc !== -1 && tla !== -1 && tln !== -1 && r[tc]){
      const t = trs.get(r[tc]) || { lat: parseFloat(r[tla]), lng: parseFloat(r[tln]), name: tn !== -1 ? r[tn] : '', n: 0 };
      t.n++; trs.set(r[tc], t);
    }
    L.circleMarker([lat, lng], { radius: 3, color: '#fff', weight: 0.6, opacity: 0.8, fillColor: BLUE, fillOpacity: 0.9 })
      .bindPopup(() => householdPopup(head, r), { maxWidth: 300 })
      .addTo(points);
  });
  const info = new Map((allTrs || []).map(t => [t.code, t]));
  info.forEach((t, code) => { if (!trs.has(code)) trs.set(code, { lat: t.lat, lng: t.lng, name: t.name || '', n: 0 }); });
  let empty = 0;
  trs.forEach((t, code) => {
    if (!isFinite(t.lat) || !isFinite(t.lng)) return;
    const d = info.get(code) || {};
    if (!t.n) empty++;
    L.circleMarker([t.lat, t.lng], t.n
      ? { radius: 7, color: EDGE, weight: 1.5, fillColor: YELLOW, fillOpacity: 1 }
      : { radius: 6, color: EDGE, weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip((code.match(/TRN\d+$/) || [code])[0], { direction: 'top', offset: [0, -6] })
      .bindPopup('<div class="hhpop"><div class="hhtitle">Transformer ' + esc((code.match(/TRN\d+$/) || [code])[0]) + '</div>' +
        popTable(['Name', 'Community', 'Size', 'Status', 'Condition', 'Households on this map', 'Code'],
          [t.name, d.community, d.kva ? d.kva + ' kVA' : '', words(d.status), words(d.condition), fmt(t.n), code]) + '</div>', { maxWidth: 360 })
      .addTo(sites);
  });
  if (!points.getLayers().length) throw new Error('No rows with a location were found in this file.');
  map.fitBounds(points.getBounds(), { padding: [24, 24] });
  $('fdfile').textContent = name;
  $('fdcount').textContent = fmt(points.getLayers().length) + (skipped ? ' (' + fmt(skipped) + ' rows without a location left out)' : '');
  $('fdkey').innerHTML = '<span><i style="background:' + BLUE + '"></i>household</span>' +
    (sites.getLayers().length - empty ? '<span><i style="background:' + YELLOW + ';box-shadow:0 0 0 1px ' + EDGE + '"></i>transformer ' + fmt(sites.getLayers().length - empty) + '</span>' : '') +
    (empty ? '<span><i style="background:#fff;box-shadow:0 0 0 2px ' + EDGE + '"></i>no households ' + fmt(empty) + '</span>' : '') +
    Object.keys(counts).map(k => '<span>' + k + ' ' + fmt(counts[k]) + '</span>').join('');
  $('fddrop').hidden = true;
  $('fdopen').hidden = false;
  shown = { name: name, head: head, rows: kept, trs: trs, tc: tc };
  dlBtn.hidden = view.hidden;
}

/* ---- download ----
   One CSV with every transformer on the map and every household, told
   apart by record_type. Transformer rows carry the site's own location in
   lat / lng and how many households in the file it feeds; household rows
   are the opened file's rows as they were, plus that same count. */
const csvCell = v => /[",\n\r]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
dlBtn.onclick = () => {
  if (!shown) return;
  const { head, rows, trs, tc } = shown;
  const col = n => head.indexOf(n);
  const out = [['record_type'].concat(head, 'households_on_transformer')];
  const first = new Map();             /* a household on each transformer, for its feeder columns */
  rows.forEach(r => { if (tc !== -1 && !first.has(r[tc])) first.set(r[tc], r); });
  trs.forEach((t, code) => {
    const row = head.map(() => '');
    /* a transformer with no households has no row to copy from: build one */
    const src = first.get(code) || head.map(h => ({ transformer_code: code, transformer_name: t.name,
      transformer_lat: String(t.lat), transformer_lng: String(t.lng),
      feeder_no: (FEEDER.match(/(\d+)$/) || ['', ''])[1], feeder: FEEDER })[h] || '');
    ['transformer_code', 'transformer_name', 'transformer_lat', 'transformer_lng', 'feeder_no', 'feeder']
      .forEach(n => { if (col(n) !== -1) row[col(n)] = src[col(n)]; });
    row[col('lat')] = src[col('transformer_lat')];
    row[col('lng') !== -1 ? col('lng') : col('lon')] = src[col('transformer_lng')];
    out.push(['transformer'].concat(row, t.n));
  });
  rows.forEach(r => out.push(['household'].concat(head.map((h, k) => r[k] || ''), tc !== -1 && trs.has(r[tc]) ? trs.get(r[tc]).n : '')));
  saveCSV(out.map(r => r.map(csvCell).join(',')).join('\n') + '\n', 'feeder01_transformers_and_households.csv');
};

/* Save, not open. Where the browser has a real Save dialog (Chrome, Edge)
   the user picks the folder and name. Elsewhere the file is handed over as
   a plain download (octet-stream), which browsers save instead of offering
   to open it in Numbers / Excel; the link is kept alive long enough for any
   "where to save" prompt to finish. */
function saveCSV(text, name){
  if (window.showSaveFilePicker){
    window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] })
      .then(h => h.createWritable()).then(w => w.write(text).then(() => w.close()))
      .catch(e => { if (e.name !== 'AbortError') fallback(); });
    return;
  }
  fallback();
  function fallback(){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }
}

/* the open file is kept for this tab only, so a reload does not mean opening
   it again; closing the tab forgets it */
const KEPT = 'lce.feeder01.csv';
function keep(name, text){
  try { sessionStorage.setItem(KEPT, JSON.stringify({ name: name, text: text })); }
  catch (e) { try { sessionStorage.removeItem(KEPT); } catch (e2) {} }
}

function open(file){
  if (!file) return;
  $('fddropmsg').textContent = '';
  file.text().then(text => { show(file.name, text); keep(file.name, text); })
    .catch(e => dropState('', e.message || String(e)));
}
view.querySelectorAll('input[type=file]').forEach(inp => {
  inp.onchange = () => { open(inp.files[0]); inp.value = ''; };
});
/* a file can also be dropped anywhere on the map */
const wrap = view.querySelector('.mapwrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); });
wrap.addEventListener('drop', e => { e.preventDefault(); open(e.dataTransfer.files[0]); });
})();
