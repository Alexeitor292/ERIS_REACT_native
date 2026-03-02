import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
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
type GeometryResp = { submission_id: number; geometry: Geo | string | null };

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

function normalizeGeometryValue(value: Geo | string | null | undefined): Geo {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Geo) : null;
    } catch {
      return null;
    }
  }
  return value;
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
  const launchInFlight = useRef(false);

  const launchNativeMap = useCallback(async () => {
    if (launchInFlight.current) return;
    launchInFlight.current = true;
    setError(null);
    try {
      console.log("[ArcGisDebug] launchNativeMap:start", { submissionId, latitude, longitude });
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

      const bridge = await getArcGisBridge();
      if (!bridge?.isArcGisNativeAvailable?.()) {
        throw new Error("ArcGIS native module unavailable in this build.");
      }
      if (bridge.clearSketch) {
        console.log("[ArcGisDebug] clearSketch:before-open");
        await bridge.clearSketch().catch(() => {});
      }

      const [me, sub, geomRes] = await Promise.all([
        apiFetch<Me>("/auth/me", { token: t }),
        getSubmission(t, submissionId) as Promise<Sub>,
        apiFetch<GeometryResp>(`/submissions/${submissionId}/geometry`, { token: t }).catch(() => null),
      ]);
      const roles = new Set(me.roles ?? []);
      const editable = (roles.has("FIELD_WORKER") || roles.has("ADMIN")) && sub.submission.status === "DRAFT";
      console.log("[ArcGisDebug] launchNativeMap:auth-status", {
        editable,
        status: sub.submission.status,
        roles: Array.from(roles),
      });
      if (!editable) {
        throw new Error("Only DRAFT submissions can be edited.");
      }

      const existingGeometry =
        normalizeGeometryValue(geomRes?.geometry) ??
        normalizeGeometryValue(sub.gisa?.geometry_json) ??
        null;
      console.log("[ArcGisDebug] launchNativeMap:existing-geometry", {
        hasGeometry: !!existingGeometry,
        type: (existingGeometry as any)?.type ?? null,
      });
      const seed = getSeedCoordinates(existingGeometry, latitude, longitude);
      if (seed && bridge.setInitialLocation) {
        await bridge.setInitialLocation(seed.lat, seed.lon);
      }
      const esriJson = geoJsonToEsriJsonString(existingGeometry);
      if (esriJson && bridge.setInitialGeometry) {
        await bridge.setInitialGeometry(esriJson);
      }

      setStatusText("ArcGIS opened. Draw and save there.");
      console.log("[ArcGisDebug] startSketchPolygon:open");
      await bridge.startSketchPolygon();
      console.log("[ArcGisDebug] startSketchPolygon:closed");
      setStatusText("Reading sketch...");
      const geom = await bridge.getSketchGeometry();
      console.log("[ArcGisDebug] getSketchGeometry:result", {
        hasGeom: !!geom,
        type: geom?.type ?? null,
      });
      if (!geom) {
        throw new Error("No sketch geometry found. Draw and save a sketch first.");
      }

      setStatusText("Saving sketch...");
      console.log("[ArcGisDebug] patchSubmission:start");
      await patchSubmission(t, submissionId, { geometry_json: geom });
      console.log("[ArcGisDebug] patchSubmission:done");
      const verify = await apiFetch<GeometryResp>(`/submissions/${submissionId}/geometry`, { token: t }).catch(() => null);
      const verifiedGeom = normalizeGeometryValue(verify?.geometry);
      console.log("[ArcGisDebug] verifyGeometry", {
        hasVerifiedGeom: !!verifiedGeom,
        type: (verifiedGeom as any)?.type ?? null,
      });
      if (!verifiedGeom) {
        throw new Error("Sketch save could not be verified on the server. Please try again.");
      }

      if (bridge.clearSketch) {
        await bridge.clearSketch().catch(() => {});
      }
      Alert.alert("Saved", "Geometry updated on this submission.");
      router.back();
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      const msg = String(e?.message ?? e);
      console.log("[ArcGisDebug] launchNativeMap:error", { message: msg, raw: e });
      setError(msg);
      setStatusText("Sketch not saved.");
    } finally {
      setBusy(false);
      launchInFlight.current = false;
    }
  }, [submissionId, latitude, longitude]);

  useEffect(() => {
    launchNativeMap().catch(() => {});
  }, [launchNativeMap]);

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
