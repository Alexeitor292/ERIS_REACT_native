import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";

import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getToken } from "../../../src/auth/tokenStore";
import { getSubmission, patchSubmission } from "../../../src/api/submissions";

type Geo = Record<string, unknown> | null;
type Me = { id: number; roles: string[] };
type Sub = { submission: { status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" }; gisa: { geometry_json?: Geo } | null };

async function getArcGisBridge() {
  try {
    return await import("../../../src/arcgis/ArcGISNative");
  } catch {
    return null;
  }
}

function toPretty(v: unknown) {
  return v ? JSON.stringify(v, null, 2) : "";
}

const isPlayServicesUnavailableError = (msg: string) =>
  /LocationServices\.API is not available|SERVICE_INVALID|Google Play services/i.test(msg);

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
    // Backend currently requires this non-null.
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

function getSeedCoordinates(
  geometryJson: string,
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
    const parsed = geometryJson.trim() ? JSON.parse(geometryJson) : null;
    if (parsed?.type === "Point" && Array.isArray(parsed.coordinates) && parsed.coordinates.length >= 2) {
      const lon = Number(parsed.coordinates[0]);
      const lat = Number(parsed.coordinates[1]);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
          return webMercatorToWgs84(lon, lat);
        }
        return { lat, lon };
      }
    }
  } catch {}

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon };
  return null;
}

function geoJsonToEsriJsonString(geometryJson: string): string | null {
  try {
    const g = geometryJson.trim() ? JSON.parse(geometryJson) : null;
    if (!g || typeof g !== "object") return null;
    const t = String(g.type || "").toLowerCase();
    const first = Array.isArray(g.coordinates) ? JSON.stringify(g.coordinates).match(/-?\d+(\.\d+)?/g) : null;
    const sampleX = first?.[0] ? Number(first[0]) : 0;
    const sampleY = first?.[1] ? Number(first[1]) : 0;
    const wkid =
      !Number.isNaN(sampleX) && !Number.isNaN(sampleY) && (Math.abs(sampleX) > 180 || Math.abs(sampleY) > 90)
        ? 3857
        : 4326;
    if (t === "point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return JSON.stringify({ x: Number(g.coordinates[0]), y: Number(g.coordinates[1]), spatialReference: { wkid } });
    }
    if (t === "linestring" && Array.isArray(g.coordinates)) {
      return JSON.stringify({ paths: [g.coordinates], spatialReference: { wkid } });
    }
    if (t === "multilinestring" && Array.isArray(g.coordinates)) {
      return JSON.stringify({ paths: g.coordinates, spatialReference: { wkid } });
    }
    if (t === "polygon" && Array.isArray(g.coordinates)) {
      return JSON.stringify({ rings: g.coordinates, spatialReference: { wkid } });
    }
    if (t === "multipolygon" && Array.isArray(g.coordinates)) {
      const rings: any[] = [];
      g.coordinates.forEach((poly: any) => {
        if (Array.isArray(poly)) poly.forEach((ring: any) => rings.push(ring));
      });
      return JSON.stringify({ rings, spatialReference: { wkid } });
    }
    return null;
  } catch {
    return null;
  }
}

