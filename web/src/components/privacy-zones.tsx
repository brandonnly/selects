import type { PrivacyZone } from "@selects/server";
import L from "leaflet";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { formatPoint, formatRadius } from "@/lib/map";
import { MapBox, useLeafletMap, zoneCircle } from "./map";

type Form = { latitude: string; longitude: string; radius: string };
type Point = { latitude: number; longitude: number };

const EMPTY: Form = { latitude: "", longitude: "", radius: "" };

const decimal = (text: string) => {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned === "") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

/** The zone the form describes, or why it doesn't describe one yet. */
function readForm(form: Form): { zone: Point & { radiusMetres: number } } | { error: string } {
  const latitude = decimal(form.latitude);
  const longitude = decimal(form.longitude);
  const radiusMetres = decimal(form.radius);
  if (latitude === undefined || longitude === undefined)
    return { error: "Enter a latitude and a longitude." };
  if (Math.abs(latitude) > 90) return { error: "Latitude goes from -90 to 90." };
  if (Math.abs(longitude) > 180) return { error: "Longitude goes from -180 to 180." };
  if (radiusMetres === undefined || radiusMetres <= 0) return { error: "Enter a radius above 0 metres." };
  return { zone: { latitude, longitude, radiusMetres } };
}

/** Keeps a longitude a map gives, which can wrap past ±180, on the globe. */
const wrap = (longitude: number) => ((((longitude + 180) % 360) + 360) % 360) - 180;
const fixed = (value: number) => String(Number(value.toFixed(5)));

/** A radius that draws about 60 pixels on the map at `at`, rounded to a tidy number. */
function radiusFor(map: L.Map, at: L.LatLng): number {
  const below = map.containerPointToLatLng(map.latLngToContainerPoint(at).add([0, 60]));
  const metres = map.distance(at, below);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(metres, 10)));
  return Math.max(10, Math.round(metres / magnitude) * magnitude);
}

/** Where the edge handle sits: due south of the centre, or due north below the equator. */
function handlePoint(zone: Point & { radiusMetres: number }): L.LatLng {
  const degrees = (zone.radiusMetres / 6_371_008.8) * (180 / Math.PI);
  const latitude = zone.latitude >= 0 ? zone.latitude - degrees : zone.latitude + degrees;
  return L.latLng(Math.max(-90, Math.min(90, latitude)), zone.longitude);
}

/**
 * The install's privacy zones: listed, deleted, and added by typing coordinates and a radius or
 * by dropping a point on the map and dragging its edge.
 */
