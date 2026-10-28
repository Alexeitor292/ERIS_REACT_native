import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { landingPathFor } from "../utils/roleModel";

export default function EntraCompletePage() {
  const { finishEntra } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    finishEntra().then((me) => {
      if (live) navigate(me.maintenance_districts?.length ? "/maintenance-work" : landingPathFor(me.roles), { replace: true });
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Entra sign-in failed"); });
    return () => { live = false; };
    // Handoff is consumed once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <main className="mx-auto max-w-md p-8 text-center">{error ? <><p>{error}</p><a href="/login">Return to sign in</a></> : "Completing Caltrans sign-in…"}</main>;
}