export default function MapScreen() {
  const { id, latitude, longitude } = useLocalSearchParams<{
    id?: string;
    latitude?: string;
    longitude?: string;
  }>();
  const submissionId = useMemo(() => String(id ?? "").trim(), [id]);
  const [token, setToken] = useState<string | null>(null);
  const [geometryJson, setGeometryJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [baseGisa, setBaseGisa] = useState<any>(null);
  const [arcGisNativeAvailable, setArcGisNativeAvailable] = useState(false);
  const [locationStatus, setLocationStatus] = useState("");

  const load = useCallback(async (authToken: string, sid: string) => {
    setBusy(true);
    try {
      const [me, sub] = await Promise.all([
        apiFetch<Me>("/auth/me", { token: authToken }),
        getSubmission(authToken, sid) as Promise<Sub>,
      ]);
      const roles = new Set(me.roles ?? []);
      const editableRole = roles.has("FIELD_WORKER") || roles.has("ADMIN");
      setCanEdit(editableRole && sub.submission.status === "DRAFT");
      setBaseGisa(sub.gisa ?? {});
      const savedGeometry = sub.gisa?.geometry_json ?? null;
      if (savedGeometry) {
        setGeometryJson(toPretty(savedGeometry));
        return;
      }

      const latNum = Number(latitude);
      const lonNum = Number(longitude);
      if (!Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
        setGeometryJson(
          JSON.stringify(
            {
              type: "Point",
              coordinates: [lonNum, latNum],
            },
            null,
            2
          )
        );
        setLocationStatus(
          `Seeded from submission lat/lon: ${latNum.toFixed(6)}, ${lonNum.toFixed(6)}`
        );
      } else {
        setGeometryJson("");
      }
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      Alert.alert("Map load failed", e?.message ?? "Unable to load submission.");
    } finally {
      setBusy(false);
    }
  }, [latitude, longitude]);

  useEffect(() => {
    (async () => {
      if (!submissionId) {
        Alert.alert("Missing submission id", "Please open map from a submission.");
        router.back();
        return;
      }
      const t = await getToken();
      if (!t) {
        Alert.alert("Not logged in", "Please log in again.");
        router.replace("/(auth)/login");
        return;
      }
      setToken(t);
      await load(t, submissionId);

      const bridge = await getArcGisBridge();
      setArcGisNativeAvailable(Boolean(bridge?.isArcGisNativeAvailable?.()));
    })().catch(() => {
      Alert.alert("Map load failed", "Please try again.");
    });
  }, [submissionId, load]);

  async function saveGeometry() {
    if (!token || !submissionId) return;
    setBusy(true);
    try {
      const parsed = geometryJson.trim() ? JSON.parse(geometryJson) : null;
      if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("Geometry must be a GeoJSON object.");
      }
      await patchSubmission(token, submissionId, buildGisaPatch(baseGisa, parsed));
      Alert.alert("Saved", "Geometry updated on this submission.");
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      Alert.alert("Save failed", e?.message ?? "Unable to save geometry.");
    } finally {
      setBusy(false);
    }
  }

  async function useCurrentPoint() {
    setLocationStatus("Requesting location...");
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setLocationStatus("Location permission denied.");
        Alert.alert("Permission denied", "Location permission is required.");
        return;
      }

      let playServicesUnavailable = false;
      if (Platform.OS === "android") {
        try {
          await Location.enableNetworkProviderAsync();
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (isPlayServicesUnavailableError(msg)) {
            playServicesUnavailable = true;
          }
        }
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setLocationStatus("Location services are disabled.");
        Alert.alert(
          "Location disabled",
          "Turn on device/emulator location services, then try again."
        );
        return;
      }

      const applyPoint = (lat: number, lon: number, label: string) => {
        setGeometryJson(
          JSON.stringify(
            {
              type: "Point",
              coordinates: [lon, lat],
            },
            null,
            2
          )
        );
        setLocationStatus(`${label}: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
      };

      let usedImmediate = false;
      let loc = await Location.getLastKnownPositionAsync({
        maxAge: 1000 * 60 * 60 * 24,
      });
      if (loc) {
        applyPoint(loc.coords.latitude, loc.coords.longitude, "Using last known point");
        usedImmediate = true;
      }

      if (playServicesUnavailable && !usedImmediate) {
        setLocationStatus("Location unavailable on this emulator image.");
        Alert.alert(
          "Location unavailable on this emulator",
          "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
        );
        return;
      }

      // Attempt a fresh fix in the background; if not available quickly, keep immediate result.
      let fresh: Location.LocationObject | null = null;
      if (!playServicesUnavailable) {
        const fromCurrent = await Promise.race([
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            mayShowUserSettingsDialog: true,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (fromCurrent) {
          fresh = fromCurrent;
        } else {
          await new Promise<void>((resolve) => {
            let done = false;
            let subscription: Location.LocationSubscription | null = null;
            const finish = (next?: Location.LocationObject | null) => {
              if (done) return;
              done = true;
              if (subscription) subscription.remove();
              if (next) fresh = next;
              resolve();
            };
            Location.watchPositionAsync(
              {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: 1000,
                distanceInterval: 0,
              },
              (next) => finish(next)
            )
              .then((sub) => {
                subscription = sub;
                setTimeout(() => finish(null), 15000);
              })
              .catch(() => finish(null));
          });
        }
      }

      if (fresh) {
        applyPoint(fresh.coords.latitude, fresh.coords.longitude, "Current point");
        Alert.alert("Location captured", "GeoJSON Point has been inserted in the editor.");
        return;
      }

      if (usedImmediate) {
        Alert.alert("Location captured", "Using recent location. GPS refresh is still pending.");
        return;
      }

      if (!loc) {
        if (playServicesUnavailable) {
          setLocationStatus("Location unavailable on this emulator image.");
          Alert.alert(
            "Location unavailable on this emulator",
            "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
          );
          return;
        }
        setLocationStatus("No current location available.");
        Alert.alert(
          "Location unavailable",
          "Could not get current position. In Android emulator, open Extended controls > Location and send a point."
        );
        return;
      }
      applyPoint(loc.coords.latitude, loc.coords.longitude, "Point set");
      Alert.alert("Location captured", "GeoJSON Point has been inserted in the editor.");
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Unable to read location.");
      if (isPlayServicesUnavailableError(msg)) {
        setLocationStatus("Location unavailable on this emulator image.");
        Alert.alert(
          "Location unavailable on this emulator",
          "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
        );
        return;
      }
      setLocationStatus("Location request failed.");
      Alert.alert("Location failed", msg);
    }
  }

  async function startNativeSketch() {
    if (!arcGisNativeAvailable) {
      Alert.alert(
        "ArcGIS native module unavailable",
        "Native ArcGIS is not linked in this build. Rebuild the Android dev client with `npx expo run:android`, then reopen this screen."
      );
      return;
    }
    const bridge = await getArcGisBridge();
    if (!bridge?.startSketchPolygon) {
      Alert.alert(
        "ArcGIS native module unavailable",
        "Rebuild the Android dev client with `npx expo run:android` and try again."
      );
      return;
    }
    try {
      const seed = getSeedCoordinates(geometryJson, latitude, longitude);
      if (seed && bridge?.setInitialLocation) {
        await bridge.setInitialLocation(seed.lat, seed.lon);
      }
      const esriJson = geoJsonToEsriJsonString(geometryJson);
      if (esriJson && bridge?.setInitialGeometry) {
        await bridge.setInitialGeometry(esriJson);
      }
      await bridge.startSketchPolygon();
      Alert.alert("Sketch mode started", "Draw a polygon in the ArcGIS native view.");
    } catch (e: any) {
      Alert.alert("Sketch failed", e?.message ?? "Could not start polygon sketch.");
    }
  }

  async function pullNativeSketch() {
    if (!arcGisNativeAvailable) {
      Alert.alert("ArcGIS native module unavailable", "Native sketch is not available in this build.");
      return;
    }
    const bridge = await getArcGisBridge();
    if (!bridge?.getSketchGeometry) {
      Alert.alert("ArcGIS native module unavailable", "No native sketch is available.");
      return;
    }
    try {
      const geom = await bridge.getSketchGeometry();
      setGeometryJson(toPretty(geom));
    } catch (e: any) {
      Alert.alert("Read sketch failed", e?.message ?? "Could not read sketch geometry.");
    }
  }

  async function clearNativeSketch() {
    const bridge = await getArcGisBridge();
    if (!bridge?.clearSketch) return;
    try {
      await bridge.clearSketch();
    } catch {}
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>ArcGIS Geometry Editor</Text>
      <Text style={styles.sub}>Submission #{submissionId || "?"}</Text>
      <Text style={styles.note}>
        Save GeoJSON here and the same geometry is visible in web ArcGIS view.
      </Text>
      <Text style={styles.note}>
        ArcGIS native sketch: {arcGisNativeAvailable ? "available" : "not available in this build"}
      </Text>
      {!!locationStatus ? <Text style={styles.note}>{locationStatus}</Text> : null}

      <View style={styles.row}>
        <Pressable style={[styles.ghost, (!arcGisNativeAvailable || busy || !canEdit) && styles.ghostDisabled]} onPress={startNativeSketch} disabled={busy || !canEdit || !arcGisNativeAvailable}>
          <Text style={styles.ghostText}>Start Polygon Sketch</Text>
        </Pressable>
        <Pressable style={[styles.ghost, (!arcGisNativeAvailable || busy || !canEdit) && styles.ghostDisabled]} onPress={pullNativeSketch} disabled={busy || !canEdit || !arcGisNativeAvailable}>
          <Text style={styles.ghostText}>Use Native Sketch</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable style={styles.ghost} onPress={useCurrentPoint} disabled={busy || !canEdit}>
          <Text style={styles.ghostText}>Use Current Point</Text>
        </Pressable>
        <Pressable style={styles.ghost} onPress={() => setGeometryJson("")} disabled={busy || !canEdit}>
          <Text style={styles.ghostText}>Clear JSON</Text>
        </Pressable>
      </View>

      <TextInput
        value={geometryJson}
        onChangeText={setGeometryJson}
        style={styles.input}
        multiline
        editable={canEdit}
        placeholder='{"type":"Point","coordinates":[-122.084000,37.421998]}'
        placeholderTextColor="#6b7280"
      />

      {!canEdit ? (
        <Text style={styles.warn}>Only DRAFT submissions can be edited by FIELD_WORKER/ADMIN.</Text>
      ) : null}

      <Pressable style={styles.primary} onPress={saveGeometry} disabled={busy || !canEdit}>
        <Text style={styles.primaryText}>{busy ? "Working..." : "Save Geometry"}</Text>
      </Pressable>

      <Pressable
        style={[styles.ghost, { marginTop: 10 }]}
        onPress={async () => {
          await clearNativeSketch();
          router.back();
        }}
      >
        <Text style={styles.ghostText}>Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14, gap: 10, backgroundColor: "#f2f6fc", flexGrow: 1 },
  title: { fontSize: 20, fontWeight: "800", color: "#0f172a" },
  sub: { color: "#334155", fontWeight: "700" },
  note: { color: "#475569", fontSize: 12 },
  warn: { color: "#9a3412", fontSize: 12, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8 },
  input: {
    minHeight: 260,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#fff",
    textAlignVertical: "top",
    color: "#0f172a",
    fontFamily: "monospace",
  },
  primary: { backgroundColor: "#1d4ed8", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  ghost: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  ghostDisabled: {
    opacity: 0.55,
  },
  ghostText: { color: "#1e293b", fontWeight: "700" },
});
