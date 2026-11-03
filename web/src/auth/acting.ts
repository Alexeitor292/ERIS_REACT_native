/**
 * Whom this browser tab is acting for, while someone is away (services/delegations.py).
 *
 * Per tab, so a person can keep their own work open beside it, and gone when the
 * tab closes: nobody finds themself still acting for a colleague the next morning.
 */
const KEY = "eris.actingFor";

export function actingFor(): number | null {
  try {
    const value = Number(sessionStorage.getItem(KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setActingFor(userId: number | null): void {
  try {
    if (userId == null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, String(userId));
  } catch {
    // Browser storage may be unavailable under hardened/private policies: acting simply does not start.
  }
}
