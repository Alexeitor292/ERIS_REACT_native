/**
 * Native offline 3D terrain — primary mobile field experience.
 *
 * Downloads a bounded (incident-radius) Mobile Scene Package (.mspk) and opens
 * it in the native AGSSceneView for fully-offline immersive 3D terrain. Falls
 * back gracefully when the native module isn't in the build (needs an EAS dev
 * build) or no package host is configured server-side.
 *
 * The USGS sampled-relief card and the WebUI browser handoff remain available
 * separately; this panel is the native, offline-first path.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";

import type { GisaTerrainGrid } from "../api/submissions";
import { getOfflineScenePackageDescriptor } from "../api/submissions";
import { getToken } from "../auth/tokenStore";
import {
  describeScope,
  formatBytes,
  formatPackageAge,
  needsRefresh,
  type OfflineScenePackageMeta,
  type SceneAreaDescriptor,
} from "../arcgis/offlineScene";
import { supportsOfflineTerrainScene } from "../arcgis/ArcGISNative";
import {
  deleteOfflineScenePackage,
  downloadOfflineSceneArea,
  getOfflineScenePackage,
  openDownloadedScene,
  pauseDownload,
} from "../offline/offlineScenePackages";

type Props = {
  submissionId: number;
  incidentId: number | null;
  latitude: number | null;
  longitude: number | null;
  geometry?: Record<string, unknown> | null;
  terrain?: GisaTerrainGrid | null;
  incidentLabel?: string | null;
  isLocalId?: boolean;
};

function sampleExtentFromTerrain(terrain?: GisaTerrainGrid | null) {
  const pts = terrain?.grid?.points;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, minLon, maxLat, maxLon };
}

export function OfflineTerrainPanel({
  submissionId,
  incidentId,
  latitude,
  longitude,
  geometry = null,
  terrain = null,
  incidentLabel = null,
  isLocalId = false,
}: Props) {
  const [meta, setMeta] = useState<OfflineScenePackageMeta | null>(null);
  const [descriptor, setDescriptor] = useState<SceneAreaDescriptor | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nativeSupported = supportsOfflineTerrainScene();
  const hasCoords = typeof latitude === "number" && typeof longitude === "number";

  const reloadMeta = useCallback(async () => {
    try {
      setMeta(await getOfflineScenePackage(submissionId));
    } catch {
      /* ignore */
    }
  }, [submissionId]);

  useEffect(() => {
    reloadMeta();
  }, [reloadMeta]);

  // Best-effort descriptor fetch (needs network; silently ignored offline).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isLocalId) return;
      try {
        const t = await getToken();
        if (!t || cancelled) return;
        const d = await getOfflineScenePackageDescriptor(t, String(submissionId));
        if (!cancelled) setDescriptor(d);
      } catch {
        /* offline or unavailable — keep null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId, isLocalId]);

  const refreshNeeded = useMemo(() => needsRefresh(meta, descriptor), [meta, descriptor]);

  const onDownload = useCallback(async () => {
    if (!descriptor || !descriptor.available) {
      Alert.alert(
        "Offline 3D unavailable",
        descriptor?.reason ?? "No offline 3D area is available for this incident yet.",
      );
      return;
    }
    setError(null);
    setBusy(true);
    setProgress(0);
    try {
      const result = await downloadOfflineSceneArea({
        descriptor,
        incidentId,
        onProgress: (p) => setProgress(p.fraction),
      });
      setMeta(result);
      if (result.status === "FAILED") setError(result.error ?? "Download failed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [descriptor, incidentId]);

  const onPause = useCallback(async () => {
    await pauseDownload(submissionId);
    await reloadMeta();
  }, [submissionId, reloadMeta]);

  const onOpen = useCallback(async () => {
    setError(null);
    try {
      await openDownloadedScene(submissionId, {
        incident: { lat: latitude as number, lon: longitude as number },
        incidentLabel,
        geometry,
        roadBearingDeg: terrain?.road_bearing_deg_used ?? null,
        sampleExtent: sampleExtentFromTerrain(terrain),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      Alert.alert("Cannot open 3D terrain", msg);
    }
  }, [submissionId, latitude, longitude, incidentLabel, geometry, terrain]);

  const onDelete = useCallback(() => {
    Alert.alert("Delete offline area", "Remove this downloaded 3D package from the device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteOfflineScenePackage(submissionId);
          await reloadMeta();
        },
      },
    ]);
  }, [submissionId, reloadMeta]);

  const ready = meta?.status === "READY";
  const downloading = meta?.status === "DOWNLOADING" || busy;

  return (
    <View style={styles.wrapper}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Native 3D terrain (offline)</Text>
        {ready ? <Text style={styles.badgeReady}>Downloaded</Text> : <Text style={styles.badgeMuted}>Not downloaded</Text>}
      </View>

      {!nativeSupported ? (
        <Text style={styles.note}>
          The native 3D viewer isn&apos;t in this app build. Install an EAS development build (see docs) to enable
          immersive offline 3D. You can still use the diagnostic card and the WebUI handoff below.
        </Text>
      ) : !hasCoords ? (
        <Text style={styles.note}>This incident has no coordinates, so an offline 3D area cannot be bounded.</Text>
      ) : null}

      {/* Open (primary) */}
      <Pressable
        onPress={onOpen}
        disabled={!nativeSupported || !ready || !hasCoords}
        accessibilityRole="button"
        style={[styles.btnPrimary, (!nativeSupported || !ready || !hasCoords) && styles.btnDisabled]}
      >
        <Text style={styles.btnPrimaryText}>Open native 3D terrain</Text>
      </Pressable>

      {/* Download / progress */}
      {!ready ? (
        downloading ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color="#93c5fd" />
            <Text style={styles.progressText}>
              Downloading {progress != null ? `${Math.round(progress * 100)}%` : "…"}
            </Text>
            <Pressable onPress={onPause} style={styles.btnSmall}>
              <Text style={styles.btnSmallText}>Pause</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={onDownload}
            disabled={!nativeSupported || !hasCoords || isLocalId}
            style={[styles.btnSecondary, (!nativeSupported || !hasCoords || isLocalId) && styles.btnDisabled]}
          >
            <Text style={styles.btnSecondaryText}>
              {descriptor?.available ? "Download offline 3D area" : "Check offline 3D availability"}
            </Text>
          </Pressable>
        )
      ) : null}

      {/* Scope / size estimate before download */}
      {!ready && descriptor?.available ? (
        <Text style={styles.scope}>Scope: {describeScope(descriptor)}</Text>
      ) : null}
      {!ready && descriptor && !descriptor.available ? (
        <Text style={styles.note}>{descriptor.reason}</Text>
      ) : null}

      {/* Status of a downloaded package */}
      {ready ? (
        <View style={styles.statusBox}>
          <Text style={styles.statusLine}>
            Version {meta?.packageVersion?.slice(0, 8) ?? "—"} · {formatBytes(meta?.sizeBytes)} ·{" "}
            {formatPackageAge(meta?.downloadedAt ?? null)}
          </Text>
          {refreshNeeded ? (
            <Text style={styles.refreshLine}>Incident data changed — an update is available. Re-download to refresh.</Text>
          ) : null}
          <View style={styles.row}>
            {refreshNeeded ? (
              <Pressable onPress={onDownload} style={styles.btnSmall}>
                <Text style={styles.btnSmallText}>Update</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onDelete} style={[styles.btnSmall, styles.btnDanger]}>
              <Text style={styles.btnSmallText}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { backgroundColor: "#0f172a", borderRadius: 8, padding: 10, marginBottom: 8 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { color: "#34d399", fontSize: 12, fontWeight: "700" },
  badgeReady: { color: "#0f172a", backgroundColor: "#34d399", fontSize: 9, fontWeight: "700", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden" },
  badgeMuted: { color: "#94a3b8", fontSize: 9, fontWeight: "600" },
  note: { color: "#94a3b8", fontSize: 10, marginBottom: 6, lineHeight: 14 },
  scope: { color: "#cbd5e1", fontSize: 10, marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  progressText: { color: "#cbd5e1", fontSize: 11, flex: 1 },
  btnPrimary: { backgroundColor: "#2563eb", borderRadius: 6, paddingVertical: 9, alignItems: "center", marginBottom: 6 },
  btnPrimaryText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  btnSecondary: { backgroundColor: "#1e293b", borderRadius: 6, paddingVertical: 8, alignItems: "center", borderWidth: 1, borderColor: "#334155" },
  btnSecondaryText: { color: "#e2e8f0", fontSize: 11, fontWeight: "600" },
  btnSmall: { backgroundColor: "#334155", borderRadius: 5, paddingHorizontal: 10, paddingVertical: 5 },
  btnSmallText: { color: "#e2e8f0", fontSize: 10, fontWeight: "600" },
  btnDanger: { backgroundColor: "#7f1d1d" },
  btnDisabled: { opacity: 0.4 },
  statusBox: { marginTop: 8, borderTopWidth: 1, borderTopColor: "#1e293b", paddingTop: 6 },
  statusLine: { color: "#cbd5e1", fontSize: 10 },
  refreshLine: { color: "#fbbf24", fontSize: 10, marginTop: 3 },
  errorText: { color: "#f87171", fontSize: 10, marginTop: 6 },
});
