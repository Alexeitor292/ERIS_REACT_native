type AppConfig = {
  apiBaseUrl: string;
  tokenStorageKey: string;
  // Optional PUBLIC Caltrans CRS Functional Classification FeatureServer layer, offered as
  // an online "Caltrans Highways & Freeways" context toggle on the web map. This is a live,
  // streamed overlay and is completely independent of whether a downloaded offline package
  // contains packaged roads. Empty string disables the toggle. VITE_* is inlined at build
  // time and public — only a credential-free URL belongs here.
  caltransHighwaysUrl: string;
};

export const appConfig: AppConfig = {
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE ??
    "http://127.0.0.1:8000",
  tokenStorageKey: import.meta.env.VITE_AUTH_TOKEN_STORAGE_KEY ?? "eris_token",
  caltransHighwaysUrl:
    import.meta.env.VITE_CALTRANS_HIGHWAYS_URL ??
    "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0",
};
