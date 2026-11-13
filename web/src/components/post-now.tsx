import type { Post, PostPreview, Select } from "@selects/server";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { problemsIn } from "@/lib/autosave";
import { describePost } from "@/lib/posts";

/** How often a post being published is checked on. */
const POLL_MS = 1500;
/** The confirmation's frame: big enough to check, quick to render. */
const FRAME_WIDTH = 480;

type Step =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "confirm"; preview: PostPreview }
  | { step: "sending"; preview: PostPreview }
  | { step: "sent"; post: Post }
  | { step: "failed"; problems: string[] };

/**
 * "Post now" for one select. Posting is permanent, so it goes in two steps: the first shows the
 * frame, caption and alt text that will go out, and only the second sends them.
 */
export function PostNow({ select, onPosted }: { select: Select; onPosted: () => void }) {
  const [state, setState] = useState<Step>({ step: "idle" });
  const live = useRef(true);
  // The caller's function changes on each of its renders; the latest is called.
  const posted = useRef(onPosted);
  posted.current = onPosted;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A post being published is checked on until it settles.
  const sentId = state.step === "sent" && isPending(state.post) ? state.post.id : undefined;
  useEffect(() => {
    if (sentId === undefined) return;
    const timer = setInterval(async () => {
      const { data } = await api.posts({ id: sentId }).get();
      if (!live.current || !data || !("state" in data)) return;
      setState({ step: "sent", post: data });
      if (!isPending(data)) posted.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sentId]);

  const review = async () => {
    setState({ step: "loading" });
    const { data, error } = await api
      .selects({ id: select.id })
      .publish.get()
      .catch(() => ({ data: null, error: { status: 0, value: null } }));
    if (!live.current) return;
    if (data && "caption" in data) setState({ step: "confirm", preview: data });
    else setState({ step: "failed", problems: problemsIn(error?.value) });
  };

  const send = async (preview: PostPreview) => {
    setState({ step: "sending", preview });
    const { data, error } = await api
      .selects({ id: select.id })
      // Everything the owner was shown: the server refuses if any of it no longer holds.
      .publish.post({
        caption: preview.caption,
        altText: preview.altText,
        hashtagSet: preview.hashtagSet ?? undefined,
        dryRun: preview.dryRun,
        instagram: preview.instagram,
        account: preview.account,
        frame: preview.frame,
      })
      .catch(() => ({ data: null, error: { status: 0, value: null } }));
    if (!live.current) return;
    if (data && "post" in data) {
      setState({ step: "sent", post: data.post });
      posted.current();
    } else {
      setState({ step: "failed", problems: problemsIn(error?.value) });
    }
  };

  if (select.alreadyPosted) return null;
  if (state.step !== "sent" && select.post !== null) {
    return (
      <p className="text-sm text-muted-foreground">
        {select.post === "published"
          ? "Posted. "
          : select.post === "unconfirmed"
            ? "Needs checking: Instagram has not said whether it was posted. "
            : "Being posted. "}
        <Link to="/posted" className="underline underline-offset-4">
          See Posted
        </Link>
      </p>
    );
  }

  switch (state.step) {
    case "idle":
      return (
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={review} className="self-start">
            Post now…
          </Button>
          <p className="text-xs text-muted-foreground">Shows what will go out before anything is sent.</p>
        </div>
      );
    case "loading":
      return <p className="text-sm text-muted-foreground">Getting the post ready…</p>;
    case "failed":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">
            {state.problems.length > 0 ? state.problems.join(" ") : "Couldn't get the post ready. Try again."}
          </p>
          <Button variant="outline" onClick={review} className="self-start">
            Review again
          </Button>
        </div>
      );
    case "confirm":
    case "sending":
      return (
        <Confirm
          selectId={select.id}
          preview={state.preview}
          sending={state.step === "sending"}
          onSend={() => send(state.preview)}
          onCancel={() => setState({ step: "idle" })}
        />
      );
    case "sent":
      return <Sent post={state.post} />;
  }
}

function Confirm({
  selectId,
  preview,
  sending,
  onSend,
  onCancel,
}: {
  selectId: string;
  preview: PostPreview;
  sending: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  const blocked = !preview.dryRun && preview.problems.length > 0;
  return (
    <div className="flex flex-col gap-4 rounded-md border p-3">
      <p className="text-sm font-medium">
        {preview.dryRun
          ? "Dry run is on: this is rendered and recorded, and nothing is uploaded or posted."
          : `This goes out to ${preview.account === null ? "Instagram" : `@${preview.account}`} and can only be removed in the Instagram app.`}
      </p>
      <img
        src={`/api/selects/${encodeURIComponent(selectId)}/frame?width=${FRAME_WIDTH}`}
        alt="The frame that will be posted"
        className="mx-auto aspect-[4/5] w-full max-w-60 rounded-sm border bg-muted object-contain"
      />
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <dt className="font-medium text-muted-foreground">
            Caption
            {preview.hashtagSet !== null && (
              <span className="font-normal"> · hashtag set {preview.hashtagSet}</span>
            )}
          </dt>
          <dd className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2">
            {preview.caption || <span className="italic text-muted-foreground">Empty</span>}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-medium text-muted-foreground">Alt text</dt>
          <dd className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2">
            {preview.altText || <span className="italic text-muted-foreground">Empty</span>}
          </dd>
        </div>
      </dl>
      {preview.problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {preview.problems.map((problem) => (
            <li key={problem} className="text-destructive">
              {problem}
            </li>
          ))}
          {preview.dryRun && <li className="text-muted-foreground">A real post would stop here.</li>}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onSend} disabled={blocked || sending}>
          {sending ? "Sending…" : preview.dryRun ? "Dry run" : "Post to Instagram"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Sent({ post }: { post: Post }) {
  const { label, detail } = describePost(post);
  return (
    <div role="status" className="flex flex-col gap-2 text-sm">
      <p className="font-medium">{label}</p>
      {detail && (
        <p
          className={
            post.state === "failed" || post.state === "unconfirmed"
              ? "text-destructive"
              : "text-muted-foreground"
          }
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
      <Link to="/posted" className="self-start text-muted-foreground underline underline-offset-4">
        {post.state === "dry-run" ? "See the dry run in Posted" : "See Posted"}
      </Link>
    </div>
  );
}

function isPending(post: Post) {
  return post.state === "publishing" || post.state === "retrying";
}
