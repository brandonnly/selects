type Root = { classList: { toggle(name: string, force: boolean): boolean } };

type DarkQuery = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

/**
 * Keeps the `dark` class on `root` in step with the device's light or dark setting, which is
 * how the tokens in brand/tokens/selects.css switch. Returns a function that stops following.
 */
export function followDeviceTheme(root: Root, darkQuery: DarkQuery): () => void {
  const apply = () => {
    root.classList.toggle("dark", darkQuery.matches);
  };
  apply();
  darkQuery.addEventListener("change", apply);
  return () => darkQuery.removeEventListener("change", apply);
}
