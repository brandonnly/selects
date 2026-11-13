import type { Post } from "@selects/server";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { dateTime, describePost } from "@/lib/posts";
import { cn } from "@/lib/utils";
import { Screen } from "./screen";

/** How often the list is checked again while a post is still being published. */
const POLL_MS = 3000;

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
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

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
            <PostRow key={post.id} post={post} />
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

function PostRow({ post }: { post: Post }) {
  const { label, detail } = describePost(post);
  const [selectId] = post.selectIds;
  return (
    <li className="flex gap-3 p-3">
      <Thumbnail selectId={selectId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className={cn("font-medium", post.state === "failed" && "text-destructive")}>{label}</span>
          <span className="text-xs text-muted-foreground">
            {dateTime(post.publishedAt ?? post.createdAt)}
          </span>
        </div>
        <p className="line-clamp-2 whitespace-pre-line break-words text-muted-foreground">{post.caption}</p>
        {detail && (
          <p
            className={cn("text-xs", post.state === "failed" ? "text-destructive" : "text-muted-foreground")}
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
      </div>
    </li>
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
