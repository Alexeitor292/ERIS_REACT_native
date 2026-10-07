import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Fragment, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import {
  ClipboardCheck,
  Inbox,
  Layers,
  Map as MapIcon,
  Network,
  Mountain,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Search,
  Settings,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import NotificationBell from "../features/notifications/NotificationBell";
import { useUiSettings } from "./UiSettingsContext";
import HeaderSearch from "./HeaderSearch";
import ProfileMenu from "./ProfileMenu";
import { navigateWithTransition, pageRendered } from "./pageTransition";
import { hasWorkQueue, isAdmin, isOperationalUser, isPublicOnly, roleLabel } from "../utils/roleModel";
import { placeLabel } from "../utils/orgDistricts";
import type { UserOrg } from "../api/types";

const NAV_ICON_STROKE = 1.9;

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type NavEntry = { to: string; label: string; icon: LucideIcon; alsoActive?: string[] };
type NavSection = { label: string; items: NavEntry[] };

function NavItem({ to, label, icon: Icon, alsoActive, collapsed }: NavEntry & { collapsed?: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { pageTransitions } = useUiSettings();
  const extraActive = (alsoActive ?? []).some((prefix) => pathname.startsWith(prefix));
  return (
    <NavLink
      to={to}
      // The new page slides in while the frame stays put (ui/pageTransition.ts).
      onClick={(event) => {
        if (!pageTransitions || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (to === pathname) return;
        event.preventDefault();
        navigateWithTransition(navigate, to);
      }}
      className={({ isActive }) =>
        cn(
          "relative flex items-center overflow-hidden rounded-lg text-sm font-medium transition-[color,box-shadow]",
          collapsed ? "h-10 w-10 justify-center" : "gap-2.5 px-3 py-2",
          isActive || extraActive
            ? "text-white shadow-[0_8px_20px_rgba(31,94,255,0.25)]"
            : "text-[var(--ink)] hover:bg-[var(--panel-soft)]"
        )
      }
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
    >
      {({ isActive }) => (
        <>
          {/* The blue bar fills from left to right as the page arrives. */}
          {isActive || extraActive ? <span aria-hidden className="eris-nav-fill absolute inset-0 rounded-lg bg-[var(--brand)]" /> : null}
          <Icon size={18} strokeWidth={NAV_ICON_STROKE} aria-hidden className="relative shrink-0" />
          {collapsed ? null : <span className="relative truncate">{label}</span>}
        </>
      )}
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
 *   Operations › Mission Center / Incident Groups / Incidents / Assessments (read-only records;
 *               submissions live inside assessments and have no nav item of their own)
 *   GIS Tools › Terrain Cross Sections
 *   Administration › Users / Offices / Branches / Coverage / Road Inventory
 *   Account › Settings
 *
 * A read-only viewer gets ONE destination plus Settings: Records, opening on
 * Incidents. No Workspace, no Mission Center, no Incident Groups, no GIS Tools —
 * every one of those is work in flight, which is not the public record (org
 * model design §8, §11).
 */
function useNavSections(): NavSection[] {
  const { me } = useAuth();
  const roles = me?.roles;
  const operational = isOperationalUser(roles);
  const admin = isAdmin(roles);
  const viewerOnly = isPublicOnly(roles);

  if (viewerOnly) {
    return [
      {
        label: "Records",
        items: [
          { to: "/incidents", label: "Incidents", icon: TriangleAlert },
          { to: "/assessments", label: "Assessments", icon: ClipboardCheck, alsoActive: ["/submissions"] },
        ],
      },
    ];
  }

  const sections: NavSection[] = [];
  if (hasWorkQueue(roles)) {
    sections.push({ label: "Workspace", items: [{ to: "/my-work", label: "My Work", icon: Inbox }] });
  }

  const operations: NavEntry[] = [];
  if (operational) operations.push({ to: "/mission-center", label: "Mission Center", icon: MapIcon });
  if (operational) operations.push({ to: "/incident-groups", label: "Incident Groups", icon: Layers });
  operations.push({ to: "/incidents", label: "Incidents", icon: TriangleAlert });
  if (operational) operations.push({ to: "/assessments", label: "Assessments", icon: ClipboardCheck, alsoActive: ["/submissions"] });
  sections.push({ label: "Operations", items: operations });

  if (operational) {
    sections.push({ label: "GIS Tools", items: [{ to: "/gis/terrain-cross-sections", label: "Terrain Cross Sections", icon: Mountain }] });
  }
  if (!admin) {
    // Everyone can see the whole organization; what each person may change is decided on the page.
    sections.push({ label: "Team", items: [{ to: "/organization", label: "Organization", icon: Network }] });
  }
  if (admin) {
    sections.push({
      label: "Administration",
      items: [
        { to: "/admin/users", label: "Users", icon: Users },
        { to: "/organization", label: "Organization", icon: Network },
        { to: "/admin/road-inventory", label: "Road Inventory", icon: Route },
      ],
    });
  }
  // Settings lives in the profile menu (ui/ProfileMenu.tsx).
  return sections;
}

/**
 * "Office of Geotechnical Design West · Branch C · Oakland D4".
 *
 * The office's FULL name, not the short one: §9.1 of the redesign plan reserves
 * the short name for flow copy and gives the full name to headers and records.
 * Every part is optional — an account with no org record renders nothing rather
 * than a line of dashes.
 */
export function orgIdentityLine(org: UserOrg | null | undefined): string | null {
  if (!org) return null;
  const parts: string[] = [];
  const office = (org.office_name || "").trim() || (org.office_code || "").trim();
  if (office) parts.push(office);
  const branch = (org.branch_name || "").trim() || (org.branch_letter ? `Branch ${org.branch_letter}` : "");
  if (branch) parts.push(branch);
  const place = placeLabel(org.home_city, org.home_district);
  if (place) parts.push(place);
  return parts.length ? parts.join(" · ") : null;
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


export default function AppShell({ title, children, workspace = false }: { title: string; children: ReactNode; workspace?: boolean }) {
  const { me, logout } = useAuth();
  const { navCollapsed, setNavCollapsed } = useUiSettings();
  const navExpanded = !navCollapsed;
  const setNavExpanded = (update: (expanded: boolean) => boolean) => setNavCollapsed(!update(navExpanded));
  const sections = useNavSections();
  const pages = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const { pathname } = useLocation();
  // This page has rendered: a page transition waiting for it can run.
  useLayoutEffect(() => {
    pageRendered();
  }, [pathname]);

  const orgLine = orgIdentityLine(me?.org);

  return (
    <div className={cn("flex flex-col text-[var(--ink)]", workspace ? "min-h-screen lg:h-screen lg:overflow-hidden" : "min-h-screen")}>
      <header className="sticky top-0 z-30 shrink-0 border-b border-[var(--line)] bg-[color:color-mix(in_oklab,var(--panel)_86%,transparent)] backdrop-blur-xl" style={{ viewTransitionName: "eris-header" }}>
        <div className="mx-auto grid h-16 w-full max-w-[1900px] grid-cols-[auto_1fr_auto] items-center gap-4 px-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/eris-logo.svg" alt="" className="h-9 w-9 shrink-0 rounded-xl object-contain shadow-sm" />
            <div className="hidden min-w-0 leading-tight sm:block">
              <div className="truncate text-sm font-bold tracking-tight">ERIS</div>
              <div className="truncate text-[11px] text-muted">Emergency Response Information System</div>
            </div>
          </div>
          <div className="min-w-0">
            <HeaderSearch pages={pages} searchRecords={!!me && isOperationalUser(me.roles)} />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            {me && !isPublicOnly(me.roles) ? <NotificationBell /> : null}
            <span aria-hidden className="mx-1 hidden h-6 w-px bg-[var(--line)] sm:block" />
            <ProfileMenu orgLine={orgLine} />
          </div>
        </div>
      </header>

      <div className={cn("mx-auto flex w-full max-w-[1900px] flex-1 flex-col px-4 md:px-6 lg:flex-row", workspace ? "gap-3 py-3 lg:min-h-0 lg:gap-4" : "gap-4 py-6 lg:gap-6")}>
        <aside className="lg:hidden"><div className="product-card p-3"><div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Navigation</div><SidebarNavigation /></div></aside>
        <aside className={cn("hidden shrink-0 transition-[width] duration-200 ease-out lg:block", navExpanded ? "w-64" : "w-16")} style={{ viewTransitionName: "eris-nav" }}>
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
        <main className={cn("min-w-0 flex-1", workspace ? "lg:flex lg:min-h-0 lg:flex-col" : "")} style={{ viewTransitionName: "eris-page" }}>
          <div className={workspace ? "mb-2 shrink-0" : "mb-4"}><h1 className={workspace ? "text-lg font-semibold" : "text-xl font-semibold"}>{title}</h1></div>
          <div className={cn("product-card overflow-hidden", workspace ? "lg:min-h-0 lg:flex-1" : "min-h-full")}>{children}</div>
        </main>
      </div>

      {!workspace ? <footer className="mt-auto border-t border-[var(--line)] bg-[color:var(--panel)]/70"><div className="mx-auto w-full max-w-[1900px] px-4 py-4 text-xs text-muted md:px-6">© {new Date().getFullYear()} Caltrans | ERIS (Internal)</div></footer> : null}
    </div>
  );
}
