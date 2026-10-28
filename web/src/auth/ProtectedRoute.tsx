import React from "react";
import { Navigate } from "react-router-dom";
import AuthGateLoading from "./AuthGateLoading";
import { useAuth } from "./AuthContext";

type Props = {
  children: React.ReactNode;
};

export default function ProtectedRoute({ children }: Props) {
  const { signedIn, isInitializing } = useAuth();

  if (isInitializing) return <AuthGateLoading />;
  if (!signedIn) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
