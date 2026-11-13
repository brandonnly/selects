import { accessSync, constants, mkdirSync } from "node:fs";

/**
 * Creates the data directory if it is missing and checks the server can write to it. Returns
 * what is wrong, naming the variable and the user but not the path, or undefined when it is
 * ready. In the container the server runs as a user that may not own a mounted folder.
 */
export function prepareDataDir(dataDir: string): string | undefined {
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
    return undefined;
  } catch (error) {
    const user = `user ${process.getuid?.()} (group ${process.getgid?.()})`;
    // The error's code says which it is (EACCES, EROFS, ENOTDIR…); its message would carry the path.
    const code =
      typeof error === "object" && error !== null && "code" in error ? ` (${String(error.code)})` : "";
    return `DATA_DIR cannot be created or written by ${user}${code}. Make the folder writable by that user, or run Selects as the folder's owner.`;
  }
}
