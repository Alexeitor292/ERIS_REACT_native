// Pure, dependency-free construction policy for the OPTIONAL online Caltrans context layer.
// Kept out of the map component (and free of @arcgis/core imports) so the opt-in behaviour is
// unit-testable under `node --test`.
//
// Truthful scope: the Caltrans CRS Functional Classification service publishes FUNCTIONAL
// CLASSIFICATION — how a road functions in the network — NOT ownership or jurisdiction. It does
// not establish that a feature is Caltrans-owned or a State Route, and no F_System subset is
// "the state highway system". It is live road CONTEXT, not survey/engineering-grade centerline.
//
// This overlay is completely independent of whether a downloaded offline package contains
// packaged roads; it is never used to decide that.

/** Freeway/expressway functional classes only: 1 Interstate, 2 Other Freeways and Expressways. */
export const CALTRANS_DEFINITION_EXPRESSION = "F_System IN (1, 2)";

export const CALTRANS_LAYER_TITLE = "Caltrans Freeways & Expressways";

/**
 * TRUSTED, built-in attribution. ERIS always shows its own expected Caltrans credit and never
 * renders upstream service text, so a missing/changed/malformed upstream copyright field can
 * neither drop the credit nor inject arbitrary UI content. ERIS does not own or author the data.
 */
export const CALTRANS_ATTRIBUTION =
  "Road geometry © California Department of Transportation (Caltrans), CRS Functional Classification / Linear Reference System-derived data";

export const CALTRANS_OUT_FIELDS = [
  "OBJECTID",
  "EventID",
  "RouteID",
  "F_System",
  "County_label",
  "Caltrans_District",
] as const;

export type CaltransLayerConfig = {
  url: string;
  title: string;
  /** Off until the operator toggles it on in the Layers widget. */
  visible: false;
  definitionExpression: string;
  outFields: string[];
  copyright: string;
  renderer: unknown;
  popupTemplate: unknown;
};

/**
 * The FeatureLayer properties for the optional Caltrans overlay, or `null` when no URL is
 * configured — in which case the caller must NOT construct a layer at all.
 *
 * Note on network behaviour: returning `null` is what guarantees no request is made. Once a
 * layer IS configured, `visible: false` keeps it from drawing, but the ArcGIS runtime may still
 * load service metadata when the layer is added to the map; ERIS does not claim zero network
 * access for a configured-but-hidden layer.
 */
export function caltransHighwaysLayerConfig(url: string | null | undefined): CaltransLayerConfig | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return {
    url: trimmed,
    title: CALTRANS_LAYER_TITLE,
    visible: false,
    definitionExpression: CALTRANS_DEFINITION_EXPRESSION,
    outFields: [...CALTRANS_OUT_FIELDS],
    copyright: CALTRANS_ATTRIBUTION,
    renderer: {
      type: "simple",
      symbol: { type: "simple-line", width: 2.4, color: [234, 88, 12, 0.92] },
    },
    popupTemplate: {
      title: "Caltrans CRS route {RouteID}",
      content:
        "Functional class {F_System} · County {County_label} · Caltrans District {Caltrans_District}" +
        "<br/><small>Source: Caltrans CRS Functional Classification (live). Functional classification only —" +
        " not an ownership record and not survey/engineering-grade.</small>",
    },
  };
}
