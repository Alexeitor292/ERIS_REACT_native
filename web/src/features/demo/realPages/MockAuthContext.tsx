import { useSyncExternalStore, type ReactNode } from "react";
import { mockDatabase } from "./mockDatabase";
export function AuthProvider({ children }: { children: ReactNode }) { return children; }
export function useAuth() {
  useSyncExternalStore(mockDatabase.subscribe, mockDatabase.snapshot);
  return { me: mockDatabase.me, signedIn: true, isInitializing: false,
    login: async () => mockDatabase.me, finishEntra: async () => mockDatabase.me,
    refreshMe: async () => {}, logout: async () => window.dispatchEvent(new Event("eris-demo-exit")), actFor: () => {} };
}
