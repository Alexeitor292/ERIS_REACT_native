import { Link, NavLink } from "react-router-dom";
import { ReactNode, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useUiSettings } from "./UiSettingsContext";

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function navAbbrev(label: string) {
  const words = label.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function NavItem({ to, label, collapsed }: { to: string; label: string; collapsed?: boolean }) {
  const abbrev = useMemo(() => navAbbrev(label), [label]);
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "block rounded-lg px-3 py-2 text-sm font-medium transition-all",
          collapsed ? "text-center" : "",
          isActive
            ? "bg-[var(--brand)] text-white shadow-[0_8px_20px_rgba(31,94,255,0.25)]"
            : "bg-[var(--panel-soft)] text-[var(--ink)] hover:brightness-95"
        )
      }
      title={collapsed ? label : undefined}
    >
      {collapsed ? abbrev : label}
    </NavLink>
  );
}

export default function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { me, logout } = useAuth();
  const { theme } = useUiSettings();
  const [navExpanded, setNavExpanded] = useState(false);

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

      <div className="mx-auto w-full max-w-[1900px] px-4 md:px-6 py-6 flex-1 flex flex-col gap-4 lg:flex-row lg:gap-6">
        <aside className="lg:hidden">
          <div className="product-card p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div>
            <nav className="space-y-1.5">
              <NavItem to="/mission-center" label="Mission Center" />
              <NavItem to="/incidents" label="Incidents" />
              <NavItem to="/submissions" label="Submissions" />
              <NavItem to="/settings" label="Settings" />
              {me?.roles?.includes("ADMIN") && <NavItem to="/admin/users" label="Admin Users" />}
              {me?.roles?.includes("ADMIN") && <NavItem to="/admin/road-inventory" label="Road Inventory" />}
            </nav>
          </div>
        </aside>

        <aside
          className={cn(
            "hidden lg:block shrink-0 transition-[width] duration-200 ease-out",
            navExpanded ? "w-64" : "w-16"
          )}
          onMouseEnter={() => setNavExpanded(true)}
          onMouseLeave={() => setNavExpanded(false)}
        >
          <div className="product-card p-2 h-full">
            <div className={cn("px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted", navExpanded ? "" : "text-center")}>
              {navExpanded ? "Navigation" : "Nav"}
            </div>
            <nav className="space-y-1.5">
              <NavItem to="/mission-center" label="Mission Center" collapsed={!navExpanded} />
              <NavItem to="/incidents" label="Incidents" collapsed={!navExpanded} />
              <NavItem to="/submissions" label="Submissions" collapsed={!navExpanded} />
              <NavItem to="/settings" label="Settings" collapsed={!navExpanded} />
              {me?.roles?.includes("ADMIN") && <NavItem to="/admin/users" label="Admin Users" collapsed={!navExpanded} />}
              {me?.roles?.includes("ADMIN") && <NavItem to="/admin/road-inventory" label="Road Inventory" collapsed={!navExpanded} />}
            </nav>

            <div className={cn("mt-4 border-t border-[var(--line)] pt-3 text-xs text-muted px-2", navExpanded ? "" : "hidden")}>
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

        <main className="min-w-0 flex-1">
          <div className="mb-4">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted">
              Internal review portal for field submissions and attachments.
            </p>
          </div>
          <div className="product-card h-full overflow-hidden">{children}</div>
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
