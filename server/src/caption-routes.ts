import { Elysia, t } from "elysia";
import type { CaptionStore } from "./caption-store";
import {
  buildCaption,
  CAPTION_LIMITS,
  type CaptionOverride,
  type CaptionTemplates,
  checkCaption,
  checkTemplates,
  TOKENS,
} from "./captions";
import type { FrameSettings } from "./frame";
import type { CaptureData } from "./photo";

const notFound = { error: "Not found" } as const;

/** Far past any limit Instagram allows: only keeps a request to a sane size. */
const MAX_TEXT = 10_000;

const templatesSchema = t.Object(
  {
    caption: t.String({ maxLength: MAX_TEXT }),
    altText: t.String({ maxLength: MAX_TEXT }),
    hashtagSets: t.Array(
      t.Object(
        {
          name: t.String({ maxLength: 60 }),
          tags: t.Array(t.String({ maxLength: 200 }), { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

const overrideSchema = t.Object(
  {
    caption: t.Union([t.String({ maxLength: MAX_TEXT }), t.Null()]),
    altText: t.Union([t.String({ maxLength: MAX_TEXT }), t.Null()]),
  },
  { additionalProperties: false },
);

export type CaptionRoutesOptions = {
  store: CaptionStore;
  /** How coordinates print: the frame's setting. */
  coordinateFormat: () => FrameSettings["coordinateFormat"];
  /**
   * A select's capture data as it may be published, with coordinates already null when its
   * location is hidden; undefined when there is no such select.
   */
  capture: (selectId: string) => CaptureData | undefined;
};

/** The Captions screen's templates and hashtag sets, their preview, and each select's own caption. */
export function captionRoutes({ store, coordinateFormat, capture }: CaptionRoutesOptions) {
  const captionFor = (selectId: string, data: CaptureData) => {
    const own = store.override(selectId);
    const fromTemplate = buildCaption({
      capture: data,
      templates: store.templates(),
      coordinateFormat: coordinateFormat(),
    });
    // What is written for the select replaces the template's text, as written.
    const caption = {
      caption: own.caption ?? fromTemplate.caption,
      altText: own.altText ?? fromTemplate.altText,
      hashtagSet: own.caption === null ? fromTemplate.hashtagSet : null,
    };
    return { own, caption, fromTemplate, limits: CAPTION_LIMITS, check: checkCaption(caption) };
  };

  return new Elysia()
    .get("/api/captions", () => {
      const templates = store.templates();
      return { templates, tokens: TOKENS, limits: CAPTION_LIMITS, check: checkTemplates(templates) };
    })
    .put(
      "/api/captions",
      ({ body, status }) => {
        const templates = tidyTemplates(body);
        const check = checkTemplates(templates);
        if (check.problems.length > 0) return status(422, { problems: check.problems });
        return { templates: store.setTemplates(templates), check };
      },
      { body: templatesSchema },
    )
    .post(
      "/api/captions/preview",
      ({ body, status }) => {
        const templates = tidyTemplates(body.templates);
        const check = checkTemplates(templates);
        // A template with problems is not built: only a sound one is worth expanding.
        if (body.selectId === undefined || check.problems.length > 0) {
          return { caption: null, measure: null, check };
        }
        const data = capture(body.selectId);
        if (data === undefined) return status(404, notFound);
        const caption = buildCaption({
          capture: data,
          templates,
          coordinateFormat: coordinateFormat(),
          hashtagSet: body.hashtagSet,
        });
        return { caption, measure: checkCaption(caption), check };
      },
      {
        body: t.Object(
          {
            /** The select to build against. Left out, only the templates are checked. */
            selectId: t.Optional(t.String()),
            templates: templatesSchema,
            /** The hashtag set to show, by name, in place of a random one. */
            hashtagSet: t.Optional(t.String()),
          },
          { additionalProperties: false },
        ),
      },
    )
    .post("/api/captions/check", ({ body }) => checkCaption(body), {
      body: t.Object(
        { caption: t.String({ maxLength: MAX_TEXT }), altText: t.String({ maxLength: MAX_TEXT }) },
        { additionalProperties: false },
      ),
    })
    .get("/api/selects/:id/caption", ({ params, status }) => {
      const data = capture(params.id);
      if (data === undefined) return status(404, notFound);
      return captionFor(params.id, data);
    })
    .put(
      "/api/selects/:id/caption",
      ({ params, body, status }) => {
        const data = capture(params.id);
        if (data === undefined) return status(404, notFound);
        const own: CaptionOverride = { caption: written(body.caption), altText: written(body.altText) };
        // Only what this request writes is measured: text from the template is not the writer's
        // to fix here, and must not stop an own text being saved or cleared.
        const check = checkCaption({ caption: own.caption ?? "", altText: own.altText ?? "" });
        if (check.problems.length > 0) return status(422, { problems: check.problems });
        store.setOverride(params.id, own);
        return captionFor(params.id, data);
      },
      { body: overrideSchema },
    );
}

/** Set names without the spaces around them. */
function tidyTemplates(templates: CaptionTemplates): CaptionTemplates {
  return {
    ...templates,
    hashtagSets: templates.hashtagSets.map((set) => ({ name: set.name.trim(), tags: set.tags })),
  };
}

/** Text written for a select, without the spaces around it; nothing written takes the template. */
function written(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
