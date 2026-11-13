import type { Post } from "@selects/server";

/** A post's state in words: a short label and, when there is more to say, a sentence. */
export function describePost(
  post: Pick<Post, "state" | "error" | "nextAttemptAt" | "attempts"> & Partial<Pick<Post, "mode">>,
): {
  label: string;
  detail: string | null;
} {
  switch (post.state) {
    case "publishing":
      return { label: "Posting…", detail: null };
    case "retrying":
      return {
        label: "Retrying",
        detail: `${post.error ?? "The last attempt failed."} Next attempt ${post.nextAttemptAt === null ? "soon" : `at ${time(post.nextAttemptAt)}`} (${post.attempts + 1} of 4).`,
      };
    case "unconfirmed":
      return {
        label: "Needs checking",
        detail:
          post.error ??
          "Instagram was asked to publish it and has not said whether it did. Check Instagram, then say whether it was posted.",
      };
    case "published":
      if (post.mode === "fake") {
        return {
          label: "Fake post",
          detail: "Sent to the fake Instagram inside Selects: nothing was posted for real.",
        };
      }
      return { label: "Posted", detail: post.error };
    case "failed":
      return {
        label: "Failed",
        detail: `${post.error ?? "It could not be posted."} The select is back in the pool.`,
      };
    case "dry-run":
      return { label: "Dry run", detail: "Rendered and recorded. Nothing was uploaded or posted." };
  }
}

export function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
