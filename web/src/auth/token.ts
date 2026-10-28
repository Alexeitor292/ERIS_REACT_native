// The ERIS session lives in an HttpOnly cookie that page scripts cannot read,
// so a cross-site-scripting bug cannot steal it. What scripts do read is the
// session's CSRF token, which every state-changing request must echo in a
// header: another site can make the browser send the cookie, but it can
// neither read this value nor set the header.

const CSRF_COOKIES = ["__Host-eris_csrf", "eris_csrf"];
export const CSRF_HEADER = "X-CSRF-Token";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readCsrfToken(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (CSRF_COOKIES.includes(name)) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function csrfToken(): string | null {
  return typeof document === "undefined" ? null : readCsrfToken(document.cookie);
}

/** The CSRF header for a request of this method (none for reads). */
export function csrfHeaders(method = "GET"): Record<string, string> {
  if (!UNSAFE.has(method.toUpperCase())) return {};
  const token = csrfToken();
  return token ? { [CSRF_HEADER]: token } : {};
}
