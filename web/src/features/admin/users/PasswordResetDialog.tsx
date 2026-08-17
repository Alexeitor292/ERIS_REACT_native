import { useState } from "react";

import ModalDialog from "../../../ui/ModalDialog";

export default function PasswordResetDialog({
  userName,
  busy,
  onClose,
  onConfirm,
}: {
  userName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!password) {
      setError("Enter a new password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    try {
      await onConfirm(password);
    } catch (e: any) {
      setError(e?.message ?? "Password reset failed.");
    }
  }

  return (
    <ModalDialog
      titleId="password-reset-title"
      descriptionId="password-reset-description"
      busy={busy}
      onClose={onClose}
      panelClassName="w-full max-w-lg rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="password-reset-title" className="text-lg font-semibold">Reset password</h2>
          <p id="password-reset-description" className="mt-1 text-sm text-muted">Set a new password for {userName}. The existing password is not displayed or recovered.</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close password reset" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="mt-5 grid gap-4">
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">New password</span>
          <input data-dialog-initial-focus="true" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Confirm password</span>
          <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
        </label>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Resetting…" : "Reset password"}</button>
        </div>
      </div>
    </ModalDialog>
  );
}
