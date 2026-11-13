import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api";

/**
 * Shown on every screen while Selects runs in fake mode: Instagram and the bucket are fakes
 * inside Selects, so nothing is posted for real.
 */
export function FakeModeBanner() {
  const [fake, setFake] = useState(false);

  useEffect(() => {
    let live = true;
    api.publishing
      .get()
      .then(({ data }) => {
        if (live && data) setFake(data.instagram.mode === "fake");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!fake) return null;
  return (
    <div
      role="status"
      aria-label="Fake mode"
      className="flex items-start gap-2 border-b bg-secondary px-4 py-2 text-sm text-secondary-foreground md:px-8"
    >
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-medium">Fake mode.</span> Instagram and the bucket are fakes inside Selects:
        nothing is posted for real. Set <code>INSTAGRAM_API=live</code> to post.
      </p>
    </div>
  );
}
