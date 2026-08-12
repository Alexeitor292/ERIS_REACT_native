import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { useFocusEffect } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import type { IncidentAttachmentKind, IncidentCreatePayload } from "@/src/api/incidents";
import { enrichPointFromArcgisClient } from "@/src/utils/arcgisEnrichment";
import { resolveRoadLocationFromArcgisClient } from "@/src/utils/arcgisRoadLocation";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import {
  CALTRANS_COUNTIES,
  countyCodeFromNameOrCode,
  routesForCounty,
} from "@/src/utils/caltransLookups";
import {
  formatCoordinate,
  normalizeCoordinateValue,
  normalizePostMileInput,
  normalizePostMileValue,
  normalizeRouteValue,
} from "@/src/utils/precision";
import { prepareUploadFile } from "@/src/utils/uploadFile";
import {
  getLocalRoadInventoryStatus,
  lookupLocalCoordinatesByRoad,
  lookupLocalLocationByCoordinates,
  lookupLocalRoadSegments,
  syncRoadInventoryPackage,
  type LocalLocationResolution,
  type RoadSegment,
} from "@/src/services/roadInventoryOffline";
import {
  enqueueIncidentForSync,
  flushQueuedIncidents,
  getQueuedIncidentCount,
  listQueuedIncidents,
  type QueuedIncidentFile,
} from "@/src/offline/incidentQueue";

type LocationEntryMode = "GPS" | "COORDINATES" | "ROAD";

type PendingIncidentUpload = Omit<QueuedIncidentFile, "uploaded">;

