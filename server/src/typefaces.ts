/** The six typefaces bundled in `server/fonts`, each beside its license. See ADR 0001. */
export const TYPEFACES = [
  { id: "ibm-plex-mono", name: "IBM Plex Mono", file: "ibm-plex-mono/IBMPlexMono-Regular.ttf" },
  { id: "jetbrains-mono", name: "JetBrains Mono", file: "jetbrains-mono/JetBrainsMono-Regular.ttf" },
  { id: "space-mono", name: "Space Mono", file: "space-mono/SpaceMono-Regular.ttf" },
  { id: "courier-prime", name: "Courier Prime", file: "courier-prime/CourierPrime-Regular.ttf" },
  { id: "inter", name: "Inter", file: "inter/Inter-Regular.ttf" },
  { id: "eb-garamond", name: "EB Garamond", file: "eb-garamond/EBGaramond-Regular.ttf" },
] as const;

export type TypefaceId = (typeof TYPEFACES)[number]["id"];

export const TYPEFACE_IDS = TYPEFACES.map((t) => t.id) as [TypefaceId, ...TypefaceId[]];
