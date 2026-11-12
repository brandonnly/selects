import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const NOT_BUILT = "The UI has not been built. Run `bun run build`, then start the server again.";

/**
 * Serves the built single-page UI from `webDir`. A path without a file extension is a client
 * route and gets `index.html`; a missing file with an extension is a 404.
 */
export function serveUi(webDir: string, pathname: string): Response {
  const root = resolve(webDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) return new Response(NOT_BUILT, { status: 404 });

  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const target = resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response("Not found", { status: 404 });
  }

  if (target !== root && isFile(target)) {
    const immutable = target.startsWith(join(root, "assets") + sep);
    return new Response(Bun.file(target), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }

  if (extname(target) !== "") return new Response("Not found", { status: 404 });

  return new Response(Bun.file(index), { headers: { "cache-control": "no-cache" } });
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
