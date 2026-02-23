import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getToken } from "../../../src/auth/tokenStore";
import { getSubmission, patchSubmission } from "../../../src/api/submissions";
import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { useUiSettings } from "../../../src/ui/UiSettingsContext";

type Geo = Record<string, unknown> | null;
type Me = { id: number; roles: string[] };
type Sub = {
  submission: { status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" };
  gisa: { geometry_json?: Geo } | null;
};

async function getArcGisBridge() {
  try {
    return await import("../../../src/arcgis/ArcGISNative");
  } catch {
    return null;
  }
}

function getSeedCoordinates(
  geometryJson: Geo,
  latitude?: string,
  longitude?: string
): { lat: number; lon: number } | null {
  const webMercatorToWgs84 = (x: number, y: number) => {
    const lon = (x / 20037508.34) * 180;
    let lat = (y / 20037508.34) * 180;
    lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
    return { lat, lon };
  };

  try {
    if (geometryJson?.type === "Point" && Array.isArray((geometryJson as any).coordinates)) {
      const coords = (geometryJson as any).coordinates;
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return webMercatorToWgs84(lon, lat);
        return { lat, lon };
      }
    }
  } catch {}

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon };
  return null;
}

function geoJsonToEsriJsonString(geometryJson: Geo): string | null {
  try {
    const g = geometryJson;
    if (!g || typeof g !== "object") return null;
    const t = String((g as any).type || "").toLowerCase();
    const c = (g as any).coordinates;
    const first = Array.isArray(c) ? JSON.stringify(c).match(/-?\d+(\.\d+)?/g) : null;
    const sampleX = first?.[0] ? Number(first[0]) : 0;
    const sampleY = first?.[1] ? Number(first[1]) : 0;
    const wkid =
      !Number.isNaN(sampleX) && !Number.isNaN(sampleY) && (Math.abs(sampleX) > 180 || Math.abs(sampleY) > 90)
        ? 3857
        : 4326;
    if (t === "point" && Array.isArray(c) && c.length >= 2) {
      return JSON.stringify({ x: Number(c[0]), y: Number(c[1]), spatialReference: { wkid } });
    }
    if (t === "linestring" && Array.isArray(c)) {
      return JSON.stringify({ paths: [c], spatialReference: { wkid } });
    }
    if (t === "multilinestring" && Array.isArray(c)) {
      return JSON.stringify({ paths: c, spatialReference: { wkid } });
    }
    if (t === "polygon" && Array.isArray(c)) {
      return JSON.stringify({ rings: c, spatialReference: { wkid } });
    }
    if (t === "multipolygon" && Array.isArray(c)) {
      const rings: any[] = [];
      c.forEach((poly: any) => {
        if (Array.isArray(poly)) poly.forEach((ring: any) => rings.push(ring));
      });
      return JSON.stringify({ rings, spatialReference: { wkid } });
    }
    return null;
  } catch {
    return null;
  }
}

function buildGisaPatch(existing: any, geometryJson: any) {
  const g = existing ?? {};
  return {
    report_date: g.report_date ?? null,
    district: g.district ?? null,
    county: g.county ?? null,
    route: g.route ?? null,
    post_mile: g.post_mile ?? null,
    ea: g.ea ?? null,
    project_id: g.project_id ?? null,
    date_incident_reported: g.date_incident_reported ?? null,
    district_contact: g.district_contact ?? null,
    latitude: g.latitude ?? null,
    longitude: g.longitude ?? null,
    distribution_code: g.distribution_code ?? null,
    highway_status_code: g.highway_status_code ?? null,
    lanes_closed_count: g.lanes_closed_count ?? null,
    pavement_ground_cracks: g.pavement_ground_cracks ?? false,
    crack_length_ft: g.crack_length_ft ?? null,
    crack_horizontal_in: g.crack_horizontal_in ?? null,
    crack_vertical_in: g.crack_vertical_in ?? null,
    crack_depth_in: g.crack_depth_in ?? null,
    settlement_in: g.settlement_in ?? null,
    bulge_in: g.bulge_in ?? null,
    indented_by_rocks: g.indented_by_rocks ?? false,
    observations_notes: g.observations_notes ?? null,
    geometry_json: geometryJson,
  };
}

