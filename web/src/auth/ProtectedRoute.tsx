import React from "react";
import { Navigate } from "react-router-dom";
import AuthGateLoading from "./AuthGateLoading";
import { useAuth } from "./AuthContext";

type Props = {
  children: React.ReactNode;
};

export default function ProtectedRoute({ children }: Props) {
  const { token, isInitializing } = useAuth();

  if (isInitializing) return <AuthGateLoading />;
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