export function PrivacyZones() {
  const [zones, setZones] = useState<PrivacyZone[] | undefined>();
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | undefined>();
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.zones.get();
      if (data) setZones(data);
      if (error) setMessage({ text: "Couldn't load the privacy zones.", error: true });
    } catch {
      setMessage({ text: "Can't reach the server.", error: true });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const read = useMemo(() => readForm(form), [form]);

  const add = async () => {
    if ("error" in read) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const { error } = await api.zones.post(read.zone);
      if (error) setMessage({ text: "Couldn't add the zone. Try again.", error: true });
      else {
        setForm(EMPTY);
        setShowErrors(false);
        setMessage({ text: "Zone added.", error: false });
      }
    } catch {
      setMessage({ text: "Couldn't add the zone. Try again.", error: true });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string) => {
    setMessage(undefined);
    try {
      const { error } = await api.zones({ id }).delete();
      // Gone already is the same outcome.
      if (error && error.status !== 404)
        setMessage({ text: "Couldn't delete the zone. Try again.", error: true });
    } catch {
      setMessage({ text: "Couldn't delete the zone. Try again.", error: true });
    }
    await load();
  };

  const field = (name: keyof Form) => ({
    value: form[name],
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.currentTarget.value;
      setForm((current) => ({ ...current, [name]: value }));
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        A select taken inside a zone never has its coordinates on its frame, in its caption or in the gallery.
      </p>

      <ZoneMap
        zones={zones ?? []}
        draft={"zone" in read ? read.zone : undefined}
        onDraft={(point, radiusMetres) =>
          setForm((current) => ({
            latitude: fixed(point.latitude),
            longitude: fixed(wrap(point.longitude)),
            radius: radiusMetres === undefined ? current.radius : String(Math.round(radiusMetres)),
          }))
        }
      />

      <form
        aria-label="New privacy zone"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Latitude</span>
            <input {...field("latitude")} inputMode="decimal" placeholder="10.5" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Longitude</span>
            <input {...field("longitude")} inputMode="decimal" placeholder="-40.25" className={INPUT} />
          </label>
          <label className="col-span-2 flex flex-col gap-1.5 text-sm sm:col-span-1">
            <span className="font-medium">Radius in metres</span>
            <input {...field("radius")} inputMode="numeric" placeholder="500" className={INPUT} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Tap the map to drop a point, then drag the white handle to size the zone. Or type the coordinates in
          decimal degrees.
        </p>
        {showErrors && "error" in read && <p className="text-sm text-destructive">{read.error}</p>}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add zone"}
          </Button>
        </div>
      </form>

      {message && (
        <p
          role="status"
          className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {message.text}
        </p>
      )}

      {zones !== undefined &&
        (zones.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No privacy zones yet.
          </p>
        ) : (
          <ul aria-label="Privacy zones" className="flex flex-col divide-y rounded-lg border bg-card">
            {zones.map((zone) => (
              <li key={zone.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="tabular-nums">{formatPoint(zone)}</span>
                  <span className="text-muted-foreground"> · {formatRadius(zone.radiusMetres)}</span>
                </span>
                <Button variant="destructive" size="sm" onClick={() => remove(zone.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

const INPUT =
  "h-10 w-full rounded-md border bg-card px-3 text-base text-card-foreground tabular-nums md:text-sm";

/** The zones on a map, and the one being made: a centre to drag and a handle on its edge. */
function ZoneMap({
  zones,
  draft,
  onDraft,
}: {
  zones: PrivacyZone[];
  draft: (Point & { radiusMetres: number }) | undefined;
  onDraft: (point: Point, radiusMetres?: number) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const map = useLeafletMap(box);
  const latest = useRef({ draft, onDraft });
  latest.current = { draft, onDraft };

  useEffect(() => {
    if (map === undefined) return;
    const drop = (event: L.LeafletMouseEvent) => {
      const { draft: current, onDraft: set } = latest.current;
      const point = { latitude: event.latlng.lat, longitude: event.latlng.lng };
      set(point, current === undefined ? radiusFor(map, event.latlng) : undefined);
    };
    map.on("click", drop);
    return () => {
      map.off("click", drop);
    };
  }, [map]);

  useEffect(() => {
    if (map === undefined) return;
    const layer = L.layerGroup().addTo(map);
    for (const zone of zones) zoneCircle(zone).addTo(layer);
    return () => {
      layer.remove();
    };
  }, [map, zones]);

  // The draft is redrawn as it changes; while a marker is dragged, it moves itself.
  const dragging = useRef(false);
  const draftLayer = useRef<{ circle: L.Circle; centre: L.Marker; handle: L.Marker } | undefined>(undefined);
  useEffect(() => {
    if (map === undefined) return;
    if (draft === undefined) {
      draftLayer.current?.circle.remove();
      draftLayer.current?.centre.remove();
      draftLayer.current?.handle.remove();
      draftLayer.current = undefined;
      return;
    }
    const centre = L.latLng(draft.latitude, draft.longitude);
    if (draftLayer.current === undefined) {
      const circle = zoneCircle(draft, true).addTo(map);
      const centreMarker = L.marker(centre, {
        draggable: true,
        icon: L.divIcon({ className: "selects-zone-centre", iconSize: [18, 18] }),
        title: "Zone centre",
        alt: "Zone centre",
        keyboard: false,
      }).addTo(map);
      const handle = L.marker(handlePoint(draft), {
        draggable: true,
        icon: L.divIcon({ className: "selects-zone-handle", iconSize: [22, 22] }),
        title: "Zone edge",
        alt: "Zone edge",
        keyboard: false,
      }).addTo(map);
      centreMarker.on("dragstart", () => {
        dragging.current = true;
      });
      centreMarker.on("drag", () => {
        const at = centreMarker.getLatLng();
        circle.setLatLng(at);
        const current = latest.current.draft;
        if (current) handle.setLatLng(handlePoint({ ...current, latitude: at.lat, longitude: at.lng }));
      });
      centreMarker.on("dragend", () => {
        dragging.current = false;
        const at = centreMarker.getLatLng();
        latest.current.onDraft({ latitude: at.lat, longitude: at.lng });
      });
      handle.on("dragstart", () => {
        dragging.current = true;
      });
      handle.on("drag", () => {
        circle.setRadius(map.distance(centreMarker.getLatLng(), handle.getLatLng()));
      });
      handle.on("dragend", () => {
        dragging.current = false;
        const at = centreMarker.getLatLng();
        latest.current.onDraft(
          { latitude: at.lat, longitude: at.lng },
          Math.max(1, map.distance(at, handle.getLatLng())),
        );
      });
      draftLayer.current = { circle, centre: centreMarker, handle };
      // A zone typed in somewhere off screen is brought into view.
      if (!map.getBounds().contains(centre)) map.setView(centre, Math.max(map.getZoom(), 10));
      return;
    }
    if (dragging.current) return;
    draftLayer.current.circle.setLatLng(centre);
    draftLayer.current.circle.setRadius(draft.radiusMetres);
    draftLayer.current.centre.setLatLng(centre);
    draftLayer.current.handle.setLatLng(handlePoint(draft));
  }, [map, draft]);

  // The map that made the draft is gone with it.
  useEffect(() => {
    if (map === undefined) draftLayer.current = undefined;
  }, [map]);

  return <MapBox ref={box} label="Map of privacy zones. Tap to drop a point." />;
}
