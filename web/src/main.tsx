import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { UiSettingsProvider } from "./ui/UiSettingsContext";
import "@arcgis/core/assets/esri/themes/light/main.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UiSettingsProvider>
      <App />
    </UiSettingsProvider>
  </React.StrictMode>
);
