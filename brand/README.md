# Selects brand

The mark is **Tabbed**: a fan of prints with a red tab sticking out of the pile, marking the
one to pull next.

## Colors

| Name | Hex | Role |
| --- | --- | --- |
| Paper | `#F2E9DC` | Tile |
| Ink | `#26262A` | The photo in the top print |
| Tab Red | `#FF4B3E` | The tab |
| Kraft | `#A8987D` | Back print |
| Kraft Light | `#C9BBA4` | Middle print |
| White | `#FFFFFF` | Top print |

How they become UI colors: [tokens/README.md](tokens/README.md).

## Which file to use

| Where | File |
| --- | --- |
| Favicon, project icon | `favicon/favicon.svg` |
| Small bitmap favicon | `favicon/favicon-32.png` |
| PWA icons | `favicon/icon-192.png`, `favicon/icon-512.png` |
| Android adaptive icons | `favicon/icon-maskable-192.png`, `favicon/icon-maskable-512.png` |
| iOS home screen (full bleed, iOS adds the corners) | `favicon/apple-touch-icon.png` |
| The tile elsewhere | `logo/selects-icon.svg` |
| Link previews | `social/og.png` |

Copy everything in `favicon/` to the web app's public root. `site.webmanifest` assumes the app
is served from the domain root.

## Changing an asset

Every file in `logo/`, `favicon/` and `social/` is generated. Edit `scripts/build.mjs`, then:

```sh
cd brand/scripts && bun install && bun run build
```
