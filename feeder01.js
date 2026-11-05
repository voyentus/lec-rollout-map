/* ---------------------------------------------------------------
   Feeder 01 map
   A second view inside the signed-in app, behind the "Feeder 01 map"
   switch in the top bar. It shows the households in one CSV and
   nothing else, so an export (say, a feeder with its outliers taken
   out) can be checked on the map before it is accepted. Switching
   flips between the two views in place: no page load, so the main
   map, its data and the sign-in are left exactly as they were.
   The file is read in the browser; nothing is sent anywhere.
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

function show(name, text){
  const rows = parseCSV(text);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const la = head.indexOf('lat'), ln = head.indexOf('lng') !== -1 ? head.indexOf('lng') : head.indexOf('lon');
  const st = head.indexOf('status');
  if (la === -1 || ln === -1) throw new Error('The file needs "lat" and "lng" columns.');
  const tc = head.indexOf('transformer_code'), tn = head.indexOf('transformer_name'),
        tla = head.indexOf('transformer_lat'), tln = head.indexOf('transformer_lng');
  points.clearLayers(); sites.clearLayers();
  const counts = {}, trs = new Map(), kept = []; let skipped = 0;
  rows.forEach(r => {
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
      .bindPopup(() => popTable(head, r), { maxWidth: 360 })
      .addTo(points);
  });
  trs.forEach((t, code) => {
    if (!isFinite(t.lat) || !isFinite(t.lng)) return;
    L.circleMarker([t.lat, t.lng], { radius: 7, color: EDGE, weight: 1.5, fillColor: YELLOW, fillOpacity: 1 })
      .bindTooltip((code.match(/TRN\d+$/) || [code])[0], { direction: 'top', offset: [0, -6] })
      .bindPopup(popTable(['transformer_code', 'transformer_name', 'households in this file'], [code, t.name, fmt(t.n)]), { maxWidth: 360 })
      .addTo(sites);
  });
  if (!points.getLayers().length) throw new Error('No rows with a location were found in this file.');
  map.fitBounds(points.getBounds(), { padding: [24, 24] });
  $('fdfile').textContent = name;
  $('fdcount').textContent = fmt(points.getLayers().length) + (skipped ? ' (' + fmt(skipped) + ' rows without a location left out)' : '');
  $('fdkey').innerHTML = '<span><i style="background:' + BLUE + '"></i>household</span>' +
    (sites.getLayers().length ? '<span><i style="background:' + YELLOW + ';box-shadow:0 0 0 1px ' + EDGE + '"></i>transformer ' + fmt(sites.getLayers().length) + '</span>' : '') +
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
    const src = first.get(code), row = head.map(() => '');
    ['transformer_code', 'transformer_name', 'transformer_lat', 'transformer_lng', 'feeder_no', 'feeder']
      .forEach(n => { if (col(n) !== -1) row[col(n)] = src[col(n)]; });
    row[col('lat')] = src[col('transformer_lat')];
    row[col('lng') !== -1 ? col('lng') : col('lon')] = src[col('transformer_lng')];
    out.push(['transformer'].concat(row, t.n));
  });
  rows.forEach(r => out.push(['household'].concat(head.map((h, k) => r[k] || ''), tc !== -1 && trs.has(r[tc]) ? trs.get(r[tc]).n : '')));
  const blob = new Blob([out.map(r => r.map(csvCell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'feeder01_transformers_and_households.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};

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
  file.text().then(text => { show(file.name, text); keep(file.name, text); }).catch(e => {
    $('fddrop').hidden = false;
    $('fddropmsg').textContent = e.message || String(e);
  });
}
view.querySelectorAll('input[type=file]').forEach(inp => {
  inp.onchange = () => { open(inp.files[0]); inp.value = ''; };
});
/* a file can also be dropped anywhere on the map */
const wrap = view.querySelector('.mapwrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); });
wrap.addEventListener('drop', e => { e.preventDefault(); open(e.dataTransfer.files[0]); });
})();
