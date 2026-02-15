import { Link, NavLink } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { useUiSettings } from "./UiSettingsContext";

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "block rounded-lg px-3 py-2 text-sm font-medium transition-all",
          isActive
            ? "bg-[var(--brand)] text-white shadow-[0_8px_20px_rgba(31,94,255,0.25)]"
            : "bg-[var(--panel-soft)] text-[var(--ink)] hover:brightness-95"
        )
      }
    >
      {label}
    </NavLink>
  );
}

export default function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { me, logout } = useAuth();
  const { theme } = useUiSettings();

  return (
    <div className="min-h-screen flex flex-col text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[color:var(--panel)]/90 backdrop-blur">
        <div className="mx-auto w-full max-w-[1900px] px-4 md:px-6 py-3 flex items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded bg-[var(--brand)] text-white flex items-center justify-center text-xs font-bold tracking-wide shrink-0">
              ERIS
            </div>
            <div className="leading-tight min-w-0">
              <div className="text-sm font-semibold truncate">Emergency Response Information System</div>
              <div className="text-xs text-muted truncate">Caltrans | Geotechnical Services</div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:block text-right">
              <div className="text-sm font-medium truncate">{me?.email ?? "-"}</div>
              <div className="text-xs text-muted">{me?.roles?.join(", ") ?? ""}</div>
            </div>

            <button
              onClick={logout}
              className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm hover:brightness-95"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1900px] px-4 md:px-6 py-6 grid grid-cols-12 gap-6 flex-1">
        <aside className="col-span-12 lg:col-span-3 xl:col-span-2">
          <div className="product-card p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div>
            <nav className="space-y-1.5">
              <NavItem to="/submissions" label="Submissions" />
              <NavItem to="/settings" label="Settings" />
              {me?.roles?.includes("ADMIN") && <NavItem to="/admin/users" label="Admin Users" />}
            </nav>

            <div className="mt-4 border-t border-[var(--line)] pt-3 text-xs text-muted">
              <div className="font-semibold text-[var(--ink)]">Environment</div>
              <div>Web Portal (Vite)</div>
              <div className="mt-1">Theme: {theme}</div>
              <div className="mt-1">
                <Link className="underline" to="/submissions">
                  Back to dashboard
                </Link>
              </div>
            </div>
          </div>
        </aside>

        <main className="col-span-12 lg:col-span-9 xl:col-span-10 min-w-0">
          <div className="mb-4">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted">
              Internal review portal for field submissions and attachments.
            </p>
          </div>
          <div className="product-card overflow-hidden">{children}</div>
        </main>
      </div>

      <footer className="mt-auto border-t border-[var(--line)] bg-[color:var(--panel)]/70">
        <div className="mx-auto w-full max-w-[1900px] px-4 md:px-6 py-4 text-xs text-muted">
          © {new Date().getFullYear()} Caltrans | ERIS (Internal)
        </div>
      </footer>
    </div>
  );
}
