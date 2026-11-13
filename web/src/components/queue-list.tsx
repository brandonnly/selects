import type { Select } from "@selects/server";
import { GripVertical, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Drag = {
  id: string;
  from: number;
  startY: number;
  dy: number;
  over: number;
  height: number;
  /** The queue's order when the drag began: a drop onto a queue that changed since moves nothing. */
  order: string;
};

/**
 * The queue, in order. A select is moved by dragging its handle, or with the arrow keys while the
 * handle has focus (Home and End for the top and bottom). Each move is announced.
 */
export function QueueList({
  selects,
  nextUp,
  onMove,
  onRemove,
}: {
  selects: Select[];
  /** Selects that are next up for a slot. */
  nextUp: ReadonlySet<string>;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  /** The select whose handle keeps focus after a move by keyboard. */
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);

  useEffect(() => {
    if (focusAfterMove === null) return;
    handles.current.get(focusAfterMove)?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove]);

  const moveTo = (index: number, to: number, byKeyboard: boolean) => {
    const select = selects[index];
    if (select === undefined) return;
    const target = Math.max(0, Math.min(selects.length - 1, to));
    if (target === index) return;
    onMove(index, target);
    setAnnouncement(`Moved ${select.fileName} to position ${target + 1} of ${selects.length}.`);
    if (byKeyboard) setFocusAfterMove(select.id);
  };

  const keyDown = (index: number) => (event: KeyboardEvent) => {
    const to =
      event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? selects.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    moveTo(index, to, true);
  };

  /** Where each row's middle was when the drag began, before anything moved. */
  const middles = useRef(new Map<string, number>());

  /** Where the dragged row would land: past every row whose middle is above its own. */
  const landing = (id: string, from: number, dy: number) => {
    const middle = (middles.current.get(id) ?? 0) + dy;
    return selects.filter((select, n) => n !== from && (middles.current.get(select.id) ?? 0) < middle).length;
  };

  const pointerDown = (index: number, id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    middles.current.clear();
    for (const [rowId, row] of rows.current) {
      const rect = row.getBoundingClientRect();
      middles.current.set(rowId, rect.top + rect.height / 2);
    }
    const height = rows.current.get(id)?.getBoundingClientRect().height ?? 0;
    setDrag({
      id,
      from: index,
      startY: event.clientY,
      dy: 0,
      over: index,
      height: height + GAP,
      order: orderOf(selects),
    });
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === null) return;
    const dy = event.clientY - drag.startY;
    setDrag({ ...drag, dy, over: landing(drag.id, drag.from, dy) });
  };
  const pointerUp = () => {
    if (drag === null) return;
    setDrag(null);
    // Resolved by select at the drop: the queue may have changed while it was dragged (a slot posted).
    const from = selects.findIndex((select) => select.id === drag.id);
    if (from < 0 || orderOf(selects) !== drag.order) {
      setAnnouncement("The queue changed while you dragged. Nothing was moved.");
      return;
    }
    moveTo(from, drag.over, false);
  };

  return (
    <>
      <ol className="flex flex-col gap-2" aria-label="Queue">
        {selects.map((select, index) => {
          const dragging = drag?.id === select.id;
          const shift = drag === null || dragging ? 0 : shiftOf(index, drag);
          return (
            <li
              key={select.id}
              ref={(element) => {
                if (element === null) rows.current.delete(select.id);
                else rows.current.set(select.id, element);
              }}
              style={{ transform: `translateY(${dragging ? (drag?.dy ?? 0) : shift}px)` }}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-card p-2 text-sm text-card-foreground",
                dragging ? "relative z-10 shadow-lg" : drag !== null && "transition-transform",
                nextUp.has(select.id) && "border-l-4 border-l-brand",
              )}
            >
              <button
                type="button"
                ref={(element) => {
                  if (element === null) handles.current.delete(select.id);
                  else handles.current.set(select.id, element);
                }}
                aria-label={`Reorder ${select.fileName}, position ${index + 1} of ${selects.length}. Use the arrow keys to move it.`}
                onKeyDown={keyDown(index)}
                onPointerDown={pointerDown(index, select.id)}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => setDrag(null)}
                className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:cursor-grabbing"
              >
                <GripVertical aria-hidden className="size-4" />
              </button>
              <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{index + 1}</span>
              <img
                src={`/api/selects/${select.id}/thumbnail`}
                alt=""
                loading="lazy"
                draggable={false}
                className="size-12 shrink-0 rounded-md bg-muted object-cover"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{select.fileName}</span>
                <span className="text-xs text-muted-foreground">
                  {nextUp.has(select.id) ? "Next up" : captured(select)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${select.fileName} from the queue`}
                onClick={() => {
                  onRemove(select.id);
                  setAnnouncement(`Removed ${select.fileName} from the queue.`);
                }}
                className="size-11 shrink-0 px-0"
              >
                <X aria-hidden className="size-4" />
              </Button>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

const orderOf = (selects: Select[]) => selects.map((select) => select.id).join(" ");

/** The gap between rows, in pixels: `gap-2`. */
const GAP = 8;

/** How far a row moves aside while another is dragged past it. */
function shiftOf(index: number, drag: Drag): number {
  if (drag.from < index && index <= drag.over) return -drag.height;
  if (drag.over <= index && index < drag.from) return drag.height;
  return 0;
}

function captured(select: Select): string {
  if (select.capturedAt === null) return "No capture date";
  return `Taken ${select.capturedAt.slice(0, 10)}`;
}
