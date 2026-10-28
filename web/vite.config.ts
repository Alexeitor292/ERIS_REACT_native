import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig(({ mode }) => ({
  // Development matches production: the browser talks to one origin and /api is
  // forwarded to the API, so the HttpOnly SameSite=Strict session cookie works.
  server: {
    proxy: {
      "/api": {
        target: loadEnv(mode, process.cwd(), "VITE_").VITE_DEV_API_TARGET || "http://127.0.0.1:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@arcgis/core/assets",
          dest: "",
        },
      ],
    }),
  ],
}));
