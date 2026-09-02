import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GeoJSON, MapContainer, TileLayer } from "react-leaflet";
import type { Layer } from "leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import { useBundle } from "../hooks/useBundle";
import type { GeoRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Baked in at build time by Vite. Present on the deployed app (Railway VITE_MAPTILER_KEY);
// absent in local dev, where we fall back to a free, keyless OpenStreetMap basemap.
const MAPTILER_KEY = (import.meta.env as Record<string, string | undefined>).VITE_MAPTILER_KEY;
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const TILES = MAPTILER_KEY
  ? { url: `https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, attribution: `© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> ${OSM_ATTR}`, subdomains: [] as string[] }
  : { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: OSM_ATTR, subdomains: ["a", "b", "c"] };

type MetricKey = "cost" | "clicks" | "conv" | "conv_value" | "ctr";
const METRICS: { key: MetricKey; label: string; fmt: (v: number) => string; sqrt: boolean }[] = [
  { key: "cost", label: "Spend", fmt: (v) => money(v), sqrt: true },
  { key: "clicks", label: "Clicks", fmt: (v) => num(v), sqrt: true },
  { key: "conv", label: "Conversions", fmt: (v) => num(v, 1), sqrt: true },
  { key: "conv_value", label: "Conv Value", fmt: (v) => money(v), sqrt: true },
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
const norm = (s: string) => s.trim().toLowerCase();

export function GeoMap() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const geo = useQuery({
    queryKey: ["us-states-geojson"],
    staleTime: Infinity,
    queryFn: async (): Promise<FeatureCollection> => {
      const r = await fetch(`${import.meta.env.BASE_URL}us-states.geojson`);
      if (!r.ok) throw new Error("Failed to load map boundaries");
      return r.json();
    },
  });
  const [metric, setMetric] = useState<MetricKey>("cost");

  const g = data?.geo_performance;
  const byName = useMemo(() => {
    const m = new Map<string, GeoRow>();
    (g?.rows ?? []).forEach((r) => m.set(norm(r.location), r));
    return m;
  }, [g]);

  const featureNames = useMemo(
    () => new Set((geo.data?.features ?? []).map((f) => norm((f.properties as { name?: string })?.name ?? ""))),
    [geo.data],
  );
  // rows whose location has no polygon in this (US-only) boundary set — surfaced below the map.
  const offMap = useMemo(() => (g?.rows ?? []).filter((r) => !featureNames.has(norm(r.location))).sort((a, b) => b.cost - a.cost), [g, featureNames]);
  const maxVal = useMemo(() => {
    let mx = 0;
    (g?.rows ?? []).forEach((r) => { const v = r[metric] ?? 0; if (featureNames.has(norm(r.location)) && v > mx) mx = v; });
    return mx;
  }, [g, metric, featureNames]);

  if (isLoading || geo.isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (geo.error) return <ErrorState msg={(geo.error as Error).message} />;
  if (!g || !g.rows.length) return <Empty what="No geographic data for this client." />;

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const scaleT = (v: number) => (maxVal <= 0 ? 0 : metricDef.sqrt ? Math.sqrt(v / maxVal) : v / maxVal);

  const styleFn = (feature?: Feature<Geometry, { name?: string }>) => {
    const row = feature ? byName.get(norm(feature.properties?.name ?? "")) : undefined;
    const v = row ? row[metric] ?? 0 : 0;
    const has = !!row && v > 0;
    return { fillColor: has ? ramp(scaleT(v)) : "#e5e7eb", fillOpacity: has ? 0.82 : 0.25, weight: 0.8, color: "#ffffff", opacity: 1 };
  };
  const onEach = (feature: Feature<Geometry, { name?: string }>, layer: Layer) => {
    const name = feature.properties?.name ?? "";
    const row = byName.get(norm(name));
    const body = row
      ? `<div style="font-weight:600;margin-bottom:2px">${name}</div>
         <div>Spend: <b>${money(row.cost)}</b></div>
         <div>Conversions: <b>${num(row.conv, 1)}</b></div>
         <div>Conv Value: <b>${money(row.conv_value)}</b></div>
         <div>CTR: <b>${pct(row.ctr, 2)}</b> · Clicks: ${num(row.clicks)}</div>`
      : `<div style="font-weight:600">${name}</div><div style="color:#6b7280">No spend in range</div>`;
    layer.bindTooltip(body, { sticky: true, className: "geo-tt", direction: "top" });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold">Map</h2>
          <div className="text-[12.5px] text-text-muted">
            {metricDef.label} by state · US states shaded by performance{!MAPTILER_KEY && " · dev basemap"}
          </div>
        </div>
        <div className="inline-flex shrink-0 overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`px-3 py-1 text-[13px] font-medium ${metric === m.key ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[10px] border border-border" style={{ height: 580 }}>
        <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
          <TileLayer url={TILES.url} attribution={TILES.attribution} subdomains={TILES.subdomains} />
          {geo.data && <GeoJSON key={metric} data={geo.data} style={styleFn} onEachFeature={onEach} />}
        </MapContainer>
        {/* legend */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-[8px] border border-border bg-surface/95 px-3 py-2 text-[11px] shadow-sm">
          <div className="mb-1 font-semibold text-text-secondary">{metricDef.label}</div>
          <div className="h-2 w-40 rounded" style={{ background: `linear-gradient(90deg, ${ramp(0)}, ${ramp(0.5)}, ${ramp(1)})` }} />
          <div className="mt-0.5 flex justify-between text-text-muted">
            <span>0</span>
            <span>{metricDef.fmt(maxVal)}</span>
          </div>
        </div>
      </div>

      {offMap.length > 0 && (
        <div className="mt-3 rounded-[8px] border border-border bg-surface-alt px-3 py-2 text-[12px] text-text-secondary">
          <span className="font-medium">Not on the US map ({offMap.length}):</span>{" "}
          {offMap.map((r, i) => (
            <span key={r.location}>{i > 0 && " · "}{r.location} ({metricDef.fmt(r[metric] ?? 0)})</span>
          ))}
          <span className="text-text-muted"> — add the world boundary set to shade these.</span>
        </div>
      )}
    </div>
  );
}
