import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const brand = new URL("../", import.meta.url).pathname;
const C = { paper: "#F2E9DC", ink: "#26262A", tab: "#FF4B3E", kraft: "#A8987D", kraftLight: "#C9BBA4", white: "#FFFFFF" };

const print = (fill, rot) =>
  `<rect x="20" y="14" width="24" height="33" rx="2.5" fill="${fill}"${rot ? ` transform="rotate(${rot} 32 54)"` : ""}/>`;
const mark =
  print(C.kraft, -17) +
  print(C.kraftLight, 17) +
  `<rect x="34.5" y="7" width="6.5" height="12" rx="1.6" fill="${C.tab}"/>` +
  print(C.white, 0) +
  `<rect x="23.5" y="17.5" width="17" height="19" fill="${C.ink}"/>`;

const svg = (body, { w = 64, h = 64, view = "0 0 64 64" } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${w}" height="${h}" role="img"><title>Selects</title>${body}</svg>\n`;
const rounded = svg(
  `<clipPath id="tile"><rect width="64" height="64" rx="14"/></clipPath><g clip-path="url(#tile)"><rect width="64" height="64" fill="${C.paper}"/>${mark}</g>`,
);
const square = svg(`<rect width="64" height="64" fill="${C.paper}"/><g transform="translate(0 2.5)">${mark}</g>`);
const maskable = svg(
  `<rect width="64" height="64" fill="${C.paper}"/><g transform="translate(32 32) scale(.7) translate(-32 -29.5)">${mark}</g>`,
);
const og = svg(
  `<rect width="1280" height="640" fill="${C.ink}"/><g transform="translate(480 160) scale(5)"><clipPath id="tile"><rect width="64" height="64" rx="14"/></clipPath><g clip-path="url(#tile)"><rect width="64" height="64" fill="${C.paper}"/>${mark}</g></g>`,
  { w: 1280, h: 640, view: "0 0 1280 640" },
);

const out = (path, data) => {
  mkdirSync(new URL(".", `file://${brand}${path}`).pathname, { recursive: true });
  writeFileSync(brand + path, data);
};
const png = (source, width) => new Resvg(source, { fitTo: { mode: "width", value: width } }).render().asPng();

out("logo/selects-icon.svg", rounded);
out("favicon/favicon.svg", rounded);
out("favicon/favicon-32.png", png(rounded, 32));
out("favicon/icon-192.png", png(rounded, 192));
out("favicon/icon-512.png", png(rounded, 512));
out("favicon/apple-touch-icon.png", png(square, 180));
out("favicon/icon-maskable-192.png", png(maskable, 192));
out("favicon/icon-maskable-512.png", png(maskable, 512));
out("social/og.png", png(og, 1280));
out(
  "favicon/site.webmanifest",
  JSON.stringify(
    {
      name: "Selects",
      short_name: "Selects",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      theme_color: "#FAF6EF",
      background_color: "#FAF6EF",
      display: "standalone",
    },
    null,
    2,
  ) + "\n",
);
