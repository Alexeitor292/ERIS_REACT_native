import React from "react";
import ReactDOM from "react-dom/client";
import { installIsolation } from "./realPages/isolation";
import "../../index.css";
import "@arcgis/core/assets/esri/themes/light/main.css";

installIsolation();
const { default: DemoApp } = await import("./realPages/RealPagesDemo");
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><DemoApp /></React.StrictMode>);
