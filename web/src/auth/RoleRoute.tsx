import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import AuthGateLoading from "./AuthGateLoading";
import AccessDeniedPage from "./AccessDenied";
import { useAuth } from "./AuthContext";
import { hasMaintenanceDuties, landingPathFor } from "../utils/roleModel";

type Props = {
  roles: string[];
  /** Also let in anyone with district maintenance duties (My Work). */
  allowMaintenanceDuties?: boolean;
  children: ReactNode;
};

/**
 * A role gate over a route.
 *
 * A refusal used to land on `/submissions` — a page listing every submission in
 * ERIS, and so the worst possible destination for an account that was just told
 * it may not see something. It now lands on the reader's OWN landing (My Work
 * for a role with a queue, Incidents for a viewer or a reporter), and falls back
 * to an explicit "you do not have access" surface when that landing is the page
 * that was refused — a redirect loop is not an explanation (org model design §8).
 */
export default function RoleRoute({ roles, allowMaintenanceDuties = false, children }: Props) {
  const { me, signedIn, isInitializing } = useAuth();
  const { pathname } = useLocation();

  if (isInitializing) return <AuthGateLoading />;
  if (!signedIn) return <Navigate to="/login" replace />;
  if (!me) return <Navigate to="/login" replace />;

  const allowed = roles.some((role) => me.roles?.includes(role)) || (allowMaintenanceDuties && hasMaintenanceDuties(me));
  if (!allowed) {
    const landing = landingPathFor(me.roles, hasMaintenanceDuties(me));
    if (landing !== pathname) return <Navigate to={landing} replace />;
    return <AccessDeniedPage />;
  }

  return <>{children}</>;
}
