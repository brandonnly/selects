/**
 * Map tiles: OpenStreetMap's standard tiles (ADR 0002), requested by the browser straight from
 * the tile server. The Selects server never fetches or proxies a tile.
 *
 * OpenStreetMap's tile usage policy asks for its attribution on the map, a browser's usual
 * referrer, no prefetching or bulk download, and no zoom past 19.
 */
export const TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
} as const;

/** The whole world, for a map with nothing on it yet. */
export const WORLD_VIEW = { center: [20, 0] as [number, number], zoom: 1 };

/** "850 m", "1.5 km", "12 km". */
export function formatRadius(metres: number): string {
  if (Math.round(metres) < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`;
}

/** "10.50000, -40.25000": five decimals, about a metre. */
export function formatPoint(point: { latitude: number; longitude: number }): string {
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}
