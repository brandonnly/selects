import type { NotificationsView, NotifyEvent, SentNotice } from "@selects/server";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn, useAutosave } from "@/lib/autosave";
import {
  type EventSettings,
  type EventsDraft,
  outcomeText,
  parseEvents,
  testResultText,
} from "@/lib/notifications";
import { SaveStatus } from "./schedule-editor";

type Notifications = NotificationsView & EventSettings & { recent: SentNotice[] };

const SETTLE_MS = 600;

const EVENT_LABELS: Record<NotifyEvent, { label: string; detail: string }> = {
  posted: { label: "Posted", detail: "A post reached Instagram, and how many selects are left in the pool." },
  failed: {
    label: "Failed",
    detail: "A post failed for good, or Instagram has not said whether it published one.",
  },
  token: {
    label: "Token about to expire",
    detail: "Once a day while the Instagram token expires within 7 days or no longer works.",
  },
  pool: { label: "Pool running low", detail: "Once when the pool drops below the number you set." },
};

const formatTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Notifications in Settings: which events notify, the ntfy topic and the webhook, each with a
 * Send test, and the latest notices. Never shows a topic, token or URL in full once saved.
 */
export function NotificationSettings() {
  const [view, setView] = useState<Notifications | undefined>();
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.notifications.get();
      if (data) setView(data);
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="notifications" className="flex flex-col gap-3">
      <h2 id="notifications" className="text-sm font-medium text-muted-foreground">
        Notifications
      </h2>
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      {view !== undefined && (
        <>
          {view.mode === "fake" && (
            <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              Fake mode: nothing leaves Selects. Notices are listed below as what would have been sent, and
              Send test sends nothing. Set <code>INSTAGRAM_API=live</code> to send them.
            </p>
          )}
          <EventsEditor
            saved={{ events: view.events, poolThreshold: view.poolThreshold }}
            onSaved={(next) => setView((current) => current && { ...current, ...next })}
          />
          <NtfyChannel channel={view.ntfy} onChange={load} />
          <WebhookChannel channel={view.webhook} onChange={load} />
          <RecentNotices recent={view.recent} />
        </>
      )}
    </section>
  );
}

