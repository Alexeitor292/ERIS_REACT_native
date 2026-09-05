import { NavLink, useLocation } from "react-router-dom";
import { Fragment, useState, type ReactNode } from "react";
import {
  ClipboardCheck,
  Inbox,
  Layers,
  Map as MapIcon,
  Mountain,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Settings,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useUiSettings } from "./UiSettingsContext";
import { hasWorkQueue, isAdmin, isOperationalUser } from "../utils/roleModel";

const NAV_ICON_STROKE = 1.9;

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type NavEntry = { to: string; label: string; icon: LucideIcon; alsoActive?: string[] };
type NavSection = { label: string; items: NavEntry[] };

function NavItem({ to, label, icon: Icon, alsoActive, collapsed }: NavEntry & { collapsed?: boolean }) {
  const { pathname } = useLocation();
  const extraActive = (alsoActive ?? []).some((prefix) => pathname.startsWith(prefix));
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center rounded-lg text-sm font-medium transition-[background-color,color,box-shadow]",
          collapsed ? "h-10 w-10 justify-center" : "gap-2.5 px-3 py-2",
          isActive || extraActive
            ? "bg-[var(--brand)] text-white shadow-[0_8px_20px_rgba(31,94,255,0.25)]"
            : "text-[var(--ink)] hover:bg-[var(--panel-soft)]"
        )
      }
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
    >
      <Icon size={18} strokeWidth={NAV_ICON_STROKE} aria-hidden className="shrink-0" />
      {collapsed ? null : <span className="truncate">{label}</span>}
    </NavLink>
  );
}

function NavGroup({ label, collapsed, children }: { label: string; collapsed?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className={cn("mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted", collapsed ? "sr-only" : "")}>{label}</div>
      <nav className={cn(collapsed ? "flex flex-col items-center gap-1" : "space-y-1")} aria-label={label}>{children}</nav>
    </div>
  );
}

/**
 * Information architecture:
 *   Workspace › My Work (role-gated actions)
 *   Operations › Mission Center / Event Groups / Incidents / Assessments (read-only records;
 *               submissions live inside assessments and have no nav item of their own)
 *   GIS Tools › Terrain Cross Sections
 *   Administration › Users / Road Inventory
 *   Account › Settings
 */
function useNavSections(): NavSection[] {
  const { me } = useAuth();
  const roles = me?.roles;
  const operational = isOperationalUser(roles);
  const admin = isAdmin(roles);

  const sections: NavSection[] = [];
  if (hasWorkQueue(roles)) {
    sections.push({ label: "Workspace", items: [{ to: "/my-work", label: "My Work", icon: Inbox }] });
  }

  const operations: NavEntry[] = [];
  if (operational) operations.push({ to: "/mission-center", label: "Mission Center", icon: MapIcon });
  if (operational) operations.push({ to: "/event-groups", label: "Event Groups", icon: Layers });
  operations.push({ to: "/incidents", label: "Incidents", icon: TriangleAlert });
  if (operational) operations.push({ to: "/assessments", label: "Assessments", icon: ClipboardCheck, alsoActive: ["/submissions"] });
  sections.push({ label: "Operations", items: operations });

  if (operational) {
    sections.push({ label: "GIS Tools", items: [{ to: "/gis/terrain-cross-sections", label: "Terrain Cross Sections", icon: Mountain }] });
  }
  if (admin) {
    sections.push({
      label: "Administration",
      items: [
        { to: "/admin/users", label: "Users", icon: Users },
        { to: "/admin/road-inventory", label: "Road Inventory", icon: Route },
      ],
    });
  }
  sections.push({ label: "Account", items: [{ to: "/settings", label: "Settings", icon: Settings }] });
  return sections;
}

function SidebarNavigation({ collapsed = false }: { collapsed?: boolean }) {
  const sections = useNavSections();

  return (
    <div className={collapsed ? "space-y-2" : "space-y-5"}>
      {sections.map((section, index) => (
        <Fragment key={section.label}>
          {collapsed && index > 0 ? <div aria-hidden className="mx-auto h-px w-6 bg-[var(--line)]" /> : null}
          <NavGroup label={section.label} collapsed={collapsed}>
            {section.items.map((item) => (
              <NavItem key={item.to} {...item} collapsed={collapsed} />
            ))}
          </NavGroup>
        </Fragment>
      ))}
    </div>
  );
}

