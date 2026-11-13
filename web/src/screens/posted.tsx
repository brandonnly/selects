import type { Post } from "@selects/server";
import { ExternalLink } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn } from "@/lib/autosave";
import { dateTime, describePost } from "@/lib/posts";
import { cn } from "@/lib/utils";
import { Screen } from "./screen";

/** How often the list is checked again while a post is still being published. */
const POLL_MS = 3000;
/** And while one needs checking: Selects checks with Instagram every few minutes. */
const UNCONFIRMED_POLL_MS = 60_000;

type Loaded = { posts: Post[]; dryRuns: Post[] };

export function PostedScreen() {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.posts.get();
      if (data) setLoaded(data);
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending =
    loaded?.posts.some((post) => post.state === "publishing" || post.state === "retrying") ?? false;
  const unconfirmed = loaded?.posts.some((post) => post.state === "unconfirmed") ?? false;
  const pollMs = pending ? POLL_MS : unconfirmed ? UNCONFIRMED_POLL_MS : undefined;
  useEffect(() => {
    if (pollMs === undefined) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  return (
    <Screen title="Posted">
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      <section aria-labelledby="posts" className="flex flex-col gap-3">
        <h2 id="posts" className="text-sm font-medium text-muted-foreground">
          {loaded === undefined
            ? "Posts"
            : `${loaded.posts.length} ${loaded.posts.length === 1 ? "post" : "posts"}`}
        </h2>
        {loaded?.posts.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing posted yet. Open a select in the Library and choose Post now.
          </p>
        )}
        <ul className="flex flex-col divide-y rounded-lg border bg-card text-card-foreground">
          {loaded?.posts.map((post) => (
            <PostRow key={post.id} post={post} onChange={load} />
          ))}
        </ul>
      </section>

      {loaded !== undefined && loaded.dryRuns.length > 0 && (
        <section aria-labelledby="dry-runs" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="dry-runs" className="text-sm font-medium text-muted-foreground">
              Dry runs
            </h2>
            <p className="text-xs text-muted-foreground">
              What each post would have sent. Nothing was uploaded or posted. The latest 20 are kept.
            </p>
          </div>
          <ul className="flex flex-col divide-y rounded-lg border bg-card text-card-foreground">
            {loaded.dryRuns.map((post) => (
              <DryRunRow key={post.id} post={post} />
            ))}
          </ul>
        </section>
      )}
    </Screen>
  );
}

function PostRow({ post, onChange }: { post: Post; onChange: () => Promise<void> }) {
  const { label, detail } = describePost(post);
  const [selectId] = post.selectIds;
  return (
    <li className="flex gap-3 p-3">
      <Thumbnail selectId={selectId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span
            className={cn(
              "font-medium",
              (post.state === "failed" || post.state === "unconfirmed") && "text-destructive",
            )}
          >
            {label}
          </span>
          <span className="text-xs text-muted-foreground">
            {dateTime(post.publishedAt ?? post.createdAt)}
          </span>
        </div>
        <p className="line-clamp-2 whitespace-pre-line break-words text-muted-foreground">{post.caption}</p>
        {detail && (
          <p
            className={cn(
              "text-xs",
              post.state === "failed" || post.state === "unconfirmed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {detail}
          </p>
        )}
        {post.permalink !== null && (
          <a
            href={post.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start underline underline-offset-4"
          >
            Open on Instagram
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        )}
        {post.state === "unconfirmed" && <Resolve post={post} onResolved={onChange} />}
      </div>
    </li>
  );
}

/** The owner's answer for a post Instagram has not confirmed: posted, or not. */
function Resolve({ post, onResolved }: { post: Post; onResolved: () => Promise<void> }) {
  const [step, setStep] = useState<"choose" | "posted" | "not-posted">("choose");
  const [permalink, setPermalink] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | undefined>();
  const linkId = `permalink-${post.id}`;

  const answer = async (posted: boolean) => {
    setBusy(true);
    setProblems(undefined);
    try {
      const link = permalink.trim();
      const { error } = await api
        .posts({ id: post.id })
        .resolve.post(posted ? { posted, permalink: link === "" ? null : link } : { posted });
      if (error) {
        setProblems(problemsIn(error.value));
        return;
      }
      await onResolved();
    } catch {
      setProblems([]);
    } finally {
      setBusy(false);
    }
  };

  const submitPosted = (event: FormEvent) => {
    event.preventDefault();
    void answer(true);
  };

  return (
    <div className="mt-1 flex flex-col gap-2">
      {step === "choose" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setStep("posted")}>
            It was posted…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setStep("not-posted")}>
            It was not posted…
          </Button>
        </div>
      )}
      {step === "posted" && (
        <form onSubmit={submitPosted} className="flex flex-col gap-2">
          <label htmlFor={linkId} className="text-xs font-medium">
            Link to the post on Instagram (optional)
          </label>
          <input
            id={linkId}
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://www.instagram.com/p/…"
            value={permalink}
            onChange={(event) => setPermalink(event.currentTarget.value)}
            className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              Mark as posted
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStep("choose")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {step === "not-posted" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            The select goes back to the pool and can be posted again. Check Instagram first: if it is there,
            it would be posted twice.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" onClick={() => void answer(false)} disabled={busy}>
              Mark as not posted
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStep("choose")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {problems !== undefined && (
        <p className="text-xs text-destructive">
          {problems.length > 0 ? problems.join(" ") : "Couldn't save. Try again."}
        </p>
      )}
    </div>
  );
}

function DryRunRow({ post }: { post: Post }) {
  const report = post.report;
  return (
    <li className="flex flex-col gap-3 p-3 sm:flex-row">
      <img
        src={`/api/posts/${encodeURIComponent(post.id)}/frame`}
        alt="The frame this dry run rendered"
        loading="lazy"
        className="aspect-[4/5] w-full max-w-40 shrink-0 rounded-sm border bg-muted object-contain"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
        <span className="text-xs text-muted-foreground">{dateTime(post.createdAt)}</span>
        <p className="whitespace-pre-wrap break-words">{post.caption}</p>
        <p className="text-xs text-muted-foreground">Alt text: {post.altText}</p>
        {report !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Frame</dt>
            <dd>
              {report.frame.width} × {report.frame.height} JPEG, {Math.round(report.frame.bytes / 1024)} KB
            </dd>
            <dt className="text-muted-foreground">Caption</dt>
            <dd className="tabular-nums">
              {report.check.captionCharacters.toLocaleString()} characters, {report.check.hashtags} hashtags
              {post.hashtagSet !== null && ` (set ${post.hashtagSet})`}
            </dd>
            <dt className="text-muted-foreground">Upload</dt>
            <dd className="break-all">{report.upload === null ? "No bucket" : report.upload.key}</dd>
            <dt className="text-muted-foreground">Link</dt>
            <dd className="break-all">
              {report.upload === null
                ? "None"
                : report.upload.url === "public"
                  ? (report.upload.publicUrl ?? "Public URL")
                  : "A one-hour presigned link"}
            </dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd>{report.account === null ? "None connected" : `@${report.account}`}</dd>
          </dl>
        )}
        {report !== null && report.problems.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs">
            <li className="font-medium">A real post would stop:</li>
            {report.problems.map((problem) => (
              <li key={problem} className="text-destructive">
                {problem}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function Thumbnail({ selectId }: { selectId: string | undefined }) {
  if (selectId === undefined) {
    return <div aria-hidden className="size-16 shrink-0 rounded-sm bg-muted" />;
  }
  return (
    <img
      src={`/api/selects/${encodeURIComponent(selectId)}/thumbnail`}
      alt=""
      loading="lazy"
      className="size-16 shrink-0 rounded-sm bg-muted object-cover"
    />
  );
}
