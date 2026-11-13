import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/** A place on Earth in decimal degrees: latitude north positive, longitude east positive. */
export type Point = { latitude: number; longitude: number };

/** A privacy zone: a point and a radius. A select taken inside one never has its location published. */
export type Zone = Point & { radiusMetres: number };

/** The mean radius of the Earth, in metres. */
const EARTH_RADIUS = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The great-circle distance between two points, in metres, on a spherical Earth. The haversine
 * form stays accurate for points close together, across the antimeridian and at the poles.
 */
export function distanceMetres(a: Point, b: Point): number {
  const dLatitude = radians(b.latitude - a.latitude);
  const dLongitude = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLatitude / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLongitude / 2) ** 2;
  // Rounding can push h a hair past 1 for antipodes.
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** True when the point is inside the zone or on its edge. */
export function insideZone(point: Point, zone: Zone): boolean {
  // Written so that a distance or radius that is not a number counts as inside: withheld.
  return !(distanceMetres(point, zone) > zone.radiusMetres);
}

/** A privacy zone as it is kept. */
export type PrivacyZone = Zone & { id: string; createdAt: string };

type ZoneRow = { id: string; latitude: number; longitude: number; radius_metres: number; created_at: string };

/** The install's privacy zones, kept in the database. */
export function createZones(db: Database) {
  const toZone = (row: ZoneRow): PrivacyZone => ({
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMetres: row.radius_metres,
    createdAt: row.created_at,
  });

  return {
    /** Every zone, oldest first. */
    list(): PrivacyZone[] {
      return db
        .query<ZoneRow, []>("SELECT * FROM privacy_zones ORDER BY created_at, rowid")
        .all()
        .map(toZone);
    },

    add(zone: Zone): PrivacyZone {
      const id = randomUUID();
      db.query(
        "INSERT INTO privacy_zones (id, latitude, longitude, radius_metres, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, zone.latitude, zone.longitude, zone.radiusMetres, new Date().toISOString());
      const saved = db.query<ZoneRow, [string]>("SELECT * FROM privacy_zones WHERE id = ?").get(id);
      if (saved === null) throw new Error("The privacy zone was not saved");
      return toZone(saved);
    },

    remove(id: string): boolean {
      return db.query("DELETE FROM privacy_zones WHERE id = ?").run(id).changes > 0;
    },
  };
}

export type Zones = ReturnType<typeof createZones>;
