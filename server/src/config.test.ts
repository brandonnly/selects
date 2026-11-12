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
