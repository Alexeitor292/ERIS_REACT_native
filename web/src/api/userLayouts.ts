import { api } from "./client";

export type LayoutScope = "submission_canvas";

export type SavedLayout = {
  id: number;
  scope: LayoutScope;
  name: string;
  layout: Record<string, unknown>;
  is_default: boolean;
  updated_at: string | null;
};

export function listMyLayouts(scope: LayoutScope) {
  return api<{ items: SavedLayout[] }>(`/me/layouts?scope=${scope}`);
}

export function createMyLayout(scope: LayoutScope, name: string, layout: Record<string, unknown>, isDefault = false) {
  return api<SavedLayout>("/me/layouts", {
    method: "POST",
    body: JSON.stringify({ scope, name, layout, is_default: isDefault }),
  });
}

export function updateMyLayout(id: number, changes: { name?: string; layout?: Record<string, unknown>; is_default?: boolean }) {
  return api<SavedLayout>(`/me/layouts/${id}`, { method: "PUT", body: JSON.stringify(changes) });
}

export function deleteMyLayout(id: number) {
  return api<void>(`/me/layouts/${id}`, { method: "DELETE" });
}
