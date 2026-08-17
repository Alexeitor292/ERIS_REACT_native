import { useMemo } from "react";

import type { SubmissionPermissionGrant, SubmissionPermissionUser } from "../../api/types";
import { Section } from "./SubmissionDetailPrimitives";
import { filterShareCandidates, shareUserLabel } from "./submissionAccessSharingModel";

export default function SubmissionAccessSharing({
  query,
  availableUsers,
  sharedWith,
  busy,
  onQueryChange,
  onGrant,
  onRevoke,
}: {
  query: string;
  availableUsers: SubmissionPermissionUser[];
  sharedWith: SubmissionPermissionGrant[];
  busy: boolean;
  onQueryChange: (value: string) => void;
  onGrant: (userId: number) => void;
  onRevoke: (userId: number) => void;
}) {
  const candidates = useMemo(
    () => filterShareCandidates(availableUsers, query, sharedWith),
    [availableUsers, query, sharedWith],
  );
  const searching = query.trim().length > 0;

  return (
    <Section title="Access Sharing">
      <p className="mb-3 text-sm text-muted">
        Grant read access to this submission without changing ownership or edit permissions.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Find a user</span>
        <input
          type="search"
          autoComplete="off"
          className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
          placeholder="Search by name or email"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          disabled={busy}
        />
      </label>

      {searching ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Available users</div>
          {candidates.length === 0 ? (
            <div className="mt-1 rounded border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
              No matching users are available to grant.
            </div>
          ) : (
            <div className="mt-2 space-y-1">
              {candidates.map((user) => (
                <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--line)] p-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{shareUserLabel(user)}</div>
                    <div className="truncate text-xs text-muted">{user.email}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onGrant(user.id)}
                    disabled={busy}
                    className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60"
                  >
                    Grant read access
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
        Users with explicit read access ({sharedWith.length})
      </div>
      {sharedWith.length === 0 ? (
        <div className="mt-1 text-sm text-muted">No explicit read grants.</div>
      ) : (
        <div className="mt-2 space-y-1">
          {sharedWith.map((user) => (
            <div key={user.user_id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--line)] p-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{shareUserLabel(user)}</div>
                <div className="truncate text-xs text-muted">{user.email}</div>
              </div>
              <button
                type="button"
                onClick={() => onRevoke(user.user_id)}
                disabled={busy}
                className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60"
              >
                Revoke access
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
