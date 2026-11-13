import type { BackupStatus as Status } from "@selects/server";
import { useEffect, useState } from "react";
import { api } from "@/api";

const formatTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The nightly backup: when the last copy was made, and why the last try failed if it did. */
export function BackupStatus() {
  const [status, setStatus] = useState<Status | undefined>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let live = true;
    api.backups
      .get()
      .then(({ data, error }) => {
        if (!live) return;
        if (data) setStatus(data);
        setLoadError(error !== null);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section aria-labelledby="backups" className="flex flex-col gap-3">
      <h2 id="backups" className="text-sm font-medium text-muted-foreground">
        Backups
      </h2>
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      {status !== undefined && (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground">
          <p data-testid="last-backup">
            {status.lastAt === null ? "No copy yet." : `Last copy ${formatTime(status.lastAt)}.`}
          </p>
          {status.lastError !== null && (
            <p className="text-destructive">
              Last try {formatTime(status.lastError.at)}: {status.lastError.reason} Selects tries again in an
              hour.
            </p>
          )}
          <p className="text-muted-foreground">
            The database is copied each night at {status.time} ({status.timeZone}) into <code>backups</code>{" "}
            in the data folder, and the latest {status.kept} are kept. The README says how to restore one.
          </p>
        </div>
      )}
    </section>
  );
}