function EventsEditor({ saved, onSaved }: { saved: EventSettings; onSaved: (next: EventSettings) => void }) {
  const [draft, setDraft] = useState<EventsDraft>(() => ({
    events: saved.events,
    poolThreshold: String(saved.poolThreshold),
  }));
  const parsed = useMemo(() => parseEvents(draft, saved), [draft, saved]);
  const save = useAutosave({
    value: parsed.settings,
    loaded: saved,
    save: async (next) => {
      const answer = await api.notifications.events.put(next);
      if (answer.data) onSaved({ events: answer.data.events, poolThreshold: answer.data.poolThreshold });
      return answer;
    },
    url: "/api/notifications/events",
    ms: SETTLE_MS,
    onNewer: (newer) => setDraft({ events: newer.events, poolThreshold: String(newer.poolThreshold) }),
  });

  return (
    <form
      aria-label="Events"
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm text-card-foreground"
      onSubmit={(event) => event.preventDefault()}
    >
      <p className="font-medium">Events</p>
      {(Object.keys(EVENT_LABELS) as NotifyEvent[]).map((event) => (
        <div key={event} className="flex flex-col gap-1">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={draft.events[event]}
              onChange={(change) => {
                const on = change.currentTarget.checked;
                setDraft((d) => ({ ...d, events: { ...d.events, [event]: on } }));
              }}
              className="size-4 accent-primary"
            />
            {EVENT_LABELS[event].label}
          </label>
          <p className="pl-6 text-muted-foreground">{EVENT_LABELS[event].detail}</p>
          {event === "pool" && (
            <div className="flex flex-col gap-1 pl-6">
              <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                Below
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Pool size to notify below"
                  aria-invalid={parsed.error !== undefined}
                  aria-describedby={parsed.error === undefined ? undefined : "pool-threshold-error"}
                  value={draft.poolThreshold}
                  disabled={!draft.events.pool}
                  onChange={(change) => {
                    const poolThreshold = change.currentTarget.value;
                    setDraft((d) => ({ ...d, poolThreshold }));
                  }}
                  className="h-10 w-20 rounded-md border bg-background px-2 text-center text-base aria-invalid:border-destructive disabled:opacity-50 md:text-sm"
                />
                selects in the pool.
              </p>
              {parsed.error !== undefined && (
                <p id="pool-threshold-error" className="text-destructive">
                  Pool size: {parsed.error}
                </p>
              )}
            </div>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Notices never carry a location, a file name, a caption or a link: only what happened.
      </p>
      <SaveStatus save={save} />
    </form>
  );
}

type ChannelStatus = { lastError: { at: number; reason: string } | null; lastSentAt: number | null };

/** The channel's last delivery, and Send test with its result, beside the channel's other buttons. */
function ChannelFooter({
  channel,
  status,
  onChange,
  children,
}: {
  channel: "ntfy" | "webhook";
  status: ChannelStatus;
  onChange: () => Promise<void>;
  children: ReactNode;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | undefined>();

  const test = async () => {
    setTesting(true);
    setResult(undefined);
    try {
      const { data, error } = await api.notifications({ channel }).test.post();
      if (data) setResult({ text: testResultText(data), failed: data.status === "failed" });
      else if (error) setResult({ text: "Couldn't send the test. Try again.", failed: true });
      await onChange();
    } catch {
      setResult({ text: "Couldn't reach the server.", failed: true });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {status.lastError !== null && (
        <p className="text-destructive">
          Last failed {formatTime(status.lastError.at)}: {status.lastError.reason}
        </p>
      )}
      {status.lastSentAt !== null && status.lastError === null && (
        <p className="text-muted-foreground">Last sent {formatTime(status.lastSentAt)}.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={test} disabled={testing}>
          {testing ? "Sending…" : "Send test"}
        </Button>
        {children}
      </div>
      {result !== undefined && (
        <p role="status" className={result.failed ? "text-destructive" : "text-muted-foreground"}>
          {result.text}
        </p>
      )}
    </>
  );
}

/** Remove, after a second press. */
function RemoveChannel({
  channel,
  onChange,
}: {
  channel: "ntfy" | "webhook";
  onChange: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    setFailed(false);
    try {
      const { error } = await api.notifications({ channel }).delete();
      if (error) throw error;
      setConfirm(false);
      await onChange();
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      {confirm ? (
        <>
          <Button variant="destructive" onClick={remove}>
            Remove
          </Button>
          <Button variant="ghost" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          Remove…
        </Button>
      )}
      {failed && <p className="w-full text-destructive">Couldn't remove it. Try again.</p>}
    </>
  );
}

const inputClass = "h-10 rounded-md border bg-background px-3 text-base md:text-sm";

function NtfyChannel({
  channel,
  onChange,
}: {
  channel: Notifications["ntfy"];
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [server, setServer] = useState("");
  const [topic, setTopic] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | undefined>();

  const close = () => {
    // What was typed and not saved does not stay on the page.
    setServer("");
    setTopic("");
    setToken("");
    setProblems(undefined);
    setEditing(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems(undefined);
    try {
      const { error } = await api.notifications.ntfy.put({
        server,
        topic,
        token: token === "" ? null : token,
      });
      if (error) {
        setProblems(problemsIn(error.value));
        return;
      }
      close();
      await onChange();
    } catch {
      setProblems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <p className="font-medium">ntfy</p>
      {channel !== null && !editing && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted-foreground">Server</dt>
          <dd className="break-all">{channel.server}</dd>
          <dt className="text-muted-foreground">Topic</dt>
          <dd data-testid="ntfy-topic">{channel.topic}</dd>
          <dt className="text-muted-foreground">Access token</dt>
          <dd>{channel.token ? "Set" : "None"}</dd>
        </dl>
      )}
      {channel === null && !editing && <p className="text-muted-foreground">Not set.</p>}
      {editing ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="ntfy-server" className="font-medium">
            Server URL
          </label>
          <input
            id="ntfy-server"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://ntfy.sh"
            value={server}
            onChange={(event) => setServer(event.currentTarget.value)}
            className={inputClass}
          />
          <label htmlFor="ntfy-topic" className="font-medium">
            Topic
          </label>
          <input
            id="ntfy-topic"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={topic}
            onChange={(event) => setTopic(event.currentTarget.value)}
            className={inputClass}
          />
          <label htmlFor="ntfy-token" className="font-medium">
            Access token <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id="ntfy-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            className={inputClass}
          />
          <p className="text-xs text-muted-foreground">
            Anyone who knows a topic's name can read it: choose one hard to guess. The topic and token are
            kept on this server and never shown again in full. Saving replaces both.
          </p>
          {problems !== undefined && (
            <p className="text-destructive">
              {problems.length > 0 ? problems.join(" ") : "Couldn't save. Try again."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || server.trim() === "" || topic.trim() === ""}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {channel === null ? (
            <div>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Set up…
              </Button>
            </div>
          ) : (
            <ChannelFooter channel="ntfy" status={channel} onChange={onChange}>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Change…
              </Button>
              <RemoveChannel channel="ntfy" onChange={onChange} />
            </ChannelFooter>
          )}
        </>
      )}
    </div>
  );
}

function WebhookChannel({
  channel,
  onChange,
}: {
  channel: Notifications["webhook"];
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | undefined>();

  const close = () => {
    setUrl("");
    setProblems(undefined);
    setEditing(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems(undefined);
    try {
      const { error } = await api.notifications.webhook.put({ url });
      if (error) {
        setProblems(problemsIn(error.value));
        return;
      }
      close();
      await onChange();
    } catch {
      setProblems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <p className="font-medium">Webhook</p>
      <p className="text-muted-foreground">
        The Selects server, not your browser, sends each notice to this URL as a JSON POST with its{" "}
        <code>event</code>, <code>title</code> and <code>message</code>. Redirects are not followed.
      </p>
      {channel !== null && !editing && (
        <p className="break-all" data-testid="webhook-url">
          {channel.url}
        </p>
      )}
      {channel === null && !editing && <p className="text-muted-foreground">Not set.</p>}
      {editing ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="webhook-url" className="font-medium">
            URL
          </label>
          <input
            id="webhook-url"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            className={inputClass}
          />
          <p className="text-xs text-muted-foreground">
            An http or https URL. Only its scheme and host are shown again: the rest may be a secret.
          </p>
          {problems !== undefined && (
            <p className="text-destructive">
              {problems.length > 0 ? problems.join(" ") : "Couldn't save. Try again."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || url.trim() === ""}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {channel === null ? (
            <div>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Set up…
              </Button>
            </div>
          ) : (
            <ChannelFooter channel="webhook" status={channel} onChange={onChange}>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Change…
              </Button>
              <RemoveChannel channel="webhook" onChange={onChange} />
            </ChannelFooter>
          )}
        </>
      )}
    </div>
  );
}

function RecentNotices({ recent }: { recent: SentNotice[] }) {
  if (recent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground">
      <p className="font-medium">Latest notices</p>
      <ul className="flex flex-col gap-3">
        {recent.slice(0, 5).map((notice) => (
          <li key={`${notice.at}-${notice.event}-${notice.title}`} className="flex flex-col gap-0.5">
            <span className="font-medium">{notice.title}</span>
            <span className="text-muted-foreground">{notice.message}</span>
            <span
              className={notice.outcome === "failed" ? "text-destructive" : "text-xs text-muted-foreground"}
            >
              {formatTime(notice.at)} · {outcomeText(notice.outcome)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
