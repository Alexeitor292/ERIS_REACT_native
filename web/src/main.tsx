import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { UiSettingsProvider } from "./ui/UiSettingsContext";
import "@arcgis/core/assets/esri/themes/light/main.css";
import { reloadForNewRelease } from "./staleRelease";

// A file of this release is gone (the server was updated): load the current release.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewRelease()) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UiSettingsProvider>
      <App />
    </UiSettingsProvider>
  </React.StrictMode>
);
