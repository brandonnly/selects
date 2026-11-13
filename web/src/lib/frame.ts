import type { FramePreviewQuery, FrameSettings } from "@selects/server";

/**
 * The address of a select's frame rendered with `settings`, saved or not, at `width` pixels
 * wide. The server renders it with the same renderer that produces the post.
 */
export function previewUrl(selectId: string, settings: FrameSettings, width: number): string {
  const query = {
    width,
    border: settings.border,
    color: settings.color,
    typeface: settings.typeface,
    fields: Object.entries(settings.fields)
      .filter(([, shown]) => shown)
      .map(([field]) => field)
      .join(","),
    coordinateFormat: settings.coordinateFormat,
  } satisfies Required<FramePreviewQuery>;
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  return `/api/selects/${encodeURIComponent(selectId)}/frame?${params}`;
}

/** Calls `run` once the calls have stopped for `ms`, with the last call's arguments. */
export function debounce<Args extends unknown[]>(run: (...args: Args) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
