import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bookmark, Check, ChevronDown, Star, Trash2 } from "lucide-react";

import {
  createMyLayout,
  deleteMyLayout,
  listMyLayouts,
  updateMyLayout,
  type SavedLayout,
} from "../../api/userLayouts";
import { layoutSnapshot, sameCanvasLayout, type DashboardCanvasLayout } from "./submissionLayoutModel";

type Props = {
  layout: DashboardCanvasLayout;
  applyLayout: (saved: unknown) => void;
  buttonClassName: string;
};

/**
 * The GISA sheet's saved layouts: a person's own named arrangements of the
 * cards, kept on their account so they follow them to any computer. One can be
 * marked as the layout forms open with.
 */
export default function SavedLayoutsMenu({ layout, applyLayout, buttonClassName }: Props) {
  const [items, setItems] = useState<SavedLayout[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const appliedDefaultRef = useRef(false);

  const active = items.find((item) => item.id === activeId) ?? null;
  const edited = !!active && !sameCanvasLayout(active.layout, layout);

  useEffect(() => {
    let cancelled = false;
    listMyLayouts("submission_canvas")
      .then(({ items: loaded }) => {
        if (cancelled) return;
        setItems(loaded ?? []);
        const preferred = (loaded ?? []).find((item) => item.is_default);
        if (preferred && !appliedDefaultRef.current) {
          appliedDefaultRef.current = true;
          applyLayout(preferred.layout);
          setActiveId(preferred.id);
        }
      })
      .catch(() => {
        // Saved layouts are a convenience; the sheet works without them.
      });
    return () => {
      cancelled = true;
    };
  }, [applyLayout]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setNaming(false);
    setConfirmDeleteId(null);
    setError(null);
  }

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const saveNew = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      const created = await createMyLayout("submission_canvas", trimmed, layoutSnapshot(layout));
      setItems((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setActiveId(created.id);
      setNaming(false);
      setName("");
    });
  };

  const updateActive = () => {
    if (!active) return;
    void run(async () => {
      const saved = await updateMyLayout(active.id, { layout: layoutSnapshot(layout) });
      setItems((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
    });
  };

  const toggleDefault = (item: SavedLayout) => {
    void run(async () => {
      const saved = await updateMyLayout(item.id, { is_default: !item.is_default });
      setItems((prev) =>
        prev.map((other) =>
          other.id === saved.id ? saved : saved.is_default ? { ...other, is_default: false } : other,
        ),
      );
    });
  };

  const remove = (item: SavedLayout) => {
    if (confirmDeleteId !== item.id) {
      setConfirmDeleteId(item.id);
      return;
    }
    void run(async () => {
      await deleteMyLayout(item.id);
      setItems((prev) => prev.filter((other) => other.id !== item.id));
      if (activeId === item.id) setActiveId(null);
      setConfirmDeleteId(null);
    });
  };

  const label = active ? `${active.name}${edited ? " · edited" : ""}` : "Layouts";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="Save this arrangement, or open one you saved"
      >
        <Bookmark size={13} strokeWidth={2} aria-hidden />
        <span className="max-w-[16rem] truncate">{label}</span>
        <ChevronDown size={13} strokeWidth={2} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-80 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2 text-sm shadow-lg"
        >
          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">My layouts</div>

          {items.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">
              None yet. Arrange the cards the way you like, then save the arrangement here. It follows you to any
              computer.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-1 rounded-md hover:bg-[var(--panel-soft)]">
                  <button
                    type="button"
                    role="menuitem"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => {
                      applyLayout(item.layout);
                      setActiveId(item.id);
                      close();
                    }}
                  >
                    <span className="w-3.5 shrink-0">{item.id === activeId ? <Check size={14} aria-hidden /> : null}</span>
                    <span className="truncate">{item.name}</span>
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted hover:text-[var(--accent)]"
                    aria-pressed={item.is_default}
                    title={item.is_default ? "Forms open with this layout. Click to stop." : "Open forms with this layout"}
                    onClick={() => toggleDefault(item)}
                    disabled={busy}
                  >
                    <Star size={14} aria-hidden fill={item.is_default ? "currentColor" : "none"} />
                  </button>
                  <button
                    type="button"
                    className={`rounded px-1 py-1 text-xs ${confirmDeleteId === item.id ? "font-semibold text-[var(--bad)]" : "text-muted hover:text-[var(--bad)]"}`}
                    title="Delete this layout"
                    onClick={() => remove(item)}
                    disabled={busy}
                  >
                    {confirmDeleteId === item.id ? "Delete?" : <Trash2 size={14} aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 border-t border-[var(--line)] pt-2">
            {active && edited ? (
              <button
                type="button"
                className="mb-1 w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--panel-soft)]"
                onClick={updateActive}
                disabled={busy}
              >
                Update “{active.name}” with this arrangement
              </button>
            ) : null}
            {naming ? (
              <form onSubmit={saveNew} className="flex items-center gap-1 px-1">
                <input
                  autoFocus
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Name this layout"
                  aria-label="Layout name"
                  className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  disabled={busy || !name.trim()}
                >
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--panel-soft)]"
                onClick={() => setNaming(true)}
              >
                Save this arrangement as a new layout…
              </button>
            )}
            {error ? <p className="px-1 pt-1 text-xs text-[var(--bad)]">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