export default function MapScreen() {
  const { palette } = useUiSettings();
  const { id, latitude, longitude } = useLocalSearchParams<{
    id?: string;
    latitude?: string;
    longitude?: string;
  }>();

  const submissionId = useMemo(() => String(id ?? "").trim(), [id]);
  const [statusText, setStatusText] = useState("Opening ArcGIS map...");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [baseGisa, setBaseGisa] = useState<any>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [launched, setLaunched] = useState(false);
  const launchInFlight = useRef(false);

  const launchNativeMap = useCallback(async () => {
    if (launchInFlight.current) return;
    launchInFlight.current = true;
    setError(null);
    try {
      if (!submissionId) {
        Alert.alert("Missing submission id", "Please open map from a submission.");
        router.back();
        return;
      }
      const t = await getToken();
      if (!t) {
        router.replace("/(auth)/login");
        return;
      }
      setToken(t);

      const bridge = await getArcGisBridge();
      if (!bridge?.isArcGisNativeAvailable?.()) {
        throw new Error("ArcGIS native module unavailable in this build.");
      }

      const [me, sub] = await Promise.all([
        apiFetch<Me>("/auth/me", { token: t }),
        getSubmission(t, submissionId) as Promise<Sub>,
      ]);
      const roles = new Set(me.roles ?? []);
      const editable = (roles.has("FIELD_WORKER") || roles.has("ADMIN")) && sub.submission.status === "DRAFT";
      setCanEdit(editable);
      setBaseGisa(sub.gisa ?? {});
      if (!editable) {
        throw new Error("Only DRAFT submissions can be edited.");
      }

      const existingGeometry = sub.gisa?.geometry_json ?? null;
      const seed = getSeedCoordinates(existingGeometry, latitude, longitude);
      if (seed && bridge.setInitialLocation) {
        await bridge.setInitialLocation(seed.lat, seed.lon);
      }
      const esriJson = geoJsonToEsriJsonString(existingGeometry);
      if (esriJson && bridge.setInitialGeometry) {
        await bridge.setInitialGeometry(esriJson);
      }

      setStatusText("ArcGIS opened. Draw and save there.");
      await bridge.startSketchPolygon();
      setLaunched(true);
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      const msg = String(e?.message ?? e);
      setError(msg);
      setStatusText("Could not open ArcGIS.");
    } finally {
      setBusy(false);
      launchInFlight.current = false;
    }
  }, [submissionId, latitude, longitude]);

  useEffect(() => {
    launchNativeMap().catch(() => {});
  }, [launchNativeMap]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (!launched || !token || !submissionId || !canEdit) return;
        try {
          const bridge = await getArcGisBridge();
          if (!bridge?.getSketchGeometry) return;
          const geom = await bridge.getSketchGeometry();
          if (cancelled || !geom) return;
          await patchSubmission(token, submissionId, buildGisaPatch(baseGisa, geom));
          if (cancelled) return;
          Alert.alert("Saved", "Geometry updated on this submission.");
          router.back();
        } catch {
          // If user exits map without saving sketch, stay on this page.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [launched, token, submissionId, canEdit, baseGisa])
  );

  return (
    <View style={[styles.container, { backgroundColor: palette.bg }]}>
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
        <View style={[styles.centerCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <ActivityIndicator size="large" color={palette.primary} />
          <Text style={[styles.title, { color: palette.text }]}>{statusText}</Text>
          {!!error ? <Text style={[styles.error, { color: "#f87171" }]}>{error}</Text> : null}
          {!busy ? (
            <Pressable style={[styles.retryBtn, { backgroundColor: palette.primary }]} onPress={launchNativeMap}>
              <Text style={styles.retryText}>Open ArcGIS Map</Text>
            </Pressable>
          ) : null}
          <Pressable style={[styles.backBtn, { borderColor: palette.border }]} onPress={() => router.back()}>
            <Text style={[styles.backText, { color: palette.text }]}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  centerCard: {
    margin: 16,
    borderRadius: 14,
    borderWidth: 1,
    padding: 18,
    alignItems: "center",
    gap: 12,
  },
  title: { fontSize: 16, fontWeight: "700", textAlign: "center" },
  error: { fontSize: 12, textAlign: "center" },
  retryBtn: {
    width: "100%",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  retryText: { color: "#fff", fontWeight: "800" },
  backBtn: {
    width: "100%",
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 11,
    alignItems: "center",
  },
  backText: { fontWeight: "700" },
});
