# Selects tokens

`selects.css` is the token set for shadcn/ui on Tailwind v4. It is the only place colors and
radius are defined.

```css
@import "tailwindcss";
@import "shadcn/tailwind.css";
@import "../../brand/tokens/selects.css";
```

## Rules

- **The chrome is neutral.** Paper, ink and kraft carry the whole interface, so the photographs
  are the only real color on screen.
- **`brand` is the tab.** It marks next up, queued selects and focus rings. Pair it with a
  label: on the light background it measures 3.08:1, enough for a marker and too low for text.
- **`brand` is never a button fill.** White on it is 3.32:1. Where text must sit on it, use
  `brand-foreground` (4.54:1 in light).
- **`primary` is ink** in light and paper in dark. The main action on a screen uses it.
- **`destructive` is text and outline only**, always with a word beside it, because it sits
  close to `brand` in dark mode.
- **`muted-foreground`** is for secondary text: 5.30:1 on `background` and 4.75:1 on `muted` in
  light, 7.17:1 and 6.29:1 on `background` and `card` in dark.

Ratios are WCAG 2 contrast, measured on the hex values in `selects.css`. Re-measure when a
token changes.
