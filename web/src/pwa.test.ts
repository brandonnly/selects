import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");
const manifest = await Bun.file(join(repo, "brand/favicon/site.webmanifest")).json();
const indexHtml = await Bun.file(join(repo, "web/index.html")).text();
const tokens = await Bun.file(join(repo, "brand/tokens/selects.css")).text();

/** The `--background` token of a block in selects.css (`:root` for light, `.dark` for dark). */
function background(block: ":root" | ".dark"): string {
  const body = tokens.slice(tokens.indexOf(`${block} {`)).split("}")[0] ?? "";
  const value = /--background:\s*(#[0-9a-f]{6});/i.exec(body)?.[1];
  if (value === undefined) throw new Error(`No --background in ${block}`);
  return value.toLowerCase();
}

describe("the web manifest", () => {
  test("opens the app standalone at the root it is served from", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/");
  });

  test("colors the window with the light background", () => {
    expect(manifest.theme_color.toLowerCase()).toBe(background(":root"));
    expect(manifest.background_color.toLowerCase()).toBe(background(":root"));
  });

  test("has a 192 and a 512 pixel icon, plain and maskable", () => {
    const icons = manifest.icons.map((icon: { sizes: string; purpose?: string }) =>
      [icon.sizes, icon.purpose ?? "any"].join(" "),
    );

    expect(icons).toEqual(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
  });
});

describe("index.html", () => {
  test("links the manifest", () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/site.webmanifest"');
  });

  test("sets the browser's theme color to the background in light and in dark", () => {
    const light = background(":root");
    const dark = background(".dark");

    expect(indexHtml).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${light}" />`,
    );
    expect(indexHtml).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark}" />`,
    );
  });
});
