#!/usr/bin/env python3
"""
Pulse – GTFS preprocessor.

Turns a raw GTFS feed (VRN, Rhein-Neckar) into one compact JSON file the
browser can animate and route on. Pure standard library, streams the large
files, so it runs on a laptop in about a minute.

    python3 scripts/build_data.py <gtfs_dir> [YYYYMMDD]

Output: data/rhein-neckar.json
"""
import csv, json, math, sys, os, datetime
from collections import defaultdict

GTFS = sys.argv[1]
DAY = sys.argv[2] if len(sys.argv) > 2 else "20261118"  # a regular Wednesday
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "rhein-neckar.json")

# Core area: Mannheim · Ludwigshafen · Heidelberg · Schwetzingen · Weinheim
BBOX = (8.30, 49.30, 8.85, 49.60)  # lon_min, lat_min, lon_max, lat_max
SIMPLIFY_M = 25                    # drop shape points closer than this
MODE = {"0": 0, "900": 0, "2": 1, "100": 1, "109": 1, "106": 1, "3": 2, "700": 2, "4": 3, "7": 0}  # tram, rail, bus, ferry


def rows(name):
    with open(os.path.join(GTFS, name), newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def inside(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def hms(s):
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def meters(a, b):
    dx = (a[0] - b[0]) * 111320 * math.cos(math.radians(a[1]))
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


# ---------------------------------------------------------------- services
d = datetime.datetime.strptime(DAY, "%Y%m%d")
wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
active = {r["service_id"] for r in rows("calendar.txt")
          if r[wd] == "1" and r["start_date"] <= DAY <= r["end_date"]}
for r in rows("calendar_dates.txt"):
    if r["date"] == DAY:
        (active.add if r["exception_type"] == "1" else active.discard)(r["service_id"])
print("active services", len(active))

# ---------------------------------------------------------------- stops → stations
stops = {}
for r in rows("stops.txt"):
    lon, lat = float(r["stop_lon"]), float(r["stop_lat"])
    sid = r["stop_id"]
    parent = r.get("parent_station") or ":".join(sid.split(":")[:3])
    stops[sid] = (lon, lat, parent, r["stop_name"])

# ---------------------------------------------------------------- routes / trips
routes = {r["route_id"]: r for r in rows("routes.txt")}
trips = {}
for r in rows("trips.txt"):
    if r["service_id"] in active:
        trips[r["trip_id"]] = r
print("trips today", len(trips))

# ---------------------------------------------------------------- stop_times (stream)
st = defaultdict(list)
for r in rows("stop_times.txt"):
    t = r["trip_id"]
    if t not in trips or r["stop_id"] not in stops:
        continue
    st[t].append((int(r["stop_sequence"]), r["stop_id"], hms(r["arrival_time"] or r["departure_time"]),
                  hms(r["departure_time"] or r["arrival_time"]), float(r["shape_dist_traveled"] or -1)))

keep = {}
for t, seq in st.items():
    seq.sort()
    idx = [i for i, s in enumerate(seq) if inside(*stops[s[1]][:2])]
    if len(idx) < 2:
        continue
    lo, hi = max(idx[0] - 1, 0), min(idx[-1] + 1, len(seq) - 1)   # one stop of context beyond the box
    keep[t] = seq[lo:hi + 1]
print("trips in area", len(keep))

need_shapes = {trips[t]["shape_id"] for t in keep}

# ---------------------------------------------------------------- shapes (stream, 700 MB)
shp = defaultdict(list)
for r in rows("shapes.txt"):
    s = r["shape_id"]
    if s in need_shapes:
        shp[s].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"]),
                       float(r["shape_dist_traveled"] or 0)))
print("shapes", len(shp))

# ---------------------------------------------------------------- assemble
station_ix, stations = {}, []
station_acc = defaultdict(lambda: [0.0, 0.0, 0, ""])


