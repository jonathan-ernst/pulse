# PULSE · Rhein-Neckar in Bewegung

**Ein kompletter Werktag ÖPNV in Mannheim, Ludwigshafen und Heidelberg: 14.008 echte Fahrten aus dem offiziellen Fahrplan, als Echtzeit-Simulation im Browser. Dazu eine Erreichbarkeitsanalyse, die mit einem Klick zeigt, wie weit man in 60 Minuten kommt.**

> _Screenshot / GIF hier einfügen_

## Was es kann

- **Live-Simulation:** Jede Tram und jeder Bus des VRN-Fahrplans (Mi., 18.11.2026) fährt entlang der echten Streckengeometrie, inklusive Haltezeiten. Zeitraffer von 30× bis 600×, Scrubbing über die Tageskurve.
- **Erreichbarkeits-Skyline:** Klick auf einen beliebigen Ort, dann berechnet der Browser die kürzeste Reisezeit zu allen 2.354 Haltestellen, mit Umstiegen und Fußwegen. Das Ergebnis erscheint als 3D-Raster (150 m), dessen Höhe und Farbe die Reisezeit zeigen.
- **Kennzahlen:** aktive Fahrzeuge nach Verkehrsmittel, Haltestellen und Fläche in ≤ 30 min, Tagesganglinie des Angebots.

**Realer Nutzen:** Genau diese Fragen stellen sich Stadtplanung, Immobilienbewertung und Standortwahl: „Wie gut ist dieser Ort angebunden, und um welche Uhrzeit?“

## Technik

| Baustein | Umsetzung |
|---|---|
| Daten | VRN GTFS (≈ 850 MB roh) → `scripts/build_data.py` (nur Standardbibliothek, streamend) → 6,9 MB JSON (≈ 0,6 MB gzip): delta-kodierte Shapes, Stop→Vertex-Mapping |
| Rendering | deck.gl 9 (WebGL): `TripsLayer` mit ~3 Mio. Vertices, in 20-Minuten-Buckets, sodass nur sichtbare Zeitfenster auf die GPU gehen. Basiskarte: MapLibre und CARTO Dark Matter |
| Routing | **Connection Scan Algorithm** über ~250.000 Verbindungen in typisierten Arrays, ≈ 15–40 ms pro Anfrage, komplett clientseitig |
| Analyse | Raster-„Splatting“ (Reisezeit + Fußweg ab Haltestelle), Flächenberechnung, GPU-Filter für die Wachstumsanimation |

Kein Backend, kein Build-Step: statische Dateien, direkt auf GitHub Pages hostbar.

## Lokal starten

```bash
python3 -m http.server 8765
```

Danach http://localhost:8765 öffnen. Bedienung: Leertaste = Pause, Esc = Analyse schließen, Klick auf die Karte = Erreichbarkeit.

## Daten neu erzeugen

```bash
# GTFS-Feed des VRN (z. B. über mobilitydatabase.org, Feed mdb-1173) entpacken, dann:
python3 scripts/build_data.py path/to/gtfs 20261118
```

Region (Bounding Box) und Stichtag lassen sich im Skript anpassen.

## Hinweise

- Der VRN-Feed enthält Tram, Bus, Fähre und Bergbahn. S-Bahn und Regionalzüge (DB) sind nicht enthalten.
- Fahrplandaten: © Verkehrsverbund Rhein-Neckar (VRN), Lizenz [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Karte: © OpenStreetMap-Mitwirkende, © CARTO.
