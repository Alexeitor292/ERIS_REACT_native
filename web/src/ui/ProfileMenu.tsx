import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, LogOut, Moon, Settings, Sun, Waves } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { roleLabel } from "../utils/roleModel";
import { useUiSettings } from "./UiSettingsContext";

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "coastal", label: "Coastal", icon: Waves },
] as const;

function initialsOf(name: string): string {
  const cleaned = name.replace(/\(.*?\)/g, "").trim();
  const words = (cleaned.includes("@") ? cleaned.split("@")[0].replace(/[._-]+/g, " ") : cleaned).split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.length === 1 ? words[0].slice(0, 2).toUpperCase() : (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** The signed-in person: who they are, the theme, Settings and Sign out. */
export default function ProfileMenu({ orgLine }: { orgLine: string | null }) {
  const { me, logout } = useAuth();
  const { theme, setTheme } = useUiSettings();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const name = me?.full_name?.trim() || me?.email || "Signed-in user";
  const roles = me?.roles?.map(roleLabel).join(" · ") || "ERIS user";

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-full border border-transparent py-1 pl-1 pr-2 hover:border-[var(--line)] hover:bg-[var(--panel-soft)]"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand)] text-xs font-bold text-white">{initialsOf(name)}</span>
        <span className="hidden min-w-0 text-left leading-tight md:block">
          <span className="block max-w-48 truncate text-sm font-medium">{name}</span>
          <span className="block max-w-48 truncate text-[11px] text-muted">{roles}</span>
        </span>
        <ChevronDown size={14} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
          >
            <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-sm font-bold text-white">{initialsOf(name)}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{name}</span>
                <span className="block truncate text-xs text-muted">{me?.email}</span>
                <span className="block truncate text-xs text-muted">{roles}</span>
                {orgLine ? <span className="block truncate text-xs text-muted" title={orgLine}>{orgLine}</span> : null}
              </span>
            </div>

            <div className="px-4 py-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Theme</div>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--panel-soft)] p-1">
                {THEMES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setTheme(option.id)}
                    aria-pressed={theme === option.id}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${
                      theme === option.id ? "bg-[var(--panel)] text-[var(--ink)] shadow-sm" : "text-muted hover:text-[var(--ink)]"
                    }`}
                  >
                    <option.icon size={13} aria-hidden /> {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-[var(--line)] p-1.5">
              <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-[var(--panel-soft)]">
                <Settings size={16} className="text-muted" aria-hidden /> Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={logout}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_8%,var(--panel))]"
              >
                <LogOut size={16} aria-hidden /> Sign out
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
