import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

const minimal = { DATA_DIR: "/srv/selects-data" };

describe("loadConfig", () => {
  test("reads the data directory and defaults the port", () => {
    const config = loadConfig(minimal);

    expect(config.dataDir).toBe("/srv/selects-data");
    expect(config.port).toBe(3000);
    expect(config.password).toBeUndefined();
  });

  test("names a missing required variable", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATA_DIR/);
  });

  test("treats an empty required variable as missing", () => {
    expect(() => loadConfig({ DATA_DIR: "" })).toThrow(/DATA_DIR/);
  });

  test("names an invalid variable without printing its value", () => {
    let message = "";
    try {
      loadConfig({ ...minimal, PORT: "not-a-port-7731" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("PORT");
    expect(message).not.toContain("not-a-port-7731");
  });

  test("rejects a port outside the valid range", () => {
    expect(() => loadConfig({ ...minimal, PORT: "70000" })).toThrow(/PORT/);
  });

  test("reads the optional password, treating empty as unset", () => {
    expect(loadConfig({ ...minimal, SELECTS_PASSWORD: "hunter2" }).password).toBe("hunter2");
    expect(loadConfig({ ...minimal, SELECTS_PASSWORD: "" }).password).toBeUndefined();
  });

  test("never shows the password when the config is printed", () => {
    const config = loadConfig({ ...minimal, SELECTS_PASSWORD: "hunter2" });

    expect(JSON.stringify(config)).not.toContain("hunter2");
    expect(Bun.inspect(config)).not.toContain("hunter2");
  });

  test("names every missing variable at once", () => {
    let message = "";
    try {
      loadConfig({ PORT: "x" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("DATA_DIR");
    expect(message).toContain("PORT");
  });
});

const bucket = {
  BUCKET_ENDPOINT: "http://bucket.test",
  BUCKET_NAME: "frames",
  BUCKET_ACCESS_KEY_ID: "FAKEKEYID0001",
  BUCKET_SECRET_ACCESS_KEY: "fake-secret-0001",
};

describe("loadConfig: the bucket", () => {
  test("is optional: without it the app starts and names every missing variable", () => {
    const config = loadConfig(minimal);

    expect(config.bucket).toEqual({
      status: "missing",
      missing: ["BUCKET_ENDPOINT", "BUCKET_NAME", "BUCKET_ACCESS_KEY_ID", "BUCKET_SECRET_ACCESS_KEY"],
    });
  });

  test("names only the variables still missing when some are set", () => {
    const config = loadConfig({ ...minimal, BUCKET_ENDPOINT: "http://bucket.test", BUCKET_NAME: "frames" });

    expect(config.bucket).toEqual({
      status: "missing",
      missing: ["BUCKET_ACCESS_KEY_ID", "BUCKET_SECRET_ACCESS_KEY"],
    });
  });

  test("reads the endpoint, bucket, region and public base URL", () => {
    const config = loadConfig({
      ...minimal,
      ...bucket,
      BUCKET_REGION: "eu-central-1",
      BUCKET_PUBLIC_URL: "https://images.test/frames/",
    });

    expect(config.bucket.status).toBe("configured");
    if (config.bucket.status !== "configured") return;
    expect(config.bucket.endpoint).toBe("http://bucket.test");
    expect(config.bucket.name).toBe("frames");
    expect(config.bucket.region).toBe("eu-central-1");
    // Without the trailing slash, so keys join with one.
    expect(config.bucket.publicBaseUrl).toBe("https://images.test/frames");
    expect(config.bucket.accessKeyId).toBe("FAKEKEYID0001");
    expect(config.bucket.secretAccessKey).toBe("fake-secret-0001");
  });

  test("defaults the region and leaves the public base URL unset", () => {
    const config = loadConfig({ ...minimal, ...bucket });

    if (config.bucket.status !== "configured") throw new Error("expected a bucket");
    expect(config.bucket.region).toBe("auto");
    expect(config.bucket.publicBaseUrl).toBeUndefined();
  });

  test("never shows the keys when the config is printed", () => {
    const config = loadConfig({ ...minimal, ...bucket });

    for (const printed of [JSON.stringify(config), Bun.inspect(config)]) {
      expect(printed).not.toContain("FAKEKEYID0001");
      expect(printed).not.toContain("fake-secret-0001");
    }
  });

  test("refuses an endpoint or public base URL that is not an http(s) URL, naming it only", () => {
    let message = "";
    try {
      loadConfig({
        ...minimal,
        ...bucket,
        BUCKET_ENDPOINT: "ftp://nope-4410",
        BUCKET_PUBLIC_URL: "nope-4411",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("BUCKET_ENDPOINT");
    expect(message).toContain("BUCKET_PUBLIC_URL");
    expect(message).not.toContain("nope-441");
  });
});

describe("loadConfig: Instagram", () => {
  test("uses the fake Instagram server unless the real one is asked for", () => {
    expect(loadConfig(minimal).instagram).toBe("fake");
    expect(loadConfig({ ...minimal, INSTAGRAM_API: "" }).instagram).toBe("fake");
    expect(loadConfig({ ...minimal, INSTAGRAM_API: "fake" }).instagram).toBe("fake");
  });

  test("uses the real Instagram API only when INSTAGRAM_API is live", () => {
    expect(loadConfig({ ...minimal, INSTAGRAM_API: "live" }).instagram).toBe("live");
  });

  test("refuses any other value, naming the variable", () => {
    expect(() => loadConfig({ ...minimal, INSTAGRAM_API: "real" })).toThrow(/INSTAGRAM_API/);
  });

  test("refuses a public base URL with a query or a fragment, since keys are added to its end", () => {
    for (const url of ["https://images.test/frames/?token=x", "https://images.test/frames#top"]) {
      expect(() => loadConfig({ ...minimal, BUCKET_PUBLIC_URL: url })).toThrow(/BUCKET_PUBLIC_URL/);
    }
  });
});