def station(stop_id):
    lon, lat, parent, name = stops[stop_id]
    a = station_acc[parent]
    a[0] += lon; a[1] += lat; a[2] += 1; a[3] = a[3] or name
    if parent not in station_ix:
        station_ix[parent] = len(station_ix)
    return station_ix[parent]


route_ix, route_list = {}, []


def route(rid):
    if rid not in route_ix:
        r = routes[rid]
        mode = MODE.get(r["route_type"], 2)
        route_ix[rid] = len(route_list)
        route_list.append([r["route_short_name"] or r["route_long_name"][:20], mode, r.get("route_color") or ""])
    return route_ix[rid]


# Simplified shape cache: (shape_id) -> (coords, cum_dist)
shape_ix, shape_out, shape_cache = {}, [], {}


def shape(sid):
    if sid in shape_cache:
        return shape_cache[sid]
    pts = sorted(shp.get(sid, []))
    coords, dist = [], []
    for _, lon, lat, dd in pts:
        if coords and meters(coords[-1], (lon, lat)) < SIMPLIFY_M and _ != pts[-1][0]:
            continue
        coords.append((lon, lat)); dist.append(dd)
    shape_cache[sid] = (coords, dist)
    return shape_cache[sid]


def nearest_vertex(coords, dist, d0, pt, start):
    """Vertex index for a stop: by shape distance when present, else geometrically."""
    if d0 >= 0 and dist and dist[-1] > 0:
        best = start
        for i in range(start, len(dist)):
            if dist[i] >= d0 - 1e-6:
                return i if (i == 0 or abs(dist[i] - d0) <= abs(dist[i - 1] - d0) or i - 1 < start) else i - 1
            best = i
        return best
    best, bd = start, 1e18
    for i in range(start, len(coords)):
        m = meters(coords[i], pt)
        if m < bd:
            best, bd = i, m
    return best


trips_out = []
for t, seq in keep.items():
    tr = trips[t]
    coords, dist = shape(tr["shape_id"])
    rec_stops = []
    if len(coords) >= 2:
        v = 0
        for _, sid, arr, dep, sd in seq:
            v = nearest_vertex(coords, dist, sd, stops[sid][:2], v)
            rec_stops.append((station(sid), v, arr, dep))
        if rec_stops[-1][1] <= rec_stops[0][1]:
            coords = None
    if len(coords or []) < 2:
        # no usable shape → straight lines between stops
        sid_key = "__" + t
        coords = [stops[s[1]][:2] for s in seq]
        shape_cache[sid_key] = (coords, [])
        tr = dict(tr, shape_id=sid_key)
        rec_stops = [(station(s[1]), i, s[2], s[3]) for i, s in enumerate(seq)]
    sid = tr["shape_id"]
    if sid not in shape_ix:
        shape_ix[sid] = len(shape_out)
        c = shape_cache[sid][0]
        flat, px, py = [], 0, 0
        for lon, lat in c:
            x, y = round(lon * 1e5), round(lat * 1e5)
            flat += [x - px, y - py]; px, py = x, y
        shape_out.append(flat)
    flat, pt = [], 0
    for s, v, arr, dep in rec_stops:
        flat += [s, v, arr - pt, dep - arr]; pt = dep
    trips_out.append([route(tr["route_id"]), shape_ix[sid], (tr.get("trip_headsign") or "")[:40], flat])

for key, i in sorted(station_ix.items(), key=lambda kv: kv[1]):
    a = station_acc[key]
    stations.append([a[3], round(a[0] / a[2] * 1e5), round(a[1] / a[2] * 1e5)])

out = {
    "meta": {"region": "Rhein-Neckar", "day": DAY, "source": "VRN Soll-Fahrplandaten (GTFS), CC BY 4.0",
             "bbox": BBOX},
    "routes": route_list, "stations": stations, "shapes": shape_out, "trips": trips_out,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
print("stations", len(stations), "shapes", len(shape_out), "trips", len(trips_out),
      "size MB", round(os.path.getsize(OUT) / 1e6, 1))
