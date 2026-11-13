import { Elysia, t } from "elysia";
import { type CaptureEdits, type Captures, isCaptureTime } from "./capture";

const notFound = { error: "Not found" } as const;

const latitude = t.Number({ minimum: -90, maximum: 90 });
const longitude = t.Number({ minimum: -180, maximum: 180 });

/** A name with something besides spaces in it. */
const name = t.Union([t.String({ maxLength: 200, pattern: "\\S" }), t.Null()]);
const positive = t.Union([t.Number({ exclusiveMinimum: 0 }), t.Null()]);

const editsSchema = t.Object(
  {
    camera: t.Optional(name),
    lens: t.Optional(name),
    /** Millimetres. */
    focalLength: t.Optional(positive),
    /** Seconds. */
    exposureTime: t.Optional(positive),
    fNumber: t.Optional(positive),
    iso: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
    coordinates: t.Optional(
      t.Union([t.Object({ latitude, longitude }, { additionalProperties: false }), t.Null()]),
    ),
    /** Local time as the camera would record it: `YYYY-MM-DDTHH:MM:SS`. */
    capturedAt: t.Optional(t.Union([t.String(), t.Null()])),
  },
  { additionalProperties: false },
);

/** Editing a select's capture data and hiding its location. */
export function captureRoutes({ captures }: { captures: Captures }) {
  return new Elysia()
    .get(
      "/api/selects/:id/capture",
      ({ params, status }) => captures.view(params.id) ?? status(404, notFound),
    )
    .put(
      "/api/selects/:id/capture",
      ({ params, body, status }) => {
        const { capturedAt } = body.edits;
        if (typeof capturedAt === "string" && !isCaptureTime(capturedAt)) {
          return status(422, { error: "capturedAt must be a date and time written YYYY-MM-DDTHH:MM:SS." });
        }
        const edits: CaptureEdits = { ...body.edits };
        if (typeof edits.camera === "string") edits.camera = edits.camera.trim();
        if (typeof edits.lens === "string") edits.lens = edits.lens.trim();
        return (
          captures.save(params.id, { edits, locationHidden: body.locationHidden }) ?? status(404, notFound)
        );
      },
      {
        body: t.Object({ edits: editsSchema, locationHidden: t.Boolean() }, { additionalProperties: false }),
      },
    );
}
