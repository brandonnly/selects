import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type RefObject, useEffect, useState } from "react";
import { TILES, WORLD_VIEW } from "@/lib/map";
import { cn } from "@/lib/utils";

/**
 * A Leaflet map in `container`, showing OpenStreetMap tiles that the browser fetches from the
 * tile server itself. Undefined until the container is on the page.
 */
export function useLeafletMap(container: RefObject<HTMLElement | null>): L.Map | undefined {
  const [map, setMap] = useState<L.Map>();

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const created = L.map(element, {
      center: WORLD_VIEW.center,
      zoom: WORLD_VIEW.zoom,
      worldCopyJump: true,
    });
    created.attributionControl.setPrefix(false);
    L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: TILES.maxZoom }).addTo(created);
    // A map laid out while hidden, or in a box that changes size, needs telling.
    const resized = new ResizeObserver(() => created.invalidateSize());
    resized.observe(element);
    setMap(created);
    return () => {
      resized.disconnect();
      created.remove();
      setMap(undefined);
    };
  }, [container]);

  return map;
}

/** The box a map draws in. */
export function MapBox({
  ref,
  label,
  className,
}: {
  ref: RefObject<HTMLElement | null>;
  label: string;
  className?: string;
}) {
  return (
    <section
      ref={ref}
      aria-label={label}
      className={cn("selects-map h-80 w-full overflow-hidden rounded-lg border", className)}
    />
  );
}

/** A circle for a privacy zone, drawn in the kraft token. */
export function zoneCircle(
  zone: { latitude: number; longitude: number; radiusMetres: number },
  draft = false,
) {
  return L.circle([zone.latitude, zone.longitude], {
    radius: zone.radiusMetres,
    className: draft ? "selects-zone selects-zone-draft" : "selects-zone",
    interactive: false,
  });
}
