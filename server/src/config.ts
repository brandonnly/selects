/**
 * The only place the server reads environment variables. Every variable is listed in
 * `.env.example`. Errors name the variable and never include its value.
 */

/**
 * Which Instagram the server talks to. `fake` is the fake server in this repo, run inside the
 * process: the default, so nothing posts for real until `INSTAGRAM_API=live` is set.
 */
export type InstagramMode = "fake" | "live";

/** An S3-compatible bucket. The keys are kept out of logs and JSON. */
export class BucketSettings {
  readonly status = "configured";
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;

  constructor(
    readonly endpoint: string,
    readonly name: string,
    readonly region: string,
    /** Where the bucket's objects are public, without a trailing slash. Unset: presigned links. */
    readonly publicBaseUrl: string | undefined,
    keys: { accessKeyId: string; secretAccessKey: string },
  ) {
    this.#accessKeyId = keys.accessKeyId;
    this.#secretAccessKey = keys.secretAccessKey;
  }

  get accessKeyId(): string {
    return this.#accessKeyId;
  }

  get secretAccessKey(): string {
    return this.#secretAccessKey;
  }
}

/** The bucket, or the variables it still needs. Publishing is unavailable without it. */
export type BucketConfig = BucketSettings | { status: "missing"; missing: string[] };

export class Config {
  readonly #password: string | undefined;

  constructor(
    /** Port the server listens on. */
    readonly port: number,
    /** Directory holding the database. */
    readonly dataDir: string,
    password?: string,
    readonly bucket: BucketConfig = { status: "missing", missing: [...BUCKET_REQUIRED] },
    readonly instagram: InstagramMode = "fake",
    /**
     * Whether BUCKET_PUBLIC_URL is set. In fake mode the fake bucket then has a public base URL
     * of its own, so gallery output can be tried; the variable's value is not used.
     */
    readonly fakePublicUrl = false,
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
const DEFAULT_REGION = "auto";

/** Every variable a bucket needs, in the order they are named when missing. */
const BUCKET_REQUIRED = [
  "BUCKET_ENDPOINT",
  "BUCKET_NAME",
  "BUCKET_ACCESS_KEY_ID",
  "BUCKET_SECRET_ACCESS_KEY",
] as const;

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

  const bucket = readBucket(read, problems);

  let instagram: InstagramMode = "fake";
  const rawInstagram = read("INSTAGRAM_API");
  if (rawInstagram === "live") instagram = "live";
  else if (rawInstagram !== undefined && rawInstagram !== "fake") {
    problems.push("INSTAGRAM_API must be fake or live");
  }

  if (problems.length > 0 || dataDir === undefined) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return new Config(
    port,
    dataDir,
    read("SELECTS_PASSWORD"),
    bucket,
    instagram,
    read("BUCKET_PUBLIC_URL") !== undefined,
  );
}

function readBucket(read: (name: string) => string | undefined, problems: string[]): BucketConfig {
  const missing = BUCKET_REQUIRED.filter((name) => read(name) === undefined);
  const endpoint = httpUrl(read("BUCKET_ENDPOINT"), "BUCKET_ENDPOINT", problems);
  const publicBaseUrl = httpUrl(read("BUCKET_PUBLIC_URL"), "BUCKET_PUBLIC_URL", problems);
  // Object keys are added to the end of it, so nothing may follow its path.
  if (publicBaseUrl !== undefined && /[?#]/.test(publicBaseUrl)) {
    problems.push("BUCKET_PUBLIC_URL must not have a query or a fragment");
  }
  if (missing.length > 0) return { status: "missing", missing };
  return new BucketSettings(
    endpoint ?? "",
    read("BUCKET_NAME") ?? "",
    read("BUCKET_REGION") ?? DEFAULT_REGION,
    publicBaseUrl?.replace(/\/+$/, ""),
    {
      accessKeyId: read("BUCKET_ACCESS_KEY_ID") ?? "",
      secretAccessKey: read("BUCKET_SECRET_ACCESS_KEY") ?? "",
    },
  );
}

/** The value when it is an http or https URL; otherwise names the variable as a problem. */
function httpUrl(value: string | undefined, name: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch {}
  problems.push(`${name} must be an http or https URL`);
  return undefined;
}
