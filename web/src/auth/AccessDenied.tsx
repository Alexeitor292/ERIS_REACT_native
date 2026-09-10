import { Link } from "react-router-dom";
import { Lock } from "lucide-react";

import { useAuth } from "./AuthContext";
import { landingPathFor } from "../utils/roleModel";

/**
 * The explicit refusal surface.
 *
 * Before the org model a refused route redirected to `/submissions` — a page
 * listing every submission in ERIS, which is the exact material a read-only
 * viewer must never see. A refusal now says so, and offers the landing that
 * belongs to the reader's own role (org model design §8).
 *
 * It is also what a viewer gets when they open a record that is not part of the
 * public record: the server answers 404 there rather than 403, so ids cannot be
 * probed, and this surface is what that 404 should look like — not a red toast
 * on a half-rendered form.
 */
export function AccessDeniedNotice({
  title = "You do not have access to this page",
  detail,
  landingLabel,
  landingTo,
}: {
  title?: string;
  detail?: string;
  landingLabel?: string;
  landingTo?: string;
}) {
  const { me } = useAuth();
  const to = landingTo ?? landingPathFor(me?.roles);
  const label = landingLabel ?? (to === "/my-work" ? "Go to My Work" : "Go to Incidents");
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-6 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--panel-soft)] text-muted">
        <Lock size={18} strokeWidth={1.9} aria-hidden />
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">
        {detail ?? "This part of ERIS is not open to your role. Nothing was changed, and nothing is missing from your own work."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link to={to} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95">{label}</Link>
        <Link to="/settings" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)]">Settings</Link>
      </div>
    </section>
  );
}

/** The same refusal as a whole page, for a route gate that has no shell around it. */
export default function AccessDeniedPage(props: Parameters<typeof AccessDeniedNotice>[0]) {
  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 text-[var(--ink)] sm:px-6">
      <div className="mx-auto max-w-2xl">
        <AccessDeniedNotice {...props} />
      </div>
    </main>
  );
}
