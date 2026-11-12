/**
 * The only place the server reads environment variables. Every variable is listed in
 * `.env.example`. Errors name the variable and never include its value.
 */

export class Config {
  readonly #password: string | undefined;

  constructor(
    /** Port the server listens on. */
    readonly port: number,
    /** Directory holding the database. */
    readonly dataDir: string,
    password?: string,
  ) {
    this.#password = password;
  }

  /** When set, the whole app sits behind this single password. Kept out of logs and JSON. */
  get password(): string | undefined {
    return this.#password;
  }
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 3000;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const read = (name: string) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };

  const dataDir = read("DATA_DIR");
  if (dataDir === undefined) problems.push("DATA_DIR is required but not set");

  let port = DEFAULT_PORT;
  const rawPort = read("PORT");
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;
    else problems.push("PORT must be a whole number from 1 to 65535");
  }

  if (problems.length > 0 || dataDir === undefined) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return new Config(port, dataDir, read("SELECTS_PASSWORD"));
}