const DISTRICTS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseYmd(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  const date = new Date(y, m, d);
  if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
  return date;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function numericPostmile(value: string): number | null {
  const match = String(value || "").trim().toUpperCase().match(/^[A-Z]?(-?\d+(?:\.\d+)?)[A-Z]?$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function normalizeRoute(input: string): string {
  return normalizeRouteValue(input) ?? "";
}

function inferIncidentAttachmentKind(name: string, mimeType: string): IncidentAttachmentKind {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/png" && /sketch/i.test(name)) return "SKETCH";
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png" && /sketch/i.test(name)) return "SKETCH";
  if (["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].includes(ext)) return "PHOTO";
  if (["mp4", "mov", "m4v", "avi", "mkv", "webm"].includes(ext)) return "VIDEO";
  return "DOC";
}

function guessMimeType(name: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function locationMethodLabel(method: string | null): string {
  if (!method) return "";
  if (method.includes("OFFLINE") || method.includes("REFERENCE") || method.includes("POSTMILE")) {
    return method.replaceAll("_", " ").toLowerCase();
  }
  return method;
}

export default function CreateIncidentScreen() {
  const { palette } = useUiSettings();
  const [mode, setMode] = useState<LocationEntryMode>("GPS");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [district, setDistrict] = useState("");
  const [county, setCounty] = useState("");
  const [routeValue, setRouteValue] = useState("");
  const [postMile, setPostMile] = useState("");
  const [firstObservedAt, setFirstObservedAt] = useState(todayYmd());
  const [firstOccurredAt, setFirstOccurredAt] = useState("");
  const [description, setDescription] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingIncidentUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [syncingReference, setSyncingReference] = useState(false);
  const [locationDirty, setLocationDirty] = useState(true);
  const [resolutionSource, setResolutionSource] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState<string | null>(null);
  const [roadInventoryAvailable, setRoadInventoryAvailable] = useState(false);
  const [locationReferenceAvailable, setLocationReferenceAvailable] = useState(false);
  const [roadInventoryVersionTag, setRoadInventoryVersionTag] = useState("");
  const [roadInventoryDatasetVersionId, setRoadInventoryDatasetVersionId] = useState<number | null>(null);
  const [roadInventoryMatches, setRoadInventoryMatches] = useState<RoadSegment[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [districtPickerOpen, setDistrictPickerOpen] = useState(false);
  const [countyPickerOpen, setCountyPickerOpen] = useState(false);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [datePickerKey, setDatePickerKey] = useState<"observed" | "occurred" | null>(null);
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const autoSyncAttempted = useRef(false);

  const countiesForDistrict = useMemo(
    () => (district ? CALTRANS_COUNTIES.filter((c) => c.district === district) : CALTRANS_COUNTIES),
    [district],
  );
  const countyInfo = useMemo(
    () => CALTRANS_COUNTIES.find((c) => c.code === county) ?? null,
    [county],
  );
  const routeOptions = useMemo(
    () => routesForCounty(county).map(normalizeRoute).filter(Boolean),
    [county],
  );
  const calendarDays = useMemo(() => {
    const first = new Date(calendarYear, calendarMonth, 1).getDay();
    const count = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const cells: (number | null)[] = Array(first).fill(null);
    for (let day = 1; day <= count; day += 1) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calendarMonth, calendarYear]);

  const refreshOfflineStatus = useCallback(async () => {
    const [status, count] = await Promise.all([
      getLocalRoadInventoryStatus(),
      getQueuedIncidentCount(),
    ]);
    setRoadInventoryAvailable(status.available);
    setLocationReferenceAvailable(status.location_reference_available);
    setRoadInventoryVersionTag(status.available ? status.meta.version_tag : "");
    setRoadInventoryDatasetVersionId(status.available ? status.meta.dataset_version_id : null);
    setQueuedCount(count);
    return status;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const run = async () => {
        const status = await refreshOfflineStatus();
        if (cancelled || status.location_reference_available || autoSyncAttempted.current) return;
        autoSyncAttempted.current = true;
        const token = await getToken();
        if (!token || cancelled) return;
        try {
          await syncRoadInventoryPackage(token);
          if (!cancelled) await refreshOfflineStatus();
        } catch {
          // Non-blocking. The screen exposes a manual Sync button and online
          // fallbacks; an already-downloaded package remains untouched.
        }
      };
      run().catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [refreshOfflineStatus]),
  );

  useEffect(() => {
    const pm = numericPostmile(postMile);
    if (!roadInventoryAvailable || !county || !routeValue || pm == null) {
      setRoadInventoryMatches([]);
      return;
    }
    let cancelled = false;
    lookupLocalRoadSegments({
      countyCode: county,
      routeName: routeValue,
      postmile: pm,
      districtCode: district || undefined,
    })
      .then((matches) => {
        if (!cancelled) setRoadInventoryMatches(matches);
      })
      .catch(() => {
        if (!cancelled) setRoadInventoryMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [county, district, postMile, roadInventoryAvailable, routeValue]);

  const clearLocation = (nextMode: LocationEntryMode) => {
    setMode(nextMode);
    setLatitude("");
    setLongitude("");
    setDistrict("");
    setCounty("");
    setRouteValue("");
    setPostMile("");
    setRoadInventoryMatches([]);
    setResolutionSource(null);
    setResolutionNote(null);
    setLocationDirty(true);
  };

  const applyResolution = (resolution: {
    latitude: number;
    longitude: number;
    district?: string | null;
    county?: string | null;
    route?: string | null;
    post_mile?: string | null;
    source?: string | null;
    method?: string | null;
  }) => {
    const countyCode = countyCodeFromNameOrCode(resolution.county ?? "") ?? String(resolution.county ?? "").trim().toUpperCase();
    setLatitude(formatCoordinate(resolution.latitude));
    setLongitude(formatCoordinate(resolution.longitude));
    setDistrict(String(resolution.district ?? "").trim().padStart(2, "0"));
    setCounty(countyCode);
    setRouteValue(normalizeRoute(String(resolution.route ?? "")));
    setPostMile(normalizePostMileInput(resolution.post_mile));
    setResolutionSource(resolution.source ?? null);
    setResolutionNote(resolution.method ? locationMethodLabel(resolution.method) : null);
    setLocationDirty(false);
  };

  const resolveCoordinatePair = async (lat: number, lon: number): Promise<boolean> => {
    const local = await lookupLocalLocationByCoordinates({ latitude: lat, longitude: lon });
    if (local) {
      applyResolution(local);
      return true;
    }

    const online = await enrichPointFromArcgisClient(lat, lon);
    if (online.district && online.county && online.route && online.post_mile) {
      applyResolution({
        latitude: lat,
        longitude: lon,
        district: online.district,
        county: online.county,
        route: online.route,
        post_mile: online.post_mile,
        source: "CALTRANS_POSTMILE_ONLINE",
        method: "ONLINE_COORDINATE_LOOKUP",
      });
      return true;
    }
    return false;
  };

  const onGpsAutofill = async () => {
    setResolving(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert("Permission Needed", "Location permission is required for GPS Autofill.");
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const lat = normalizeCoordinateValue(position.coords.latitude);
      const lon = normalizeCoordinateValue(position.coords.longitude);
      if (lat == null || lon == null) {
        Alert.alert("Location Error", "The device did not return valid coordinates.");
        return;
      }
      const resolved = await resolveCoordinatePair(lat, lon);
      if (!resolved) {
        setLatitude(formatCoordinate(lat));
        setLongitude(formatCoordinate(lon));
        setLocationDirty(true);
        Alert.alert(
          "Road Location Not Resolved",
          "GPS coordinates were captured, but ERIS could not resolve District / County / Route / Post Mile. Sync Offline Location Data or switch to Road / Post Mile entry.",
        );
      }
    } catch (error: any) {
      Alert.alert("GPS Error", String(error?.message ?? error));
    } finally {
      setResolving(false);
    }
  };

  const onResolveCoordinates = async () => {
    const lat = normalizeCoordinateValue(latitude);
    const lon = normalizeCoordinateValue(longitude);
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      Alert.alert("Invalid Coordinates", "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    setResolving(true);
    try {
      const resolved = await resolveCoordinatePair(lat, lon);
      if (!resolved) {
        Alert.alert(
          "Location Not Found",
          locationReferenceAvailable
            ? "No Caltrans highway postmile was found close enough to those coordinates."
            : "The offline location reference is not available and the online Caltrans lookup could not be reached. Sync Offline Location Data while connected.",
        );
      }
    } finally {
      setResolving(false);
    }
  };

  const onResolveRoadLocation = async () => {
    const pm = numericPostmile(postMile);
    if (!district || !county || !routeValue || pm == null) {
      Alert.alert("Missing Road Location", "District, County, Route, and a valid Post Mile are required.");
      return;
    }
    setResolving(true);
    try {
      const local = await lookupLocalCoordinatesByRoad({
        districtCode: district,
        countyCode: county,
        routeName: routeValue,
        postmile: postMile,
      });
      if (local) {
        applyResolution(local);
        return;
      }

      const online = await resolveRoadLocationFromArcgisClient({
        district,
        county,
        route: routeValue,
        postmile: pm,
      });
      if (online) {
        applyResolution(online);
        return;
      }

      Alert.alert(
        "Coordinates Not Found",
        locationReferenceAvailable
          ? "ERIS could not locate that District / County / Route / Post Mile in the Caltrans reference. Check the values and postmile prefix/suffix."
          : "The offline location reference is not available and the online Caltrans lookup could not be reached. Sync Offline Location Data while connected.",
      );
    } finally {
      setResolving(false);
    }
  };

  const onSyncReference = async () => {
    setSyncingReference(true);
    try {
      const token = await getToken();
      if (!token) {
        Alert.alert("Sign In Required", "Sign in before syncing offline location data.");
        return;
      }
      const meta = await syncRoadInventoryPackage(token);
      await refreshOfflineStatus();
      if ((meta.location_point_count ?? 0) > 0) {
        Alert.alert("Offline Location Data Ready", `${meta.location_point_count?.toLocaleString()} Caltrans postmile reference points are available on this device.`);
      } else {
        Alert.alert(
          "Package Needs Regeneration",
          "The downloaded road-inventory package is an older version without postmile geometry. An administrator must regenerate the current mobile package on the server.",
        );
      }
    } catch (error: any) {
      Alert.alert("Sync Failed", String(error?.message ?? error));
    } finally {
      setSyncingReference(false);
    }
  };

  const updateCoordinateInput = (field: "lat" | "lon", value: string) => {
    if (field === "lat") setLatitude(value);
    else setLongitude(value);
    setDistrict("");
    setCounty("");
    setRouteValue("");
    setPostMile("");
    setResolutionSource(null);
    setResolutionNote(null);
    setLocationDirty(true);
  };

  const markRoadInputChanged = () => {
    setLatitude("");
    setLongitude("");
    setResolutionSource(null);
    setResolutionNote(null);
    setLocationDirty(true);
  };

  const openDatePicker = (key: "observed" | "occurred") => {
    const current = key === "observed" ? firstObservedAt : firstOccurredAt;
    const parsed = parseYmd(current) ?? new Date();
    setCalendarYear(parsed.getFullYear());
    setCalendarMonth(parsed.getMonth());
    setDatePickerKey(key);
  };

  const selectDate = (day: number) => {
    if (!datePickerKey) return;
    const value = ymd(new Date(calendarYear, calendarMonth, day));
    if (datePickerKey === "observed") setFirstObservedAt(value);
    else setFirstOccurredAt(value);
    setDatePickerKey(null);
  };

  const addPendingFiles = (files: PendingIncidentUpload[]) => {
    if (files.length) setPendingFiles((prev) => [...prev, ...files]);
  };

  const pickMedia = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission Required", "Photo library access is required to add photos or videos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.85,
      allowsMultipleSelection: true,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (result.canceled || !result.assets?.length) return;
    const files: PendingIncidentUpload[] = [];
    for (const asset of result.assets) {
      const uri = String(asset.uri || "").trim();
      if (!uri) continue;
      const name = asset.fileName || uri.split("/").pop() || "incident-media.bin";
      const type = guessMimeType(name, asset.mimeType);
      const prepared = await prepareUploadFile({ uri, name, type });
      files.push({
        ...prepared,
        kind: inferIncidentAttachmentKind(prepared.name, prepared.type),
        size: typeof asset.fileSize === "number" ? asset.fileSize : null,
      });
    }
    addPendingFiles(files);
  };

  const pickDocuments = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const files: PendingIncidentUpload[] = [];
    for (const asset of result.assets) {
      const uri = String(asset.uri || "").trim();
      if (!uri) continue;
      const name = String(asset.name || uri.split("/").pop() || "incident-file.bin");
      const type = guessMimeType(name, asset.mimeType);
      const prepared = await prepareUploadFile({ uri, name, type });
      files.push({
        ...prepared,
        kind: inferIncidentAttachmentKind(prepared.name, prepared.type),
        size: typeof asset.size === "number" ? asset.size : null,
      });
    }
    addPendingFiles(files);
  };

  const promptUploadSource = () => {
    Alert.alert("Add Supporting Files", "Choose a source.", [
      { text: "Gallery", onPress: () => pickMedia().catch((e) => Alert.alert("File Error", String(e?.message ?? e))) },
      { text: "Files", onPress: () => pickDocuments().catch((e) => Alert.alert("File Error", String(e?.message ?? e))) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const resetForm = () => {
    setMode("GPS");
    setLatitude("");
    setLongitude("");
    setDistrict("");
    setCounty("");
    setRouteValue("");
    setPostMile("");
    setFirstObservedAt(todayYmd());
    setFirstOccurredAt("");
    setDescription("");
    setPendingFiles([]);
    setRoadInventoryMatches([]);
    setResolutionSource(null);
    setResolutionNote(null);
    setLocationDirty(true);
  };

  const buildRoadInventoryContext = () => {
    const segment = roadInventoryMatches[0];
    if (!segment || !roadInventoryDatasetVersionId) return undefined;
    return {
      dataset_version_id: roadInventoryDatasetVersionId,
      segment_id: segment.id,
      match_method: "MOBILE_OFFLINE",
      snapshot: {
        district_code: segment.district_code,
        county_code: segment.county_code,
        route_name: segment.route_name,
        route_suffix_code: segment.route_suffix_code,
        pm_prefix_code: segment.pm_prefix_code,
        begin_pm: segment.begin_pm,
        end_pm: segment.end_pm,
        length_miles: segment.length_miles,
        left_lanes: segment.left_lanes,
        right_lanes: segment.right_lanes,
        left_surface_type: segment.left_surface_type,
        right_surface_type: segment.right_surface_type,
        median_type: segment.median_type,
        median_width: segment.median_width,
        terrain_code: segment.terrain_code,
        design_speed: segment.design_speed,
        adt: segment.adt,
        landmark_short_desc: segment.landmark_short_desc,
        location_resolution_source: resolutionSource,
        location_resolution_method: resolutionNote,
      },
    };
  };

  const onCreate = async () => {
    const lat = normalizeCoordinateValue(latitude);
    const lon = normalizeCoordinateValue(longitude);
    if (locationDirty) {
      Alert.alert("Resolve Location First", "Use GPS Autofill or resolve the entered Coordinates / Road Location before creating the incident.");
      return;
    }
    if (lat == null || lon == null || !district || !county || !routeValue || !postMile) {
      Alert.alert("Missing Location", "A complete resolved location is required.");
      return;
    }
    if (!parseYmd(firstObservedAt)) {
      Alert.alert("Invalid Date", "First Observed must be a valid date.");
      return;
    }
    if (firstOccurredAt && !parseYmd(firstOccurredAt)) {
      Alert.alert("Invalid Date", "First Occurred must be a valid date or left empty.");
      return;
    }

    const payload: IncidentCreatePayload = {
      description: description.trim() || null,
      first_observed_at: firstObservedAt,
      first_occurred_at: firstOccurredAt || null,
      latitude: lat,
      longitude: lon,
      district,
      county,
      route: routeValue,
      post_mile: normalizePostMileValue(postMile) ?? postMile,
      road_inventory_context: buildRoadInventoryContext(),
    };

    setBusy(true);
    try {
      // Persist first. A process kill, Airplane Mode, or a network failure after
      // this point cannot discard the field report.
      const queued = await enqueueIncidentForSync(payload, pendingFiles);
      let synced = false;
      const token = await getToken();
      if (token) {
        await flushQueuedIncidents(token);
        const remaining = await listQueuedIncidents();
        synced = !remaining.some((record) => record.localId === queued.localId);
      }
      await refreshOfflineStatus();
      resetForm();

      if (synced) {
        Alert.alert("Incident Created", "The incident was saved locally and synchronized with ERIS.");
      } else {
        Alert.alert(
          "Incident Saved Offline",
          "The incident is safely stored on this device and is pending sync. ERIS will retry automatically when connectivity returns.",
        );
      }
    } catch (error: any) {
      Alert.alert("Save Error", String(error?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const resolved = !locationDirty && !!latitude && !!longitude && !!district && !!county && !!routeValue && !!postMile;
  const coordinateKeyboard = Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={[styles.title, { color: palette.text }]}>Create Incident</Text>
          <Text style={[styles.subtitle, { color: palette.muted }]}>Choose how to identify the incident location. All three methods produce the same District / County / Route / Post Mile + coordinate record.</Text>

          {queuedCount > 0 ? (
            <View style={[styles.banner, { borderColor: "#d97706", backgroundColor: palette.panelSoft }]}>
              <Text style={{ color: palette.text, fontWeight: "800" }}>{queuedCount} incident{queuedCount === 1 ? "" : "s"} pending sync</Text>
              <Text style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>Stored locally. Automatic sync retries while ERIS is open and whenever the app returns to the foreground.</Text>
            </View>
          ) : null}

          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.panel }]}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Location Entry Method</Text>
            <View style={styles.modeRow}>
              {([
                ["GPS", "GPS Autofill"],
                ["COORDINATES", "Coordinates"],
                ["ROAD", "Road / Post Mile"],
              ] as [LocationEntryMode, string][]).map(([key, label]) => {
                const active = mode === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => clearLocation(key)}
                    style={[
                      styles.modeButton,
                      {
                        borderColor: active ? palette.primary : palette.border,
                        backgroundColor: active ? palette.primary : palette.panelSoft,
                      },
                    ]}
                  >
                    <Text style={{ color: active ? "#fff" : palette.text, fontWeight: "800", fontSize: 12 }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {mode === "GPS" ? (
              <View style={{ marginTop: 12 }}>
                <Text style={{ color: palette.muted, marginBottom: 8 }}>Capture the phone's current coordinates and resolve the Caltrans road location.</Text>
                <Pressable disabled={resolving} onPress={onGpsAutofill} style={[styles.primaryButton, { backgroundColor: palette.primary }]}>
                  {resolving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Use Current GPS</Text>}
                </Pressable>
              </View>
            ) : null}

            {mode === "COORDINATES" ? (
              <View style={{ marginTop: 10 }}>
                <View style={styles.row}>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>Latitude *</Text>
                    <TextInput
                      value={latitude}
                      onChangeText={(value) => updateCoordinateInput("lat", value)}
                      onBlur={() => setLatitude((value) => formatCoordinate(value))}
                      keyboardType={coordinateKeyboard}
                      autoCorrect={false}
                      placeholder="38.581572"
                      placeholderTextColor={palette.muted}
                      style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                    />
                  </View>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>Longitude *</Text>
                    <TextInput
                      value={longitude}
                      onChangeText={(value) => updateCoordinateInput("lon", value)}
                      onBlur={() => setLongitude((value) => formatCoordinate(value))}
                      keyboardType={coordinateKeyboard}
                      autoCorrect={false}
                      placeholder="-121.494400"
                      placeholderTextColor={palette.muted}
                      style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                    />
                  </View>
                </View>
                <Text style={[styles.helper, { color: palette.muted }]}>Negative longitude is supported. On iPhone the keyboard includes the minus sign.</Text>
                <Pressable disabled={resolving} onPress={onResolveCoordinates} style={[styles.primaryButton, { backgroundColor: palette.primary }]}>
                  {resolving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Resolve District / County / Route / Post Mile</Text>}
                </Pressable>
              </View>
            ) : null}

            {mode === "ROAD" ? (
              <View style={{ marginTop: 10 }}>
                <View style={styles.row}>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>District *</Text>
                    <Pressable onPress={() => setDistrictPickerOpen(true)} style={[styles.select, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                      <Text style={{ color: district ? palette.text : palette.muted }}>{district || "Select"}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>County *</Text>
                    <Pressable disabled={!district} onPress={() => setCountyPickerOpen(true)} style={[styles.select, { borderColor: palette.border, backgroundColor: palette.panelSoft, opacity: district ? 1 : 0.55 }]}>
                      <Text style={{ color: county ? palette.text : palette.muted }}>{countyInfo ? `${countyInfo.name} (${countyInfo.code})` : district ? "Select" : "District first"}</Text>
                    </Pressable>
                  </View>
                </View>
                <View style={styles.row}>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>Route *</Text>
                    <Pressable disabled={!county} onPress={() => setRoutePickerOpen(true)} style={[styles.select, { borderColor: palette.border, backgroundColor: palette.panelSoft, opacity: county ? 1 : 0.55 }]}>
                      <Text style={{ color: routeValue ? palette.text : palette.muted }}>{routeValue || (county ? "Select" : "County first")}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.flexField}>
                    <Text style={[styles.label, { color: palette.muted }]}>Post Mile *</Text>
                    <TextInput
                      value={postMile}
                      onChangeText={(value) => {
                        setPostMile(value);
                        markRoadInputChanged();
                      }}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      placeholder="12.50 or R12.50"
                      placeholderTextColor={palette.muted}
                      style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                    />
                  </View>
                </View>
                <Pressable disabled={resolving} onPress={onResolveRoadLocation} style={[styles.primaryButton, { backgroundColor: palette.primary }]}>
                  {resolving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Resolve Coordinates</Text>}
                </Pressable>
              </View>
            ) : null}

            <View style={[styles.offlineStatus, { borderColor: locationReferenceAvailable ? "#16a34a" : "#d97706", backgroundColor: palette.panelSoft }]}>
              <Text style={{ color: palette.text, fontWeight: "800" }}>{locationReferenceAvailable ? "Offline location conversion ready" : "Offline location conversion not ready"}</Text>
              <Text style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>
                {locationReferenceAvailable
                  ? `Road inventory ${roadInventoryVersionTag} includes Caltrans postmile geometry.`
                  : "Sync the current mobile road-inventory package while connected. Online lookups remain a fallback."}
              </Text>
              {!locationReferenceAvailable ? (
                <Pressable disabled={syncingReference} onPress={onSyncReference} style={[styles.smallButton, { borderColor: palette.border }]}>
                  <Text style={{ color: palette.text, fontWeight: "700" }}>{syncingReference ? "Syncing..." : "Sync Offline Location Data"}</Text>
                </Pressable>
              ) : null}
            </View>

            {resolved ? (
              <View style={[styles.resolvedCard, { borderColor: "#16a34a", backgroundColor: palette.panelSoft }]}>
                <Text style={{ color: palette.text, fontWeight: "800" }}>Resolved Location</Text>
                <Text style={{ color: palette.text, marginTop: 5 }}>{`District ${district} · ${county} · Route ${routeValue} · PM ${postMile}`}</Text>
                <Text style={{ color: palette.muted, marginTop: 2 }}>{`${latitude}, ${longitude}`}</Text>
                {resolutionSource ? <Text style={{ color: palette.muted, fontSize: 11, marginTop: 4 }}>{`${resolutionSource}${resolutionNote ? ` · ${resolutionNote}` : ""}`}</Text> : null}
              </View>
            ) : null}
          </View>

          <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.panel }]}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Incident Details</Text>
            {roadInventoryMatches.length > 0 ? (
              <View style={[styles.inventoryCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                <Text style={{ color: palette.text, fontWeight: "800" }}>Road Inventory Match</Text>
                <Text style={{ color: palette.muted, marginTop: 3 }}>{`${roadInventoryMatches[0].county_code} · Route ${roadInventoryMatches[0].route_name} · PM ${roadInventoryMatches[0].begin_pm}–${roadInventoryMatches[0].end_pm}`}</Text>
              </View>
            ) : null}

            <Text style={[styles.label, { color: palette.muted }]}>First Observed *</Text>
            <Pressable onPress={() => openDatePicker("observed")} style={[styles.select, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
              <Text style={{ color: palette.text }}>{firstObservedAt}</Text>
            </Pressable>

            <Text style={[styles.label, { color: palette.muted, marginTop: 8 }]}>First Occurred (optional)</Text>
            <Pressable onPress={() => openDatePicker("occurred")} style={[styles.select, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
              <Text style={{ color: firstOccurredAt ? palette.text : palette.muted }}>{firstOccurredAt || "Select date"}</Text>
            </Pressable>

            <Text style={[styles.label, { color: palette.muted, marginTop: 8 }]}>Description</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              multiline
              placeholder="Describe what maintenance observed"
              placeholderTextColor={palette.muted}
              style={[styles.input, styles.multiline, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            />

            <View style={{ marginTop: 6 }}>
              <Text style={[styles.label, { color: palette.muted }]}>Supporting Files</Text>
              <Text style={[styles.helper, { color: palette.muted }]}>Files are staged in app storage before the incident is queued, so they remain available for a later upload.</Text>
              <Pressable onPress={promptUploadSource} style={[styles.smallButton, { borderColor: palette.border }]}>
                <Text style={{ color: palette.text, fontWeight: "700" }}>Add Files</Text>
              </Pressable>
              {pendingFiles.map((file, index) => (
                <View key={`${file.uri}-${index}`} style={[styles.fileRow, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: palette.text, fontWeight: "700" }} numberOfLines={1}>{file.name}</Text>
                    <Text style={{ color: palette.muted, fontSize: 12 }}>{`${file.kind}${formatFileSize(file.size) ? ` · ${formatFileSize(file.size)}` : ""}`}</Text>
                  </View>
                  <Pressable onPress={() => setPendingFiles((files) => files.filter((_, i) => i !== index))}>
                    <Text style={{ color: palette.danger, fontWeight: "800" }}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>

          <Pressable disabled={busy || !resolved} onPress={onCreate} style={[styles.createButton, { backgroundColor: palette.primary, opacity: busy || !resolved ? 0.5 : 1 }]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createButtonText}>Create Incident</Text>}
          </Pressable>
          <Text style={[styles.footerNote, { color: palette.muted }]}>Create Incident always writes the report to local durable storage first, then attempts server sync. Losing connectivity does not discard the incident.</Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={districtPickerOpen} transparent animationType="fade" onRequestClose={() => setDistrictPickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setDistrictPickerOpen(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Select District</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {DISTRICTS.map((value) => (
                <Pressable key={value} onPress={() => {
                  setDistrict(value);
                  setCounty("");
                  setRouteValue("");
                  setPostMile("");
                  markRoadInputChanged();
                  setDistrictPickerOpen(false);
                }} style={styles.option}>
                  <Text style={{ color: palette.text, fontWeight: "700" }}>{value}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={countyPickerOpen} transparent animationType="fade" onRequestClose={() => setCountyPickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCountyPickerOpen(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Select County</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {countiesForDistrict.map((item) => (
                <Pressable key={item.code} onPress={() => {
                  setCounty(item.code);
                  setDistrict(item.district);
                  setRouteValue("");
                  setPostMile("");
                  markRoadInputChanged();
                  setCountyPickerOpen(false);
                }} style={styles.option}>
                  <Text style={{ color: palette.text, fontWeight: "700" }}>{`${item.name} (${item.code})`}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={routePickerOpen} transparent animationType="fade" onRequestClose={() => setRoutePickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setRoutePickerOpen(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Select Route</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {routeOptions.map((value) => (
                <Pressable key={value} onPress={() => {
                  setRouteValue(value);
                  setPostMile("");
                  markRoadInputChanged();
                  setRoutePickerOpen(false);
                }} style={styles.option}>
                  <Text style={{ color: palette.text, fontWeight: "700" }}>{value}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={datePickerKey != null} transparent animationType="fade" onRequestClose={() => setDatePickerKey(null)}>
        <Pressable style={styles.backdrop} onPress={() => setDatePickerKey(null)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <View style={styles.calendarHeader}>
              <Pressable onPress={() => {
                if (calendarMonth === 0) {
                  setCalendarMonth(11);
                  setCalendarYear((year) => year - 1);
                } else setCalendarMonth((month) => month - 1);
              }}><Text style={[styles.calendarNav, { color: palette.text }]}>‹</Text></Pressable>
              <Text style={[styles.sectionTitle, { color: palette.text }]}>{new Date(calendarYear, calendarMonth, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</Text>
              <Pressable onPress={() => {
                if (calendarMonth === 11) {
                  setCalendarMonth(0);
                  setCalendarYear((year) => year + 1);
                } else setCalendarMonth((month) => month + 1);
              }}><Text style={[styles.calendarNav, { color: palette.text }]}>›</Text></Pressable>
            </View>
            <View style={styles.calendarRow}>{["S", "M", "T", "W", "T", "F", "S"].map((day, i) => <Text key={`${day}-${i}`} style={[styles.weekday, { color: palette.muted }]}>{day}</Text>)}</View>
            <View style={styles.calendarGrid}>
              {calendarDays.map((day, index) => (
                <Pressable key={`${day ?? "x"}-${index}`} disabled={!day} onPress={() => day && selectDate(day)} style={[styles.calendarCell, !day ? { opacity: 0 } : null]}>
                  <Text style={{ color: palette.text }}>{day ?? ""}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.calendarActions}>
              {datePickerKey === "occurred" ? (
                <Pressable onPress={() => { setFirstOccurredAt(""); setDatePickerKey(null); }} style={[styles.smallButton, { borderColor: palette.border }]}><Text style={{ color: palette.text, fontWeight: "700" }}>Clear</Text></Pressable>
              ) : null}
              <Pressable onPress={() => { const value = todayYmd(); if (datePickerKey === "observed") setFirstObservedAt(value); else setFirstOccurredAt(value); setDatePickerKey(null); }} style={[styles.smallButton, { borderColor: palette.border }]}><Text style={{ color: palette.text, fontWeight: "700" }}>Today</Text></Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 14, paddingBottom: 44 },
  title: { fontSize: 26, fontWeight: "900" },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 4, marginBottom: 12 },
  banner: { borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 10 },
  card: { borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: "900" },
  modeRow: { flexDirection: "row", gap: 7, marginTop: 10 },
  modeButton: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  row: { flexDirection: "row", gap: 8 },
  flexField: { flex: 1 },
  label: { fontSize: 13, fontWeight: "800", marginBottom: 4 },
  helper: { fontSize: 11, lineHeight: 16, marginBottom: 8 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8 },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  select: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, justifyContent: "center" },
  primaryButton: { minHeight: 46, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, marginTop: 4 },
  primaryButtonText: { color: "#fff", fontWeight: "900", textAlign: "center" },
  offlineStatus: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 12 },
  resolvedCard: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 10 },
  inventoryCard: { borderWidth: 1, borderRadius: 10, padding: 9, marginBottom: 10 },
  smallButton: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 8 },
  fileRow: { borderWidth: 1, borderRadius: 9, padding: 9, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  createButton: { minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  createButtonText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  footerNote: { fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 8 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.48)", justifyContent: "center", padding: 18 },
  modalCard: { borderWidth: 1, borderRadius: 14, padding: 12, width: "100%", maxWidth: 520, alignSelf: "center" },
  option: { paddingVertical: 11, paddingHorizontal: 9, borderRadius: 8 },
  calendarHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  calendarNav: { fontSize: 30, fontWeight: "800", width: 40, textAlign: "center" },
  calendarRow: { flexDirection: "row", marginTop: 8 },
  weekday: { width: "14.285%", textAlign: "center", fontWeight: "800", fontSize: 12 },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  calendarCell: { width: "14.285%", height: 42, alignItems: "center", justifyContent: "center" },
  calendarActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
