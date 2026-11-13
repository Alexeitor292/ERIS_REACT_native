import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const replacements = new Map([
  ["api/client", "mockClient.ts"], ["auth/AuthContext", "MockAuthContext.tsx"],
  ["auth/token", "mockToken.ts"], ["features/incidents/caltransPostmileClient", "mockPostmile.ts"],
  ["features/submissions/sectionUpload", "mockSectionUpload.ts"],
].map(([source, target]) => [path.join(webRoot, "src", source).replaceAll("\\", "/"), path.join(webRoot, "src/features/demo/realPages", target)]));
// Compile the actual portal pages. Only the data, identity, and postmile service
// boundary are replaced; the production components and styles are unchanged.
export default defineConfig({
  root: "demo",
  publicDir: "../public",
  base: "/demo/",
  server: { fs: { allow: [webRoot] } },
  define: {
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/demo/__mock_api__"),
    "import.meta.env.VITE_GUIDED_DEMO_ENABLED": JSON.stringify("false"),
  },
  plugins: [{ name: "isolated-demo-services", enforce: "pre", transformIndexHtml: { order: "pre", handler(html, context) {
    return context.server ? html.replace('../src/features/demo/demo-entry.tsx', `/@fs/${path.join(webRoot, 'src/features/demo/demo-entry.tsx').replaceAll('\\', '/')}`) : html;
  } }, resolveId(source, importer) {
    if (!importer || !source.startsWith(".")) return null;
    const resolved = path.resolve(path.dirname(importer.split("?")[0]), source).replaceAll("\\", "/").replace(/\.(tsx?|jsx?)$/, "");
    return replacements.get(resolved) ?? null;
  }, transform(code, id) {
    if (id.replaceAll('\\', '/').includes('/web/src/')) return code.replace(/esriConfig\.assetsPath\s*=\s*["']\/assets["']/g, 'esriConfig.assetsPath = "/demo/assets"').replace(/(["'])\/(eris-logo\.svg|measurement\/|distribution-icons\/)/g, '$1/demo/$2');
    return null;
  } }, react(), tailwindcss(), viteStaticCopy({ targets: [{ src: path.join(webRoot, "node_modules/@arcgis/core/assets").replaceAll("\\", "/"), dest: "" }] })],
  build: { outDir: "../dist-demo", emptyOutDir: true },
});
