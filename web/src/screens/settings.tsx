import { useEffect, useState } from "react";
import { api } from "@/api";
import { BackupStatus } from "@/components/backup-status";
import { GallerySettings } from "@/components/gallery-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { PrivacyZones } from "@/components/privacy-zones";
import { PublishingSettings } from "@/components/publishing-settings";
import { Screen } from "./screen";

type About =
  | { state: "loading" }
  | { state: "ready"; version: string; database: string }
  | { state: "unreachable" };

export function SettingsScreen() {
  const [about, setAbout] = useState<About>({ state: "loading" });

  useEffect(() => {
    let live = true;
    api.health.get().then(({ data, error }) => {
      if (!live) return;
      if (data) {
        setAbout({
          state: "ready",
          version: data.version,
          database: `OK, schema ${data.database.schemaVersion}`,
        });
      } else if (
        // Eden also reports a failed request as 503, with an Error in place of the body.
        error?.status === 503 &&
        typeof error.value === "object" &&
        error.value !== null &&
        "version" in error.value
      ) {
        setAbout({ state: "ready", version: error.value.version, database: "Unavailable" });
      } else {
        setAbout({ state: "unreachable" });
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Screen title="Settings">
      <PublishingSettings />
      <GallerySettings />
      <NotificationSettings />
      <section aria-labelledby="privacy-zones" className="flex flex-col gap-3">
        <h2 id="privacy-zones" className="text-sm font-medium text-muted-foreground">
          Privacy zones
        </h2>
        <PrivacyZones />
      </section>
      <BackupStatus />
      <section aria-labelledby="about" className="flex flex-col gap-3">
        <h2 id="about" className="text-sm font-medium text-muted-foreground">
          About
        </h2>
        {about.state === "unreachable" ? (
          <p className="text-sm text-destructive">Can't reach the server.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd data-testid="version">{about.state === "ready" ? about.version : "…"}</dd>
            <dt className="text-muted-foreground">Database</dt>
            <dd data-testid="database">{about.state === "ready" ? about.database : "…"}</dd>
          </dl>
        )}
      </section>
    </Screen>
  );
}
