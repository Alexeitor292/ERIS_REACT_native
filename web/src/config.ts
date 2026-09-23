type AppConfig = {
  apiBaseUrl: string;
  tokenStorageKey: string;
  // Optional PUBLIC Caltrans CRS Functional Classification FeatureServer layer, offered as
  // an online "Caltrans Freeways & Expressways" context toggle on the web map. It is a
  // FUNCTIONAL CLASSIFICATION, not an ownership dataset. This is a live, streamed overlay
  // and is completely independent of whether a downloaded offline package contains packaged
  // roads. Empty string disables the toggle. VITE_* is inlined at build time and public —
  // only a credential-free URL belongs here.
  caltransHighwaysUrl: string;
  // The public Caltrans SHN Postmiles Tenth layer the incident form queries to turn a
  // point into District / County / Route / Post mile and back — the same layer, and the
  // same rules, as the mobile app's online lookup. Defaults to the public service.
  caltransPostmileLayerUrl: string;
  // OPTIONAL Google Maps Embed API key. With it the incident form's map can show Street
  // View inside the page; without it Street View opens in a new tab. Public in the
  // bundle, so it must be restricted to this site's domain in the Google Cloud console.
  googleMapsEmbedKey: string;
};

export const appConfig: AppConfig = {
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE ??
    "http://127.0.0.1:8000",
  tokenStorageKey: import.meta.env.VITE_AUTH_TOKEN_STORAGE_KEY ?? "eris_token",
  // OPT-IN: empty by default. A deployment that does not configure the variable gets NO
  // Caltrans layer at all (the FeatureLayer is not constructed), so it makes no request to
  // the public service. See web/.env.example for the URL to opt in with.
  caltransHighwaysUrl: import.meta.env.VITE_CALTRANS_HIGHWAYS_URL ?? "",
  caltransPostmileLayerUrl:
    import.meta.env.VITE_CALTRANS_POSTMILE_LAYER_URL?.trim()
    || "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0",
  googleMapsEmbedKey: import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? "",
};
