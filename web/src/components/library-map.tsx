import type { PrivacyZone, Select } from "@selects/server";
import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { MapBox, useLeafletMap, zoneCircle } from "./map";

/** Where the Library's selects were taken, each pinned by its thumbnail, with the privacy zones. */
export function LibraryMap({
  selects,
  zones,
  onOpen,
}: {
  selects: Select[];
  zones: PrivacyZone[];
  onOpen: (select: Select) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const map = useLeafletMap(box);
  const fitted = useRef(false);
  const open = useRef(onOpen);
  open.current = onOpen;

  const located = useMemo(
    () =>
      selects.filter(
        (select): select is Select & { latitude: number; longitude: number } =>
          select.latitude !== null && select.longitude !== null,
      ),
    [selects],
  );

  useEffect(() => {
    if (map === undefined) return;
    const layer = L.layerGroup().addTo(map);
    for (const zone of zones) zoneCircle(zone).addTo(layer);
    for (const select of located) {
      const image = document.createElement("img");
      image.src = `/api/selects/${encodeURIComponent(select.id)}/thumbnail`;
      image.alt = "";
      const marker = L.marker([select.latitude, select.longitude], {
        icon: L.divIcon({ className: "selects-pin", html: image, iconSize: [40, 40] }),
        title: select.fileName,
        alt: select.fileName,
        keyboard: true,
      });
      marker.on("click", () => open.current(select));
      marker.addTo(layer);
    }
    // The first time there is something to show, the map frames it; after that it stays put.
    if (!fitted.current && located.length > 0) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds(located.map((s) => [s.latitude, s.longitude])), {
        padding: [40, 40],
        maxZoom: 12,
      });
    }
    return () => {
      layer.remove();
    };
  }, [map, located, zones]);

  return (
    <div className="flex flex-col gap-2">
      <MapBox ref={box} label="Map of where selects were taken" className="h-[60dvh] min-h-80" />
      <p className="text-xs text-muted-foreground">
        {located.length === selects.length
          ? "Every select is on the map."
          : `${located.length} of ${selects.length} selects have a location.`}{" "}
        Shaded circles are privacy zones. Only you see this map.
      </p>
    </div>
  );
}