const THEME_OPTIONS = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "coastal", label: "Coastal" },
] as const;

export default function AppShell({ title, children, workspace = false }: { title: string; children: ReactNode; workspace?: boolean }) {
  const { me, logout } = useAuth();
  const { theme, setTheme } = useUiSettings();
  const [navExpanded, setNavExpanded] = useState(true);
  const displayName = me?.full_name?.trim() || me?.email || "Signed-in user";

  return (
    <div className={cn("flex flex-col text-[var(--ink)]", workspace ? "min-h-screen lg:h-screen lg:overflow-hidden" : "min-h-screen")}>
      <header className="sticky top-0 z-20 shrink-0 border-b border-[var(--line)] bg-[color:var(--panel)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1900px] items-center gap-3 px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/eris-logo.svg" alt="ERIS" className="h-9 w-9 shrink-0 rounded-md object-contain" />
            <div className="min-w-0 leading-tight"><div className="truncate text-sm font-semibold">Emergency Response Information System</div><div className="truncate text-xs text-muted">Caltrans | Geotechnical Services</div></div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <label className="hidden items-center gap-2 text-xs text-muted sm:flex">
              <span className="sr-only">Theme</span>
              <select
                value={theme}
                onChange={(event) => setTheme(event.target.value as typeof theme)}
                title="Theme (Settings › Appearance)"
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-medium text-[var(--ink)] hover:bg-[var(--panel-soft)]"
              >
                {THEME_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <div className="hidden text-right md:block"><div className="max-w-64 truncate text-sm font-medium">{displayName}</div><div className="text-xs text-muted">{me?.roles?.join(" · ") || "ERIS user"}</div></div>
            <button type="button" onClick={logout} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">Sign out</button>
          </div>
        </div>
      </header>

      <div className={cn("mx-auto flex w-full max-w-[1900px] flex-1 flex-col px-4 md:px-6 lg:flex-row", workspace ? "gap-3 py-3 lg:min-h-0 lg:gap-4" : "gap-4 py-6 lg:gap-6")}>
        <aside className="lg:hidden"><div className="product-card p-3"><div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div><SidebarNavigation /></div></aside>
        <aside className={cn("hidden shrink-0 transition-[width] duration-200 ease-out lg:block", navExpanded ? "w-64" : "w-16")}>
          <div className="product-card sticky top-[82px] p-2">
            <div className={cn("mb-3 flex items-center", navExpanded ? "justify-between px-1" : "justify-center")}>
              {navExpanded && <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div>}
              <button
                type="button"
                aria-label={navExpanded ? "Collapse navigation" : "Expand navigation"}
                aria-expanded={navExpanded}
                title={navExpanded ? "Collapse navigation" : "Expand navigation"}
                onClick={() => setNavExpanded((expanded) => !expanded)}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]"
              >
                {navExpanded ? <PanelLeftClose size={16} strokeWidth={NAV_ICON_STROKE} aria-hidden /> : <PanelLeftOpen size={16} strokeWidth={NAV_ICON_STROKE} aria-hidden />}
              </button>
            </div>
            <SidebarNavigation collapsed={!navExpanded} />
          </div>
        </aside>
        <main className={cn("min-w-0 flex-1", workspace ? "lg:flex lg:min-h-0 lg:flex-col" : "")}>
          <div className={workspace ? "mb-2 shrink-0" : "mb-4"}><h1 className={workspace ? "text-lg font-semibold" : "text-xl font-semibold"}>{title}</h1></div>
          <div className={cn("product-card overflow-hidden", workspace ? "lg:min-h-0 lg:flex-1" : "min-h-full")}>{children}</div>
        </main>
      </div>

      {!workspace ? <footer className="mt-auto border-t border-[var(--line)] bg-[color:var(--panel)]/70"><div className="mx-auto w-full max-w-[1900px] px-4 py-4 text-xs text-muted md:px-6">© {new Date().getFullYear()} Caltrans | ERIS (Internal)</div></footer> : null}
    </div>
  );
}
