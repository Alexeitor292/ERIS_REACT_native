import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

type Props = {
  roles: string[];
  children: ReactNode;
};

export default function RoleRoute({ roles, children }: Props) {
  const { me, token } = useAuth();

  if (!token) return <Navigate to="/login" replace />;
  if (!me) return null;

  const allowed = roles.some((role) => me.roles?.includes(role));
  if (!allowed) return <Navigate to="/submissions" replace />;

  return <>{children}</>;
}
