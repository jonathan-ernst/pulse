/* Pulse – a day of public transport in Rhein-Neckar.
 * Data: VRN GTFS → scripts/build_data.py → data/rhein-neckar.json
 * Rendering: MapLibre (basemap) + deck.gl (trips, vehicles, reachability skyline)
 * Routing: Connection Scan Algorithm over ~250k timetable connections, in the browser.
 */
(() => {
const $ = (id) => document.getElementById(id);
const DAY_START = 4 * 3600, DAY_END = 26 * 3600;
const WALK = 1.2 / 1.3;               // m/s effective walking speed (detour factor 1.3)
const ISO_MAX = 3600;                 // 60 min
const CELL = 150;                     // m, reachability grid
const BANDS = [[10, [255, 244, 140]], [20, [255, 196, 92]], [30, [255, 130, 108]], [45, [214, 93, 177]], [60, [124, 92, 214]]];

const TRAM_PALETTE = [[255, 94, 98], [255, 179, 71], [255, 230, 109], [255, 138, 76], [255, 107, 139], [250, 160, 120], [255, 205, 86], [240, 120, 90]];
const BUS = [79, 209, 255], BUS2 = [127, 124, 255], FERRY = [120, 255, 214];

const state = { t: 7 * 3600, speed: 120, playing: true, modes: { 0: true, 2: true, 3: true }, iso: null, reveal: 0, hover: null };

// ------------------------------------------------------------------ load
async function load() {
  const res = await fetch('data/rhein-neckar.json');
  const total = +res.headers.get('content-length') || 8.1e6;
  const reader = res.body.getReader(); const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    $('loadbar').style.width = Math.min(95, got / total * 100) + '%';
  }
  $('loadmsg').textContent = 'Baue 14.000 Fahrten…';
  await new Promise(r => setTimeout(r, 30));
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

function meters(ax, ay, bx, by) {
  const dx = (ax - bx) * 111320 * Math.cos(ay * Math.PI / 180), dy = (ay - by) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

function build(raw) {
  const routes = raw.routes.map(([name, mode], i) => {
    const n = name.replace(/^RNV\s*/, '');
    let color = mode === 2 ? (i % 3 ? BUS : BUS2) : mode === 3 ? FERRY : TRAM_PALETTE[(parseInt(n) || i) % TRAM_PALETTE.length];
    return { name: n, mode, color };
  });
  const S = raw.stations.length;
  const sx = new Float64Array(S), sy = new Float64Array(S), sname = raw.stations.map(s => s[0].replace(/\s+(Bstg|Bussteig|Steig|Gleis)\b.*$/i, ""));
  raw.stations.forEach((s, i) => { sx[i] = s[1] / 1e5; sy[i] = s[2] / 1e5; });

  // shapes: delta-decoded coords + cumulative meters
  const shapes = raw.shapes.map(flat => {
    const n = flat.length / 2, xy = new Float64Array(flat.length), cum = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += flat[2 * i]; y += flat[2 * i + 1]; xy[2 * i] = x / 1e5; xy[2 * i + 1] = y / 1e5;
      if (i) cum[i] = cum[i - 1] + meters(xy[2 * i - 2], xy[2 * i - 1], xy[2 * i], xy[2 * i + 1]);
    }
    return { xy, cum };
  });

  const pos = [], ts = [], starts = [], tripRoute = [], tripHead = [], tStart = [], tEnd = [];
  const conn = []; // [dep, arr, from, to, trip]
  raw.trips.sort((a, b) => a[3][2] - b[3][2]);   // by first departure → time buckets are contiguous
  raw.trips.forEach(([ri, si, head, flat], ti) => {
    const sh = shapes[si]; const stops = [];
    let pt = 0;
    for (let k = 0; k < flat.length; k += 4) {
      const arr = pt + flat[k + 2], dep = arr + flat[k + 3]; pt = dep;
      stops.push({ s: flat[k], v: flat[k + 1], arr, dep });
    }
    starts.push(ts.length);
    const push = (v, t) => {
      if (ts.length > starts[starts.length - 1] && t < ts[ts.length - 1]) t = ts[ts.length - 1];
      pos.push(sh.xy[2 * v], sh.xy[2 * v + 1]); ts.push(t);
    };
    for (let k = 0; k < stops.length; k++) {
      const a = stops[k];
      push(a.v, a.arr); if (a.dep > a.arr) push(a.v, a.dep);
      if (k + 1 < stops.length) {
        const b = stops[k + 1];
        conn.push([a.dep, b.arr, a.s, b.s, ti]);
        const d0 = sh.cum[a.v], span = Math.max(1e-6, sh.cum[b.v] - d0);
        for (let v = a.v + 1; v < b.v; v++) push(v, a.dep + (b.arr - a.dep) * (sh.cum[v] - d0) / span);
      }
    }
    tripRoute.push(ri); tripHead.push(head); tStart.push(stops[0].arr); tEnd.push(stops[stops.length - 1].dep);
  });
  starts.push(ts.length);

  // connections sorted by departure (typed arrays for the CSA hot loop)
  conn.sort((a, b) => a[0] - b[0]);
  const C = conn.length, cDep = new Int32Array(C), cArr = new Int32Array(C), cFrom = new Int32Array(C), cTo = new Int32Array(C), cTrip = new Int32Array(C);
  conn.forEach((c, i) => { cDep[i] = c[0]; cArr[i] = c[1]; cFrom[i] = c[2]; cTo[i] = c[3]; cTrip[i] = c[4]; });

  // spatial hash of stations (for footpaths + click lookup)
  const G = 0.006, grid = new Map(), key = (x, y) => Math.floor(x / G) + ',' + Math.floor(y / G);
  for (let i = 0; i < S; i++) { const k = key(sx[i], sy[i]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  const near = (x, y, r) => {
    const out = [], gx = Math.floor(x / G), gy = Math.floor(y / G), n = Math.ceil(r / 400) + 1;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const s of grid.get((gx + i) + ',' + (gy + j)) || []) {
      const d = meters(x, y, sx[s], sy[s]); if (d <= r) out.push([s, d]);
    }
    return out;
  };
  const fp = Array.from({ length: S }, (_, i) => near(sx[i], sy[i], 400).filter(([s]) => s !== i).map(([s, d]) => [s, Math.round(d / WALK)]));

  // active-vehicle histogram, 5-min buckets
  const B = (DAY_END - DAY_START) / 300, hist = { 0: new Float32Array(B), 2: new Float32Array(B) };
  tStart.forEach((a, i) => {
    const m = routes[tripRoute[i]].mode === 2 ? 2 : 0;
    for (let b = Math.max(0, Math.floor((a - DAY_START) / 300)); b < B && DAY_START + b * 300 <= tEnd[i]; b++) hist[m][b]++;
  });

  return {
    raw, routes, S, sx, sy, sname, near, fp, hist, B,
    N: tripRoute.length, pos: new Float32Array(pos), ts: new Float32Array(ts), starts: new Uint32Array(starts),
    tripRoute: new Uint16Array(tripRoute), tripHead, tStart: new Float32Array(tStart), tEnd: new Float32Array(tEnd),
    C, cDep, cArr, cFrom, cTo, cTrip,
  };
}

// ------------------------------------------------------------------ routing (CSA)
function isochrone(D, lon, lat, t0) {
  const ea = new Float64Array(D.S).fill(Infinity), reached = new Uint8Array(D.N);
  const origin = D.near(lon, lat, 1200);
  for (const [s, d] of origin) ea[s] = Math.min(ea[s], t0 + d / WALK);
  let lo = 0, hi = D.C; while (lo < hi) { const m = (lo + hi) >> 1; D.cDep[m] < t0 ? lo = m + 1 : hi = m; }
  const tMax = t0 + ISO_MAX;
  for (let i = lo; i < D.C; i++) {
    const dep = D.cDep[i]; if (dep > tMax) break;
    const tr = D.cTrip[i];
    if (!D.modeOn(tr)) continue;
    if (reached[tr] || ea[D.cFrom[i]] <= dep) {
      reached[tr] = 1;
      const arr = D.cArr[i], to = D.cTo[i];
      if (arr < ea[to]) {
        ea[to] = arr;
        for (const [s, w] of D.fp[to]) if (arr + w < ea[s]) ea[s] = arr + w;
      }
    }
  }
  // grid "skyline": min travel time per 150 m cell (stations + walk from there)
  const cells = new Map(), lat0 = lat, mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
  const cx = CELL / mx, cy = CELL / my;
  const splat = (x, y, tt) => {
    const rem = ISO_MAX - tt; if (rem <= 0) return;
    const r = Math.min(rem * WALK, 650), nx = Math.ceil(r / CELL), gx = Math.round(x / cx), gy = Math.round(y / cy);
    for (let i = -nx; i <= nx; i++) for (let j = -nx; j <= nx; j++) {
      const d = Math.hypot(i, j) * CELL; if (d > r) continue;
      const k = (gx + i) * 100000 + (gy + j), v = tt + d / WALK, c = cells.get(k);
      if (c === undefined || v < c) cells.set(k, v);
    }
  };
  splat(lon, lat, 0);
  let stops30 = 0; const stations = [];
  for (let s = 0; s < D.S; s++) if (ea[s] < Infinity) {
    const tt = ea[s] - t0; if (tt > ISO_MAX) continue;
    if (tt <= 1800) stops30++;
    stations.push({ s, tt }); splat(D.sx[s], D.sy[s], tt);
  }
  const out = [];
  let area30 = 0;
  for (const [k, v] of cells) {
    const gx = Math.round(k / 100000), gy = k - gx * 100000;
    out.push({ p: [gx * cx, gy * cy], m: v / 60 });
    if (v <= 1800) area30++;
  }
  out.sort((a, b) => a.m - b.m);
  return { cells: out, stations, stops30, area30: area30 * CELL * CELL / 1e6, origin: [lon, lat] };
}

const bandColor = (m) => { for (const [lim, c] of BANDS) if (m <= lim) return c; return BANDS[BANDS.length - 1][1]; };

// ------------------------------------------------------------------ app
let D, map, overlay;
const headPos = new Float32Array(4000 * 2), headCol = new Uint8Array(4000 * 4), headTrip = new Int32Array(4000);
let headN = 0;

function vehicles(t) {
  let n = 0; const counts = { 0: 0, 2: 0 };
  for (let i = 0; i < D.N && n < 4000; i++) {
    if (t < D.tStart[i] || t > D.tEnd[i]) continue;
    const r = D.routes[D.tripRoute[i]]; if (!state.modes[r.mode === 3 ? 0 : r.mode]) continue;
    counts[r.mode === 2 ? 2 : 0]++;
    let lo = D.starts[i], hi = D.starts[i + 1] - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; D.ts[m] <= t ? lo = m : hi = m; }
    const t0 = D.ts[lo], t1 = D.ts[hi], f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    headPos[2 * n] = D.pos[2 * lo] + (D.pos[2 * hi] - D.pos[2 * lo]) * f;
    headPos[2 * n + 1] = D.pos[2 * lo + 1] + (D.pos[2 * hi + 1] - D.pos[2 * lo + 1]) * f;
    headCol.set([...r.color.map(c => Math.min(255, c + 60)), 255], 4 * n);
    headTrip[n] = i; n++;
  }
  headN = n; return counts;
}

function layers() {
  const t = state.t, iso = state.iso, dim = iso ? 0.6 : 1;
  const L = [];
  if (iso) L.push(isoLayer(iso));
  L.push(new deck.ScatterplotLayer({
    id: 'stations', data: D.stationData,
    getRadius: 18, radiusMinPixels: 0.8, radiusMaxPixels: 3, getFillColor: [200, 210, 255, 40],
  }));
  const trail = Math.min(900, Math.max(180, state.speed * 2.5));
  for (const b of D.buckets) {
    if (b.start > t || b.maxEnd < t - trail) continue;
    L.push(new deck.TripsLayer({
      id: 'trips-' + b.i0, data: b.data, _pathType: 'open',
      getColor: b.getColor,
      updateTriggers: { getColor: [state.modes[0], state.modes[2]] },
      opacity: 0.9 * dim, widthMinPixels: 2, widthMaxPixels: 4, getWidth: 6,
      trailLength: trail, currentTime: t, fadeTrail: true,
      parameters: ADDITIVE,
    }));
  }
  L.push(new deck.ScatterplotLayer({
    id: 'heads', data: { length: headN, attributes: { getPosition: { value: headPos, size: 2 }, getFillColor: { value: headCol, size: 4, normalized: true } } },
    getRadius: 30, radiusMinPixels: 2.2, radiusMaxPixels: 5, opacity: dim, pickable: true,
    parameters: NODEPTH,
  }));
  if (iso) L.push(new deck.ScatterplotLayer({
    id: 'origin', data: [iso.origin], getPosition: d => d, getRadius: 90, radiusMinPixels: 6,
    getFillColor: [255, 255, 255, 255], stroked: true, getLineColor: [255, 107, 139], lineWidthMinPixels: 3,
  }));
  return L;
}

const ADDITIVE = { blendFunc: [770, 1, 1, 1], blendEquation: 32774, depthTest: false }, NODEPTH = { depthTest: false };
const MATERIAL = { ambient: 0.6, diffuse: 0.5, shininess: 30 };
const FILTER = new deck.DataFilterExtension({ filterSize: 1 });
function isoLayer(iso) {
  return new deck.ColumnLayer({
    id: 'iso', data: iso.cells, extensions: [FILTER], getFilterValue: d => d.m, filterRange: [0, state.reveal], filterTransformSize: false, diskResolution: 4, angle: 45, radius: CELL * 0.72, extruded: true, coverage: 0.86,
    getPosition: d => d.p, getElevation: d => Math.pow(1 - d.m / 60, 2) * 520 + 8,
    getFillColor: d => [...bandColor(d.m), 150], material: MATERIAL,
    updateTriggers: { getFillColor: iso, getElevation: iso },
  });
}

function fmt(t) { t = Math.floor(t) % 86400; return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0'); }

let last = performance.now(), shown = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (state.playing) { state.t += dt * state.speed; if (state.t > DAY_END) state.t = DAY_START; }
  if (state.iso && state.reveal < 60) state.reveal = Math.min(60, state.reveal + dt * 45);
  const counts = vehicles(state.t);
  const total = counts[0] + counts[2];
  shown += (total - shown) * Math.min(1, dt * 8);
  $('active').textContent = Math.round(shown).toLocaleString('de-DE');
  $('m0').textContent = counts[0]; $('m2').textContent = counts[2];
  $('time').textContent = fmt(state.t);
  cursor.setAttribute('x', ((state.t - DAY_START) / (DAY_END - DAY_START) * 1000).toFixed(1));
  overlay.setProps({ layers: layers() });
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ timeline chart
let cursor;
function drawChart() {
  const svg = $('chart'), W = 1000, H = 60, B = D.B; svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let max = 0; for (let b = 0; b < B; b++) max = Math.max(max, D.hist[0][b] + D.hist[2][b]);
  const path = (fn) => { let s = `M0 ${H}`; for (let b = 0; b < B; b++) s += ` L${(b / (B - 1) * W).toFixed(1)} ${(H - fn(b) / max * (H - 4)).toFixed(1)}`; return s + ` L${W} ${H} Z`; };
  svg.innerHTML = `
    <defs><linearGradient id="gb" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4fd1ff" stop-opacity=".55"/><stop offset="1" stop-color="#4fd1ff" stop-opacity="0"/></linearGradient>
    <linearGradient id="gt" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffb347" stop-opacity=".9"/><stop offset="1" stop-color="#ff5e62" stop-opacity=".1"/></linearGradient></defs>
    <path d="${path(b => D.hist[0][b] + D.hist[2][b])}" fill="url(#gb)"/>
    <path d="${path(b => D.hist[0][b])}" fill="url(#gt)"/>
    <rect id="cursor" x="0" y="-4" width="2" height="${H + 4}" fill="#fff" opacity=".9"/>`;
  cursor = svg.querySelector('#cursor');
  const ticks = $('ticks'); ticks.innerHTML = '';
  for (let h = 5; h <= 25; h += 2) ticks.innerHTML += `<span style="left:${(h * 3600 - DAY_START) / (DAY_END - DAY_START) * 100}%">${String(h % 24).padStart(2, '0')}:00</span>`;
  const tl = document.querySelector('.timeline');
  const seek = (e) => {
    const r = svg.getBoundingClientRect(), x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    state.t = DAY_START + x * (DAY_END - DAY_START); if (state.iso) runIso(state.iso.origin);
  };
  let drag = false;
  tl.addEventListener('pointerdown', e => { drag = true; tl.setPointerCapture(e.pointerId); seek(e); });
  tl.addEventListener('pointermove', e => drag && seek(e));
  tl.addEventListener('pointerup', () => drag = false);
}

// ------------------------------------------------------------------ reachability UI
function runIso([lon, lat]) {
  const t0 = performance.now();
  const r = isochrone(D, lon, lat, Math.round(state.t));
  const ms = performance.now() - t0;
  const fresh = !state.iso || state.iso.origin[0] !== lon || state.iso.origin[1] !== lat;
  state.iso = r; if (fresh) state.reveal = 0;
  const nearest = D.near(lon, lat, 1500).sort((a, b) => a[1] - b[1])[0];
  $('isoTitle').textContent = (nearest ? D.sname[nearest[0]] : 'Gewählter Ort') + ' · ' + fmt(state.t);
  $('isoStops').textContent = r.stops30.toLocaleString('de-DE');
  $('isoArea').textContent = r.area30.toFixed(1).replace('.', ',');
  $('iso').classList.remove('hidden');
  $('iso').querySelector('.hint').textContent = `Kürzeste Reisezeit inkl. Umstiege & Fußwege – ${D.C.toLocaleString('de-DE')} Verbindungen in ${ms.toFixed(0)} ms im Browser gescannt (Connection Scan Algorithm).`;
  $('hint').style.opacity = 0;
}

function init(raw) {
  D = build(raw);
  D.stationPos = new Float32Array(D.S * 2); for (let i = 0; i < D.S; i++) { D.stationPos[2 * i] = D.sx[i]; D.stationPos[2 * i + 1] = D.sy[i]; }
  D.stationData = { length: D.S, attributes: { getPosition: { value: D.stationPos, size: 2 } } };
  // 20-min buckets of trips (by start time); only buckets that can be visible at time t get drawn
  D.buckets = [];
  for (let i0 = 0; i0 < D.N;) {
    let i1 = i0, lim = D.tStart[i0] + 1200, maxEnd = 0;
    while (i1 < D.N && D.tStart[i1] < lim) maxEnd = Math.max(maxEnd, D.tEnd[i1++]);
    const off = D.starts[i0], end = D.starts[i1], si = new Uint32Array(i1 - i0 + 1);
    for (let k = i0; k <= i1; k++) si[k - i0] = D.starts[k] - off;
    D.buckets.push({ i0, start: D.tStart[i0], maxEnd, data: { length: i1 - i0, startIndices: si,
      attributes: { getPath: { value: D.pos.subarray(2 * off, 2 * end), size: 2 }, getTimestamps: { value: D.ts.subarray(off, end), size: 1 } } } });
    const b = D.buckets[D.buckets.length - 1];
    b.getColor = (_, { index }) => { const r = D.routes[D.tripRoute[b.i0 + index]]; return [...r.color, state.modes[r.mode === 3 ? 0 : r.mode] ? 255 : 0]; };
    i0 = i1;
  }
  window.__pulse = { state, D, get map() { return map; } };
  D.modeOn = (tr) => { const m = D.routes[D.tripRoute[tr]].mode; return state.modes[m === 3 ? 0 : m]; };

  const d = new Date(raw.meta.day.slice(0, 4) + '-' + raw.meta.day.slice(4, 6) + '-' + raw.meta.day.slice(6));
  $('day').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('facts').innerHTML = `<div><span>${D.N.toLocaleString('de-DE')}</span> Fahrten heute</div><div><span>${D.S.toLocaleString('de-DE')}</span> Haltestellen</div><div><span>${D.C.toLocaleString('de-DE')}</span> Verbindungen</div><div>Daten: VRN GTFS · CC BY 4.0</div>`;
  $('legend').innerHTML = BANDS.map(([m, c], i) => `<div><i style="background:rgb(${c})"></i>${i ? BANDS[i - 1][0] : 0}–${m}′</div>`).join('');

  map = new maplibregl.Map({
    container: 'map', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [8.52, 49.455], zoom: 10.4, pitch: 0, bearing: 0, antialias: true, attributionControl: { compact: true },
  });
  map.on('load', () => {
    // mute basemap so the light trails carry the image
    for (const l of map.getStyle().layers) {
      if (l.type === 'symbol') map.setPaintProperty(l.id, 'text-opacity', 0.55);
    }
    const narrow = innerWidth < 720;
    map.flyTo({ center: narrow ? [8.5, 49.47] : [8.535, 49.468], zoom: narrow ? 10.5 : 11.6, pitch: 50, bearing: -18, duration: 4500, essential: true });
  });
  overlay = new deck.MapboxOverlay({
    interleaved: false, layers: [],
    onClick: (info) => { if (info.coordinate) runIso(info.coordinate); },
    onHover: (info) => {
      const tip = $('tip');
      if (info.layer && info.layer.id === 'heads' && info.index >= 0) {
        const tr = headTrip[info.index], r = D.routes[D.tripRoute[tr]];
        tip.innerHTML = `<b style="color:rgb(${r.color})">${r.mode === 2 ? 'Bus' : r.mode === 3 ? 'Fähre' : 'Tram'} ${r.name}</b>${D.tripHead[tr] ? '→ ' + D.tripHead[tr] : ''}`;
        tip.style.display = 'block'; tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
      } else tip.style.display = 'none';
    },
  });
  map.addControl(overlay);
  map.getCanvas().style.cursor = 'crosshair';

  drawChart();
  $('play').onclick = () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; };
  $('speed').onclick = (e) => {
    const s = e.target.dataset.s; if (!s) return; state.speed = +s;
    for (const b of $('speed').children) b.classList.toggle('on', b === e.target);
  };
  document.querySelectorAll('.mode input').forEach(inp => inp.onchange = () => {
    state.modes[inp.dataset.mode] = inp.checked; if (state.iso) runIso(state.iso.origin);
  });
  $('isoClose').onclick = () => { state.iso = null; $('iso').classList.add('hidden'); };
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
    if (e.code === 'Escape') $('isoClose').click();
  });

  $('loader').classList.add('done');
  requestAnimationFrame(frame);
}

load().then(init).catch(err => { $('loadmsg').textContent = 'Fehler: ' + err.message; console.error(err); });
})();
