import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Circle, GeoJSON, MapContainer, Marker, Popup, TileLayer, useMapEvents } from "react-leaflet";
import L, { type Layer } from "leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import { useBundle } from "../hooks/useBundle";
import { getGeoTargets, getLocations } from "../lib/api";
import type { GeoLevelKey, GeoRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Baked in at build time by Vite. Present on the deployed app (Railway VITE_MAPTILER_KEY);
// absent in local dev, where we fall back to a free, keyless OpenStreetMap basemap.
const MAPTILER_KEY = (import.meta.env as Record<string, string | undefined>).VITE_MAPTILER_KEY;
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const TILES = MAPTILER_KEY
  ? { url: `https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, attribution: `© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> ${OSM_ATTR}`, subdomains: [] as string[] }
  : { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: OSM_ATTR, subdomains: ["a", "b", "c"] };

// Every metric the Geographic report carries.
type MetricKey = "cost" | "clicks" | "impr" | "conv" | "conv_value" | "cpa" | "cvr" | "ctr";
const METRICS: { key: MetricKey; label: string; fmt: (v: number) => string; sqrt: boolean }[] = [
  { key: "cost", label: "Spend", fmt: (v) => money(v), sqrt: true },
  { key: "clicks", label: "Clicks", fmt: (v) => num(v), sqrt: true },
  { key: "impr", label: "Impressions", fmt: (v) => num(v), sqrt: true },
  { key: "conv", label: "Conversions", fmt: (v) => num(v, 1), sqrt: true },
  { key: "conv_value", label: "Conv Value", fmt: (v) => money(v), sqrt: true },
  { key: "cpa", label: "CPA", fmt: (v) => money(v, 2), sqrt: true },
  { key: "cvr", label: "CVR", fmt: (v) => pct(v, 2), sqrt: false },
  { key: "ctr", label: "CTR", fmt: (v) => pct(v, 2), sqrt: false },
];

// Sequential light→dark ramp (more = darker). Neutral hue, no good/bad implication.
const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
function ramp(t: number) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[239, 246, 255], [147, 197, 253], [37, 99, 235], [30, 58, 138]]; // #eff6ff → #93c5fd → #2563eb → #1e3a8a
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const u = t * (stops.length - 1) - seg;
  const a = stops[seg], b = stops[seg + 1];
  return `rgb(${lerp(a[0], b[0], u)},${lerp(a[1], b[1], u)},${lerp(a[2], b[2], u)})`;
}
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
// Boundary feature carries a display name plus every name alias (English/local/etc.) it
// can be matched against — Google Ads location names vary ("Hessen" vs "Hesse").
type FProps = { name?: string; match?: string[] };
const aliases = (p?: FProps) => p?.match ?? (p?.name ? [norm(p.name)] : []);

// Teardrop pin as an HTML div-icon — avoids Leaflet's default marker-image URLs, which
// break under Vite's bundler.
const PIN = L.divIcon({
  className: "",
  html: '<div style="width:14px;height:14px;border-radius:50% 50% 50% 0;background:#1a1a1a;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 14],
  popupAnchor: [0, -14],
});

// Level-of-detail: each geographic grain the bundle can carry, paired with its boundary
// file and the zoom at which it takes over. Coarse → fine. A level renders only when the
// export carries that grain AND its boundary file exists (metro/city have no polygons yet,
// so they quietly fall back to the finest level that does). Zooming in reveals finer detail.
const BOUNDARIES: { key: GeoLevelKey; file: string; minZoom: number }[] = [
  { key: "state", file: "world-states.geojson", minZoom: 0 },
  { key: "county", file: "us-counties.geojson", minZoom: 6 },
];

// The finest boundary level that (a) has data and (b) whose minZoom the current zoom has
// reached. Always resolves to something when `available` is non-empty (state at minZoom 0).
function pickLevel(zoom: number, available: Set<string>): typeof BOUNDARIES[number] | undefined {
  let chosen: typeof BOUNDARIES[number] | undefined;
  for (const b of BOUNDARIES) {
    if (!available.has(b.key)) continue;
    if (!chosen || zoom >= b.minZoom) chosen = b;   // finest reached wins
  }
  return chosen;
}

// Reports live zoom changes out of the Leaflet map into React state.
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  return null;
}

export function GeoMap() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const g = data?.geo_performance;
  const hasGeo = !!g?.rows?.length;

  // The grains this bundle carries. Older bundles have no `levels` — synthesize a lone
  // state level from the base rows so everything below is level-driven uniformly.
  const levelsMap = useMemo(
    () => (g?.levels ?? (g ? { state: { dimension: g.dimension, rows: g.rows, totals: g.totals } } : {})) as Record<string, { dimension: string; rows: GeoRow[] }>,
    [g],
  );
  const available = useMemo(() => {
    const s = new Set<string>();
    BOUNDARIES.forEach((b) => { if (levelsMap[b.key]?.rows?.length) s.add(b.key); });
    return s;
  }, [levelsMap]);

  const [zoom, setZoom] = useState(4);
  const [metric, setMetric] = useState<MetricKey>("cost");
  const [showTargets, setShowTargets] = useState(true);

  // Level-of-detail: the current zoom picks the grain; its boundary file loads lazily.
  const active = hasGeo ? pickLevel(zoom, available) : undefined;
  const activeRows: GeoRow[] = active ? (levelsMap[active.key]?.rows ?? []) : [];
  const activeDim = active ? levelsMap[active.key]?.dimension ?? "Region" : "Region";
  const finest = [...BOUNDARIES].reverse().find((b) => available.has(b.key)); // deepest grain with data

  const geo = useQuery({
    queryKey: ["geo-boundary", active?.file],
    staleTime: Infinity,
    enabled: hasGeo && !!active,
    placeholderData: (prev) => prev,   // keep the current boundaries on screen while a finer set loads
    queryFn: async (): Promise<FeatureCollection> => {
      const r = await fetch(`${import.meta.env.BASE_URL}${active!.file}`);
      if (!r.ok) throw new Error("Failed to load map boundaries");
      return r.json();
    },
  });
  const locations = useQuery({ queryKey: ["locations", clientId], queryFn: () => getLocations(clientId) });
  // Best-effort — the endpoint returns empty (never errors) when the Ads API isn't reachable.
  const geoTargets = useQuery({ queryKey: ["geo-targets", clientId], queryFn: () => getGeoTargets(clientId), retry: false });

  const pins = (locations.data?.locations ?? []).filter((l) => l.lat != null && l.lng != null);
  const targets = geoTargets.data?.targets ?? [];
  const radiusTargets = targets.filter((t) => t.type === "radius" && t.lat != null && t.lng != null && t.radius_m);
  const targetRegions = useMemo(() => new Set(targets.filter((t) => t.type === "location" && t.name).map((t) => norm(t.name as string))), [targets]);
  const hasTargets = radiusTargets.length > 0 || targetRegions.size > 0;

  // A row can be matched by its bare name and — for finer grains — by its state-qualified
  // form ("Suffolk County, New York"), which disambiguates same-named counties across
  // states. Google's matched-location cells often trail the country ("…, United States"),
  // so strip that before keying.
  const stripCountry = (s: string) => s.replace(/,\s*(united states|usa|us)$/, "").trim();
  const rowKeys = (r: GeoRow) => {
    const loc = stripCountry(norm(r.location));
    const keys = new Set([loc]);
    if (r.region) keys.add(`${loc}, ${norm(r.region)}`);
    return [...keys];
  };
  const byName = useMemo(() => {
    const m = new Map<string, GeoRow>();
    activeRows.forEach((r) => rowKeys(r).forEach((k) => { if (!m.has(k)) m.set(k, r); }));
    return m;
  }, [activeRows]);

  // every name alias present in the active boundary set — a location is "on the map" if it matches one.
  const matchSet = useMemo(() => {
    const s = new Set<string>();
    (geo.data?.features ?? []).forEach((f) => aliases(f.properties as FProps).forEach((m) => s.add(m)));
    return s;
  }, [geo.data]);
  const rowFor = (f?: Feature<Geometry, FProps>) => {
    for (const m of aliases(f?.properties)) { const r = byName.get(m); if (r) return r; }
    return undefined;
  };
  // rows whose location has no polygon in the active boundary set — surfaced below the map.
  const offMap = useMemo(() => activeRows.filter((r) => !rowKeys(r).some((k) => matchSet.has(k))).sort((a, b) => b.cost - a.cost), [activeRows, matchSet]);
  const maxVal = useMemo(() => {
    let mx = 0;
    activeRows.forEach((r) => { const v = r[metric] ?? 0; if (rowKeys(r).some((k) => matchSet.has(k)) && v > mx) mx = v; });
    return mx;
  }, [activeRows, metric, matchSet]);

  if (isLoading || locations.isLoading || (hasGeo && geo.isLoading && !geo.data)) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (hasGeo && geo.error && !geo.data) return <ErrorState msg={(geo.error as Error).message} />;
  if (!hasGeo && pins.length === 0 && !hasTargets)
    return <Empty what="No geographic data or saved locations yet. Add locations in Setup → Locations to see them on the map." />;

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const scaleT = (v: number) => (maxVal <= 0 ? 0 : metricDef.sqrt ? Math.sqrt(v / maxVal) : v / maxVal);

  const styleFn = (feature?: Feature<Geometry, FProps>) => {
    const row = rowFor(feature);
    const v = row ? row[metric] ?? 0 : 0;
    const has = !!row && v > 0;
    const targeted = showTargets && targetRegions.size > 0 && aliases(feature?.properties).some((a) => targetRegions.has(a));
    return {
      fillColor: has ? ramp(scaleT(v)) : "#e5e7eb",
      fillOpacity: has ? 0.82 : 0.25,
      weight: targeted ? 2.4 : 0.8,
      color: targeted ? "#1a1a1a" : "#ffffff",
      opacity: 1,
    };
  };
  const onEach = (feature: Feature<Geometry, FProps>, layer: Layer) => {
    const name = feature.properties?.name ?? "";
    const row = rowFor(feature);
    const body = row
      ? `<div style="font-weight:600;margin-bottom:2px">${name}</div>
         <div>Spend: <b>${money(row.cost)}</b> · CPA: <b>${row.cpa ? money(row.cpa, 2) : "—"}</b></div>
         <div>Clicks: <b>${num(row.clicks)}</b> · Impr: <b>${num(row.impr)}</b> · CTR: <b>${pct(row.ctr, 2)}</b></div>
         <div>Conv: <b>${num(row.conv, 1)}</b> · CVR: <b>${pct(row.cvr, 2)}</b> · Value: <b>${money(row.conv_value)}</b></div>`
      : `<div style="font-weight:600">${name}</div><div style="color:#6b7280">No data in range</div>`;
    layer.bindTooltip(body, { sticky: true, className: "geo-tt", direction: "top" });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold">Map</h2>
          <div className="text-[12.5px] text-text-muted">
            {hasGeo ? `${metricDef.label} by ${activeDim} · shaded by performance` : "Client locations & campaign geo-targets"}
            {!MAPTILER_KEY && " · dev basemap"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {hasTargets && (
            <button
              onClick={() => setShowTargets((v) => !v)}
              className={`rounded-[7px] border px-3 py-1 text-[13px] font-medium ${showTargets ? "border-ink bg-ink text-accent" : "border-border-strong text-text-muted hover:text-ink"}`}
            >
              Geo-targets
            </button>
          )}
          {hasGeo && (
            <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              Metric
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as MetricKey)}
                className="rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px] font-medium normal-case tracking-normal text-ink focus:border-ink focus:outline-none"
              >
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[10px] border border-border" style={{ height: 580 }}>
        <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
          <ZoomWatcher onZoom={setZoom} />
          <TileLayer url={TILES.url} attribution={TILES.attribution} subdomains={TILES.subdomains} />
          {hasGeo && geo.data && <GeoJSON key={`${active?.key}:${geo.data.features.length}:${metric}:${showTargets}:${targetRegions.size}`} data={geo.data} style={styleFn} onEachFeature={onEach} />}
          {showTargets && radiusTargets.map((t, i) => (
            <Circle key={i} center={[t.lat as number, t.lng as number]} radius={t.radius_m as number}
              pathOptions={{ color: "#1a1a1a", weight: 1.5, fillColor: "#1a1a1a", fillOpacity: 0.06 }}>
              <Popup>
                <div style={{ fontWeight: 600 }}>{t.campaign}</div>
                <div style={{ color: "#6b7280" }}>Radius target · {((t.radius_m as number) / 1609.34).toFixed(0)} mi</div>
              </Popup>
            </Circle>
          ))}
          {pins.map((l) => (
            <Marker key={l.id} position={[l.lat as number, l.lng as number]} icon={PIN}>
              <Popup>
                <div style={{ fontWeight: 600 }}>{l.name}</div>
                <div style={{ color: "#6b7280" }}>{l.address}</div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        {/* zoom-to-drill hint — only while a finer grain with data is still hidden */}
        {hasGeo && finest && active && finest.key !== active.key && (
          <div className="pointer-events-none absolute right-3 top-3 z-[500] rounded-full border border-border bg-surface/95 px-3 py-1 text-[11px] font-medium text-text-secondary shadow-sm">
            Zoom in for {levelsMap[finest.key]?.dimension ?? "finer"} detail
          </div>
        )}
        {/* legend */}
        {hasGeo && (
          <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-[8px] border border-border bg-surface/95 px-3 py-2 text-[11px] shadow-sm">
            <div className="mb-1 font-semibold text-text-secondary">{metricDef.label}</div>
            <div className="h-2 w-40 rounded" style={{ background: `linear-gradient(90deg, ${ramp(0)}, ${ramp(0.5)}, ${ramp(1)})` }} />
            <div className="mt-0.5 flex justify-between text-text-muted">
              <span>0</span>
              <span>{metricDef.fmt(maxVal)}</span>
            </div>
          </div>
        )}
      </div>

      {hasGeo && offMap.length > 0 && (
        <div className="mt-3 rounded-[8px] border border-border bg-surface-alt px-3 py-2 text-[12px] text-text-secondary">
          <span className="font-medium">Not matched to a region ({offMap.length}):</span>{" "}
          {offMap.map((r, i) => (
            <span key={r.location}>{i > 0 && " · "}{r.location} ({metricDef.fmt(r[metric] ?? 0)})</span>
          ))}
        </div>
      )}
    </div>
  );
}
