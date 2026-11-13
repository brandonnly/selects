import type { AccountView } from "@selects/server";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn } from "@/lib/autosave";

type Publishing = {
  dryRun: boolean;
  instagram: { mode: "fake" | "live"; account: AccountView | null };
  bucket: { configured: boolean; fake: boolean; missing: string[]; url: "public" | "presigned" | null };
};

/** Settings for publishing: the Instagram account, the bucket and the dry run switch. */
export function PublishingSettings() {
  const [publishing, setPublishing] = useState<Publishing | undefined>();
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.publishing.get();
      if (data) setPublishing(data);
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <p className="text-sm text-destructive">Can't reach the server.</p>;
  if (publishing === undefined) return null;

  return (
    <>
      <section aria-labelledby="instagram" className="flex flex-col gap-3">
        <h2 id="instagram" className="text-sm font-medium text-muted-foreground">
          Instagram
        </h2>
        <InstagramAccount
          mode={publishing.instagram.mode}
          account={publishing.instagram.account}
          onChange={load}
        />
      </section>
      <section aria-labelledby="bucket" className="flex flex-col gap-3">
        <h2 id="bucket" className="text-sm font-medium text-muted-foreground">
          Bucket
        </h2>
        <BucketStatus bucket={publishing.bucket} />
      </section>
      <section aria-labelledby="dry-run" className="flex flex-col gap-3">
        <h2 id="dry-run" className="text-sm font-medium text-muted-foreground">
          Dry run
        </h2>
        <DryRun
          value={publishing.dryRun}
          onChange={(dryRun) => setPublishing((current) => current && { ...current, dryRun })}
        />
      </section>
    </>
  );
}

function InstagramAccount({
  mode,
  account,
  onChange,
}: {
  mode: "fake" | "live";
  account: AccountView | null;
  onChange: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems(undefined);
    try {
      const { error } = await api.instagram.token.put({ token });
      if (error) {
        setProblems(problemsIn(error.value));
        return;
      }
      // The token is gone from the page as soon as it is accepted.
      setToken("");
      setRemoveFailed(false);
      setReplacing(false);
      await onChange();
    } catch {
      setProblems([]);
    } finally {
      setBusy(false);
    }
  };

  const [removeFailed, setRemoveFailed] = useState(false);
  const remove = async () => {
    setBusy(true);
    setRemoveFailed(false);
    try {
      const { error } = await api.instagram.token.delete();
      if (error) {
        setRemoveFailed(true);
        return;
      }
      setConfirmRemove(false);
      await onChange();
    } catch {
      setRemoveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      {mode === "fake" && (
        <p className="text-muted-foreground">
          Fake mode: Selects talks to the fake Instagram server inside itself, and nothing is posted for real.
          Any token connects a fake account. Set <code>INSTAGRAM_API=live</code> to post to Instagram.
        </p>
      )}
      {account !== null && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted-foreground">Account</dt>
          <dd data-testid="instagram-account">@{account.username}</dd>
          <dt className="text-muted-foreground">Token</dt>
          <dd>
            {account.status === "invalid" ? (
              <span className="text-destructive">No longer accepted. Paste a new token.</span>
            ) : (
              <TokenExpiry account={account} />
            )}
          </dd>
        </dl>
      )}
      {account === null || replacing || account.status === "invalid" ? (
        <form onSubmit={connect} className="flex flex-col gap-2">
          <label htmlFor="instagram-token" className="font-medium">
            {account === null ? "Long-lived access token" : "New long-lived access token"}
          </label>
          <input
            id="instagram-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            From your Meta app's Instagram API settings. It is checked with Instagram, kept on this server and
            never shown again.
          </p>
          {problems !== undefined && (
            <p className="text-destructive">
              {problems.length > 0 ? problems.join(" ") : "Couldn't connect. Try again."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || token.trim() === ""}>
              {busy ? "Checking…" : "Connect"}
            </Button>
            {replacing && (
              <Button
                variant="ghost"
                onClick={() => {
                  // The token typed and not sent does not stay on the page.
                  setToken("");
                  setReplacing(false);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            )}
            {account?.status === "invalid" && (
              <Button variant="destructive" type="button" onClick={remove} disabled={busy}>
                Disconnect
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setReplacing(true)}>
            Replace token
          </Button>
          {confirmRemove ? (
            <>
              <Button variant="destructive" onClick={remove} disabled={busy}>
                Disconnect
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmRemove(true)}>
              Disconnect…
            </Button>
          )}
        </div>
      )}
      {confirmRemove && (
        <p className="text-xs text-muted-foreground">
          Removes the token from Selects. Nothing posts until one is pasted.
        </p>
      )}
      {removeFailed && (
        <p role="alert" className="text-destructive">
          Couldn't disconnect: the token is still kept. Try again.
        </p>
      )}
    </div>
  );
}

function TokenExpiry({ account }: { account: AccountView }) {
  const expires =
    account.expiresAt === null
      ? null
      : new Date(account.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" });
  if (account.refresh === "failed") {
    return (
      <span className="flex flex-col gap-1">
        <span className="text-destructive">
          This token could not be refreshed. Instagram stops accepting it when it expires
          {expires === null ? "" : ` on ${expires}`}, unless a refresh works first.
        </span>
        <span className="text-muted-foreground">
          Selects keeps trying. Check that it is a long-lived token from the Instagram API with Instagram
          Login, or paste a new one.
        </span>
      </span>
    );
  }
  if (expires === null) {
    return <>Too new to refresh yet: its expiry shows once Selects refreshes it, a day after it was made.</>;
  }
  return <>Refreshed automatically. Expires {expires}.</>;
}

function BucketStatus({ bucket }: { bucket: Publishing["bucket"] }) {
  if (bucket.fake) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-card-foreground">
        <p>
          Fake mode: frames go to the fake bucket inside Selects, and the bucket in <code>BUCKET_*</code> is
          not used. It is used once <code>INSTAGRAM_API=live</code> is set.
        </p>
      </div>
    );
  }
  if (!bucket.configured) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground">
        <p className="font-medium">Not configured: publishing is unavailable.</p>
        <p className="text-muted-foreground">Set these environment variables and restart Selects:</p>
        <ul className="flex flex-col gap-1">
          {bucket.missing.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <p>
        {bucket.url === "public"
          ? "Configured with a public base URL: Instagram fetches each frame from its public URL."
          : "Configured without a public base URL: Instagram fetches each frame through a one-hour presigned link. Gallery output needs a public base URL."}
      </p>
    </div>
  );
}

function DryRun({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");

  const change = async (dryRun: boolean) => {
    setState("saving");
    onChange(dryRun);
    try {
      const { error } = await api.publishing.put({ dryRun });
      if (error) throw error;
      setState("idle");
    } catch {
      onChange(!dryRun);
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={value}
          disabled={state === "saving"}
          onChange={(event) => change(event.currentTarget.checked)}
          className="size-4 accent-primary"
        />
        Dry run
      </label>
      <p className="text-muted-foreground">
        Each post is rendered and recorded with what it would send, and nothing is uploaded or posted. Dry
        runs show on the Posted screen.
      </p>
      {state === "failed" && <p className="text-destructive">Couldn't save. Try again.</p>}
    </div>
  );
}
