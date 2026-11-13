import { mockDatabase, MockRefusal } from "./mockDatabase";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, setItem: (key, value) => { data.set(key, String(value)); } };
}
const PUBLIC_GIS = /(^|\.)(arcgis\.com|arcgisonline\.com|esri\.com|openstreetmap\.org)$/;

/** Install before importing any production component. No fallback to the real API. */
export function installIsolation() {
  const local = memoryStorage(), session = memoryStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session });
  const fetchStatic = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/demo/__mock_api__/")) {
      try { const data = await mockDatabase.request(url.pathname.replace("/demo/__mock_api__", "") + url.search, init); return Response.json(data); }
      catch (error) { return Response.json({ detail: error instanceof Error ? error.message : "Demo request refused" }, { status: error instanceof MockRefusal ? error.status : 500 }); }
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const staticPath = url.origin === location.origin && (/^\/(demo\/)?assets\//.test(url.pathname) || /^\/(demo\/)?(eris-logo\.svg|measurement\/|distribution-icons\/)/.test(url.pathname));
    if ((method === "GET" || method === "HEAD") && (staticPath || PUBLIC_GIS.test(url.hostname) || url.protocol === "blob:" || url.protocol === "data:")) return fetchStatic(input, { ...init, credentials: staticPath ? "same-origin" : "omit" });
    throw new Error(`Network request blocked by demo isolation: ${url.pathname}`);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const target = new URL(String(url), location.href);
    const staticPath = target.origin === location.origin && /^\/(demo\/)?assets\//.test(target.pathname);
    if (method.toUpperCase() !== "GET" || (!staticPath && !PUBLIC_GIS.test(target.hostname))) throw new Error("Live requests are unavailable in the demo.");
    return Reflect.apply(open, this, [method, url, ...rest]);
  };
  const reset = () => { mockDatabase.reset(); local.clear(); session.clear(); };
  window.addEventListener("pagehide", reset);
  window.addEventListener("pageshow", (event) => { if (event.persisted) { reset(); window.dispatchEvent(new Event("eris-demo-exit")); } });
  if (import.meta.env.PROD) {
    // This read-only gateway probe returns no live identity or business records.
    // Expired/revoked sessions clear an already-open demo as well as blocking new assets.
    window.setInterval(async () => {
      try {
        const response = await fetchStatic("/demo/healthz", { credentials: "same-origin", cache: "no-store", redirect: "manual" });
        if (response.ok && (await response.text()).trim() === "ok") return;
      } catch { /* No authenticated gateway response: close the temporary world. */ }
      reset(); window.dispatchEvent(new Event("eris-demo-exit")); window.location.replace("/login?demo=1");
    }, 60000);
  }
}
