import { NavLink, useLocation } from "react-router-dom";
import { useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { isOperationalUser } from "../utils/roleModel";

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function navAbbrev(label: string) {
  const words = label.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
}

function pageDescription(pathname: string) {
  if (/^\/submissions\/[^/]+$/.test(pathname)) {
    return "Inspect field data, mapped evidence, attachments, terrain context, and review history.";
  }
  if (/^\/projects\/[^/]+$/.test(pathname)) {
    return "Review the Project area, associated Incidents, and Project history.";
  }

  const descriptions: Array<[string, string]> = [
    ["/mission-center", "Explore California Projects, Incidents, saved geometry, and mapped field-photo evidence through ArcGIS."],
    ["/projects", "Manage operational Projects and the Incidents grouped under each response area."],
    ["/incidents", "Manage emergency events and coordinate the field records associated with them."],
    ["/assessments", "Review geotechnical assessments and supporting field information."],
    ["/submissions", "Find, inspect, and review field submissions received by ERIS."],
    ["/admin/users", "Manage ERIS user access, account status, and assigned roles."],
    ["/admin/road-inventory", "Manage authoritative roadway reference data used by ERIS workflows."],
    ["/settings", "Manage your ERIS preferences and application experience."],
  ];

  return descriptions.find(([path]) => pathname.startsWith(path))?.[1]
    ?? "Emergency response operations and geotechnical review.";
}

function NavItem({ to, label, collapsed }: { to: string; label: string; collapsed?: boolean }) {
  const abbrev = useMemo(() => navAbbrev(label), [label]);

  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "block rounded-lg px-3 py-2 text-sm font-medium transition-[background-color,color,box-shadow]",
          collapsed ? "text-center" : "",
          isActive
            ? "bg-[var(--brand)] text-white shadow-[0_8px_20px_rgba(31,94,255,0.25)]"
            : "text-[var(--ink)] hover:bg-[var(--panel-soft)]"
        )
      }
      title={collapsed ? label : undefined}
    >
      {collapsed ? abbrev : label}
    </NavLink>
  );
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        className={cn(
          "mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted",
          collapsed ? "sr-only" : ""
        )}
      >
        {label}
      </div>
      <nav className="space-y-1">{children}</nav>
    </div>
  );
}

function SidebarNavigation({ collapsed = false }: { collapsed?: boolean }) {
  const { me } = useAuth();
  const operational = isOperationalUser(me?.roles);

  return (
    <div className="space-y-5">
      <NavGroup label="Operations" collapsed={collapsed}>
        {operational ? <NavItem to="/mission-center" label="Mission Center" collapsed={collapsed} /> : null}
        {operational ? <NavItem to="/projects" label="Projects" collapsed={collapsed} /> : null}
        <NavItem to="/incidents" label="Incidents" collapsed={collapsed} />
        <NavItem to="/assessments" label="Assessments" collapsed={collapsed} />
        <NavItem to="/submissions" label="Submissions" collapsed={collapsed} />
      </NavGroup>

      {me?.roles?.includes("ADMIN") && (
        <NavGroup label="Administration" collapsed={collapsed}>
          <NavItem to="/admin/users" label="Users" collapsed={collapsed} />
          <NavItem to="/admin/road-inventory" label="Road Inventory" collapsed={collapsed} />
        </NavGroup>
      )}

      <NavGroup label="Account" collapsed={collapsed}>
        <NavItem to="/settings" label="Settings" collapsed={collapsed} />
      </NavGroup>
    </div>
  );
}

export default function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const [navExpanded, setNavExpanded] = useState(true);
  const description = pageDescription(pathname);
  const displayName = me?.full_name?.trim() || me?.email || "Signed-in user";

  return (
    <div className="min-h-screen flex flex-col text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[color:var(--panel)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1900px] items-center gap-3 px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--brand)] text-xs font-bold tracking-wide text-white">
              ERIS
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold">Emergency Response Information System</div>
              <div className="truncate text-xs text-muted">Caltrans | Geotechnical Services</div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right md:block">
              <div className="max-w-64 truncate text-sm font-medium">{displayName}</div>
              <div className="text-xs text-muted">{me?.roles?.join(" · ") || "ERIS user"}</div>
            </div>

            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1900px] flex-1 flex-col gap-4 px-4 py-6 md:px-6 lg:flex-row lg:gap-6">
        <aside className="lg:hidden">
          <div className="product-card p-3">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div>
            <SidebarNavigation />
          </div>
        </aside>

        <aside
          className={cn(
            "hidden shrink-0 transition-[width] duration-200 ease-out lg:block",
            navExpanded ? "w-64" : "w-16"
          )}
        >
          <div className="product-card sticky top-[82px] p-2">
            <div className={cn("mb-3 flex items-center", navExpanded ? "justify-between px-1" : "justify-center")}>
              {navExpanded && (
                <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div>
              )}
              <button
                type="button"
                aria-label={navExpanded ? "Collapse navigation" : "Expand navigation"}
                aria-expanded={navExpanded}
                title={navExpanded ? "Collapse navigation" : "Expand navigation"}
                onClick={() => setNavExpanded((expanded) => !expanded)}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-sm font-semibold text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
              >
                {navExpanded ? "‹" : "›"}
              </button>
            </div>

            <SidebarNavigation collapsed={!navExpanded} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mb-4">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 max-w-4xl text-sm text-muted">{description}</p>
          </div>
          <div className="product-card h-full overflow-hidden">{children}</div>
        </main>
      </div>

      <footer className="mt-auto border-t border-[var(--line)] bg-[color:var(--panel)]/70">
        <div className="mx-auto w-full max-w-[1900px] px-4 py-4 text-xs text-muted md:px-6">
          © {new Date().getFullYear()} Caltrans | ERIS (Internal)
        </div>
      </footer>
    </div>
  );
}
