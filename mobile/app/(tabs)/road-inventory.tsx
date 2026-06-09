import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { useUiSettings } from "@/src/ui/UiSettingsContext";
import { getToken } from "@/src/auth/tokenStore";
import {
  clearLocalRoadInventoryPackage,
  getLocalRoadInventoryStatus,
  lookupLocalRoadSegments,
  syncRoadInventoryPackage,
  type LocalPackageMeta,
  type RoadSegment,
} from "@/src/services/roadInventoryOffline";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Status card
// ---------------------------------------------------------------------------

function StatusCard({
  meta,
  palette,
}: {
  meta: LocalPackageMeta;
  palette: ReturnType<typeof useUiSettings>["palette"];
}) {
  return (
    <View
      style={[
        styles.infoBlock,
        { backgroundColor: palette.panel, borderColor: palette.border },
      ]}
    >
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>Version</Text>
        <Text style={[styles.value, { color: palette.text }]}>
          {meta.version_tag}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>Segments</Text>
        <Text style={[styles.value, { color: palette.text }]}>
          {meta.row_count.toLocaleString()}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>Extract date</Text>
        <Text style={[styles.value, { color: palette.text }]}>
          {fmtDate(meta.extract_date)}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>Generated</Text>
        <Text style={[styles.value, { color: palette.text }]}>
          {fmtDateTime(meta.generated_at)}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>Synced</Text>
        <Text style={[styles.value, { color: palette.text }]}>
          {fmtDateTime(meta.synced_at)}
        </Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={[styles.label, { color: palette.muted }]}>SHA-256</Text>
        <Text style={[styles.valueMono, { color: palette.muted }]}>
          {meta.sha256.slice(0, 16)}…
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Lookup tester
// ---------------------------------------------------------------------------

function LookupTester({
  palette,
}: {
  palette: ReturnType<typeof useUiSettings>["palette"];
}) {
  const [county, setCounty] = useState("");
  const [route, setRoute] = useState("");
  const [postmile, setPostmile] = useState("");
  const [district, setDistrict] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<RoadSegment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleLookup() {
    const pm = parseFloat(postmile);
    if (!county.trim() || !route.trim() || isNaN(pm)) {
      setErr("County, route, and a numeric postmile are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const segs = await lookupLocalRoadSegments({
        countyCode: county.trim(),
        routeName: route.trim(),
        postmile: pm,
        districtCode: district.trim() || undefined,
      });
      setResults(segs);
    } catch (e: any) {
      setErr(e?.message ?? "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = [
    styles.input,
    { backgroundColor: palette.panelSoft, borderColor: palette.border, color: palette.text },
  ];

  return (
    <View>
      <Text style={[styles.sectionTitle, { color: palette.text }]}>
        Offline Lookup Tester
      </Text>

      <View style={styles.lookupRow}>
        <View style={styles.lookupField}>
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>County</Text>
          <TextInput
            value={county}
            onChangeText={setCounty}
            placeholder="SAC"
            placeholderTextColor={palette.muted}
            autoCapitalize="characters"
            maxLength={8}
            style={inputStyle}
          />
        </View>
        <View style={styles.lookupField}>
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>Route</Text>
          <TextInput
            value={route}
            onChangeText={setRoute}
            placeholder="50"
            placeholderTextColor={palette.muted}
            style={inputStyle}
          />
        </View>
      </View>

      <View style={styles.lookupRow}>
        <View style={styles.lookupField}>
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>Postmile</Text>
          <TextInput
            value={postmile}
            onChangeText={setPostmile}
            placeholder="12.5"
            keyboardType="decimal-pad"
            placeholderTextColor={palette.muted}
            style={inputStyle}
          />
        </View>
        <View style={styles.lookupField}>
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>
            District (opt.)
          </Text>
          <TextInput
            value={district}
            onChangeText={setDistrict}
            placeholder="03"
            placeholderTextColor={palette.muted}
            maxLength={4}
            style={inputStyle}
          />
        </View>
      </View>

      {err ? (
        <Text style={[styles.errorText, { color: palette.danger }]}>{err}</Text>
      ) : null}

      <Pressable
        onPress={handleLookup}
        disabled={busy}
        style={[
          styles.btn,
          styles.btnSecondary,
          { borderColor: palette.border, backgroundColor: palette.panelSoft },
          busy && styles.btnDisabled,
        ]}
      >
        <Text style={[styles.btnText, { color: palette.text }]}>
          {busy ? "Looking up…" : "Lookup"}
        </Text>
      </Pressable>

      {results !== null && results.length === 0 && (
        <Text style={[styles.mutedText, { color: palette.muted }]}>
          No matching segments found.
        </Text>
      )}

      {results !== null && results.length > 0 && (
        <View style={styles.resultsContainer}>
          {results.map((seg, idx) => (
            <View
              key={seg.id}
              style={[
                styles.segCard,
                {
                  backgroundColor: palette.panelSoft,
                  borderColor: palette.border,
                },
                idx === 0 && {
                  borderColor: palette.primary,
                },
              ]}
            >
              <Text style={[styles.segTitle, { color: palette.text }]}>
                {seg.county_code} · Rte {seg.route_name}
                {seg.route_suffix_code ?? ""}{" "}
                <Text style={{ color: palette.muted }}>
                  PM {seg.begin_pm}–{seg.end_pm}
                </Text>
              </Text>
              <View style={styles.segGrid}>
                {seg.district_code ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      District
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.district_code}
                    </Text>
                  </>
                ) : null}
                {seg.length_miles != null ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      Length
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.length_miles} mi
                    </Text>
                  </>
                ) : null}
                {seg.terrain_code ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      Terrain
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.terrain_code}
                    </Text>
                  </>
                ) : null}
                {seg.design_speed != null ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      Speed
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.design_speed} mph
                    </Text>
                  </>
                ) : null}
                {seg.adt != null ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      ADT
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.adt.toLocaleString()}
                    </Text>
                  </>
                ) : null}
                {seg.landmark_short_desc ? (
                  <>
                    <Text style={[styles.segLabel, { color: palette.muted }]}>
                      Landmark
                    </Text>
                    <Text style={[styles.segVal, { color: palette.text }]}>
                      {seg.landmark_short_desc}
                    </Text>
                  </>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function RoadInventoryScreen() {
  const { palette, componentScale } = useUiSettings();

  const entrance = useRef(new Animated.Value(22)).current;
  const fade = useRef(new Animated.Value(0)).current;

  const [meta, setMeta] = useState<LocalPackageMeta | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const status = await getLocalRoadInventoryStatus();
    setMeta(status.available ? status.meta : null);
  }, []);

  useFocusEffect(
    useRef(() => {
      entrance.setValue(28);
      fade.setValue(0);
      const anim = Animated.parallel([
        Animated.timing(entrance, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }),
        Animated.timing(fade, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
        }),
      ]);
      anim.start();
      loadStatus().catch(() => {});
      return () => anim.stop();
    }).current,
  );

  async function handleSync() {
    setSyncing(true);
    setSyncErr(null);
    try {
      const token = await getToken();
      if (!token) {
        setSyncErr("Not authenticated. Please sign in again.");
        return;
      }
      const newMeta = await syncRoadInventoryPackage(token);
      setMeta(newMeta);
    } catch (e: any) {
      setSyncErr(e?.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleClear() {
    setClearing(true);
    setSyncErr(null);
    try {
      await clearLocalRoadInventoryPackage();
      setMeta(null);
    } catch (e: any) {
      setSyncErr(e?.message ?? "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  const isbusy = syncing || clearing;

  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.container, { backgroundColor: palette.bg }]}
    >
      <Animated.View
        style={[{ flex: 1, opacity: fade, transform: [{ translateX: entrance }] }]}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingHorizontal: Math.round(14 * componentScale) },
          ]}
        >
          <Text style={[styles.title, { color: palette.text }]}>
            Road Inventory
          </Text>
          <Text style={[styles.subtitle, { color: palette.muted }]}>
            Sync offline road segment data for field use without connectivity.
          </Text>

          {/* Status */}
          <View
            style={[
              styles.statusBanner,
              {
                backgroundColor: meta ? palette.panel : palette.panelSoft,
                borderColor: meta ? palette.primary : palette.border,
              },
            ]}
          >
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: meta ? palette.primary : palette.muted,
                  },
                ]}
              />
              <Text
                style={[
                  styles.statusText,
                  { color: meta ? palette.primary : palette.muted },
                ]}
              >
                {meta ? "Road inventory available offline" : "No offline data"}
              </Text>
            </View>
          </View>

          {meta ? <StatusCard meta={meta} palette={palette} /> : null}

          {syncErr ? (
            <View
              style={[
                styles.errorCard,
                { backgroundColor: palette.panelSoft, borderColor: palette.danger },
              ]}
            >
              <Text style={[styles.errorText, { color: palette.danger }]}>
                {syncErr}
              </Text>
            </View>
          ) : null}

          {/* Actions */}
          <View style={styles.actionsRow}>
            <Pressable
              onPress={handleSync}
              disabled={isbusy}
              style={[
                styles.btn,
                styles.btnPrimary,
                { backgroundColor: palette.primary },
                isbusy && styles.btnDisabled,
              ]}
            >
              {syncing ? (
                <ActivityIndicator color={palette.primaryText} size="small" />
              ) : (
                <Text style={[styles.btnText, { color: palette.primaryText }]}>
                  {meta ? "Re-sync" : "Sync Road Inventory"}
                </Text>
              )}
            </Pressable>

            {meta ? (
              <Pressable
                onPress={handleClear}
                disabled={isbusy}
                style={[
                  styles.btn,
                  styles.btnSecondary,
                  {
                    borderColor: palette.danger,
                    backgroundColor: palette.panelSoft,
                  },
                  isbusy && styles.btnDisabled,
                ]}
              >
                {clearing ? (
                  <ActivityIndicator color={palette.danger} size="small" />
                ) : (
                  <Text style={[styles.btnText, { color: palette.danger }]}>
                    Clear Local Data
                  </Text>
                )}
              </Pressable>
            ) : null}
          </View>

          {/* Lookup tester — only available when data is synced */}
          {meta ? (
            <>
              <View
                style={[styles.divider, { backgroundColor: palette.border }]}
              />
              <LookupTester palette={palette} />
            </>
          ) : null}
        </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 14, gap: 12, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { marginTop: 2, marginBottom: 4, fontSize: 13 },

  statusBanner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 14, fontWeight: "700" },

  infoBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  label: { fontSize: 12, fontWeight: "600" },
  value: { fontSize: 13, fontWeight: "700" },
  valueMono: { fontSize: 11, fontFamily: "monospace" },

  errorCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  errorText: { fontSize: 13 },

  actionsRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 120,
    minHeight: 42,
  },
  btnPrimary: {},
  btnSecondary: { borderWidth: 1 },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: 14, fontWeight: "700" },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },

  sectionTitle: { fontSize: 16, fontWeight: "800", marginBottom: 10 },

  lookupRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  lookupField: { flex: 1 },
  fieldLabel: { fontSize: 11, fontWeight: "600", marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },

  mutedText: { fontSize: 13, marginTop: 8 },

  resultsContainer: { gap: 8, marginTop: 8 },
  segCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 6,
  },
  segTitle: { fontSize: 13, fontWeight: "700" },
  segGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    rowGap: 4,
  },
  segLabel: { fontSize: 11, fontWeight: "600", width: 60 },
  segVal: { fontSize: 11, width: 80 },
});
