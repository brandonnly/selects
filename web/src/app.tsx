import { Captions, Frame, Images, ListOrdered, type LucideIcon, Send, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { FakeModeBanner } from "@/components/fake-mode-banner";
import { cn } from "@/lib/utils";
import { CaptionsScreen } from "./screens/captions";
import { FrameScreen } from "./screens/frame";
import { LibraryScreen } from "./screens/library";
import { PostedScreen } from "./screens/posted";
import { QueueScreen } from "./screens/queue";
import { SettingsScreen } from "./screens/settings";

type ScreenEntry = { path: string; label: string; icon: LucideIcon; element: ReactNode };

const screens: ScreenEntry[] = [
  { path: "/library", label: "Library", icon: Images, element: <LibraryScreen /> },
  { path: "/queue", label: "Queue", icon: ListOrdered, element: <QueueScreen /> },
  { path: "/posted", label: "Posted", icon: Send, element: <PostedScreen /> },
  { path: "/frame", label: "Frame", icon: Frame, element: <FrameScreen /> },
  { path: "/captions", label: "Captions", icon: Captions, element: <CaptionsScreen /> },
  { path: "/settings", label: "Settings", icon: Settings, element: <SettingsScreen /> },
];

export function App() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      <aside className="hidden border-r md:flex md:flex-col md:gap-6 md:p-4">
        <Brand />
        <nav aria-label="Screens" className="flex flex-col gap-1">
          {screens.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-secondary text-secondary-foreground",
                )
              }
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center border-b px-4 pt-[env(safe-area-inset-top)] md:hidden">
          <div className="flex h-14 items-center">
            <Brand />
          </div>
        </header>
        <FakeModeBanner />

        <main className="flex-1 px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-8 md:pb-8">
          <Routes>
            <Route index element={<Navigate to="/library" replace />} />
            {screens.map(({ path, element }) => (
              <Route key={path} path={path} element={element} />
            ))}
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </main>
      </div>

      <nav
        aria-label="Screens"
        className="fixed inset-x-0 bottom-0 grid grid-cols-6 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {screens.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              cn(
                "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground",
                isActive && "text-foreground",
              )
            }
          >
            <Icon aria-hidden className="size-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <img src="/favicon.svg" alt="" className="size-7 rounded-md" />
      Selects
    </span>
  );
}
