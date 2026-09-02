import { MapContainer, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// Baked in at build time by Vite. Present on the deployed app (Railway VITE_MAPTILER_KEY);
// absent in local dev, where we fall back to a free, keyless Carto basemap.
const MAPTILER_KEY = (import.meta.env as Record<string, string | undefined>).VITE_MAPTILER_KEY;

const OSM_ATTR =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const TILES = MAPTILER_KEY
  ? {
      url: `https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      attribution: `© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> ${OSM_ATTR}`,
      subdomains: [] as string[],
    }
  : {
      // Keyless OpenStreetMap standard tiles for local dev (Carto now watermarks unauthenticated tiles).
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: OSM_ATTR,
      subdomains: ["a", "b", "c"],
    };

export function GeoMap() {
  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Map</h2>
        <div className="text-[12.5px] text-text-muted">
          Client locations, geo-targets, and performance by area
          {!MAPTILER_KEY && " · dev basemap (set VITE_MAPTILER_KEY for MapTiler tiles)"}
        </div>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-border" style={{ height: 580 }}>
        <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
          <TileLayer url={TILES.url} attribution={TILES.attribution} subdomains={TILES.subdomains} />
        </MapContainer>
      </div>
    </div>
  );
}
