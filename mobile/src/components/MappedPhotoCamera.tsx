import { CameraView, useCameraPermissions, type CameraCapturedPicture } from "expo-camera";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import {
  MAX_MAPPED_PHOTO_ACCURACY_M,
  MIN_MAPPED_HEADING_ACCURACY_CODE,
  mergePhotoCaptureMetadata,
  photoCaptureMetadataFromAsset,
  photoCaptureMetadataFromDeviceSnapshot,
  type CameraDirectionSnapshot,
  type PhotoCaptureMetadata,
} from "../photos/captureMetadata";
import {
  readNativeCameraDirection,
  startNativeCameraDirection,
  stopNativeCameraDirection,
  supportsNativeCameraDirection,
  type CameraDirectionSample,
} from "../photos/CameraDirectionNative";

export type MappedPhotoCapture = {
  uri: string;
  name: string;
  type: "image/jpeg";
  captureMetadata: PhotoCaptureMetadata | null;
};

type TimedPosition = { value: Location.LocationObject; observedAt: number };

const POSITION_WINDOW_MS = 3000;
const POSITION_HISTORY_MS = 5000;

function positionAccuracy(sample: TimedPosition): number {
  const value = sample.value.coords.accuracy;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Number.POSITIVE_INFINITY;
}

function bestFreshPosition(samples: TimedPosition[], shutterAtMs: number): Location.LocationObject | null {
  const candidates = samples
    .filter((sample) => Math.abs(shutterAtMs - sample.observedAt) <= POSITION_WINDOW_MS)
    .filter((sample) => positionAccuracy(sample) <= MAX_MAPPED_PHOTO_ACCURACY_M)
    .sort((a, b) => {
      const accuracyDelta = positionAccuracy(a) - positionAccuracy(b);
      return accuracyDelta !== 0 ? accuracyDelta : b.observedAt - a.observedAt;
    });
  return candidates[0]?.value ?? null;
}

function cameraDirectionSnapshot(sample: CameraDirectionSample | null): CameraDirectionSnapshot | null {
  if (!sample) return null;
  if (!Number.isFinite(sample.heading) || sample.heading < 0 || sample.heading >= 360) return null;
  if (!Number.isFinite(sample.accuracyCode) || sample.accuracyCode < MIN_MAPPED_HEADING_ACCURACY_CODE) return null;
  if (sample.headingReference !== "TRUE_NORTH" || sample.sampleAgeMs > 500) return null;
  return {
    heading: sample.heading,
    accuracyCode: sample.accuracyCode,
    reference: "TRUE_NORTH",
  };
}

export function MappedPhotoCamera({
  visible,
  onCancel,
  onCaptured,
}: {
  visible: boolean;
  onCancel: () => void;
  onCaptured: (capture: MappedPhotoCapture) => void | Promise<void>;
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const positionSamplesRef = useRef<TimedPosition[]>([]);
  const cameraDirectionRef = useRef<CameraDirectionSample | null>(null);
  const [headingLabel, setHeadingLabel] = useState("Camera direction acquiring…");
  const [locationLabel, setLocationLabel] = useState("GPS acquiring…");
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCameraReady(false);
      positionSamplesRef.current = [];
      cameraDirectionRef.current = null;
      return;
    }
    if (!cameraPermission?.granted) return;

    let disposed = false;
    let positionSub: Location.LocationSubscription | null = null;
    let directionTimer: ReturnType<typeof setInterval> | null = null;
    let directionPollBusy = false;

    const recordPosition = (value: Location.LocationObject) => {
      if (disposed) return;
      const now = Date.now();
      positionSamplesRef.current = [
        ...positionSamplesRef.current.filter((sample) => now - sample.observedAt <= POSITION_HISTORY_MS),
        { value, observedAt: now },
      ].slice(-20);

      const accuracy = value.coords.accuracy;
      const best = bestFreshPosition(positionSamplesRef.current, now);
      const bestAccuracy = best?.coords.accuracy;
      if (bestAccuracy != null && Number.isFinite(bestAccuracy)) {
        setLocationLabel(`GPS best recent ±${Math.round(bestAccuracy)} m`);
      } else if (accuracy != null && Number.isFinite(accuracy)) {
        setLocationLabel(`GPS weak ±${Math.round(accuracy)} m • photo may be unmapped`);
      } else {
        setLocationLabel("GPS accuracy unknown • photo may be unmapped");
      }
    };

    void (async () => {
      const locationPermission = await Location.requestForegroundPermissionsAsync();
      if (!locationPermission.granted || disposed) {
        setLocationLabel("GPS unavailable • photo may be unmapped");
        setHeadingLabel("Camera direction unavailable");
        return;
      }
      if (!(await Location.hasServicesEnabledAsync()) || disposed) {
        setLocationLabel("Location services disabled");
        setHeadingLabel("Camera direction unavailable");
        return;
      }

      void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation })
        .then(recordPosition)
        .catch(() => undefined);

      try {
        positionSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 0 },
          recordPosition,
        );
      } catch {
        setLocationLabel("GPS unavailable • photo may be unmapped");
      }

      if (!supportsNativeCameraDirection()) {
        setHeadingLabel("Camera-axis direction requires the latest iOS development build");
        return;
      }

      try {
        await startNativeCameraDirection();
        if (disposed) {
          await stopNativeCameraDirection();
          return;
        }

        const refreshDirection = async () => {
          if (disposed || directionPollBusy) return;
          directionPollBusy = true;
          try {
            const sample = await readNativeCameraDirection();
            if (disposed) return;
            cameraDirectionRef.current = sample;
            const heading = Math.round(sample.heading);
            if (sample.accuracyCode >= 3) {
              setHeadingLabel(`Rear camera ${heading}° true • high calibration`);
            } else if (sample.accuracyCode >= MIN_MAPPED_HEADING_ACCURACY_CODE) {
              setHeadingLabel(`Rear camera ${heading}° true • medium calibration`);
            } else {
              setHeadingLabel(`Rear camera ${heading}° • calibration weak`);
            }
          } catch {
            if (!disposed) {
              cameraDirectionRef.current = null;
              setHeadingLabel("Camera direction calibrating… move phone in a figure eight");
            }
          } finally {
            directionPollBusy = false;
          }
        };

        await refreshDirection();
        directionTimer = setInterval(() => void refreshDirection(), 250);
      } catch {
        if (!disposed) setHeadingLabel("Camera direction unavailable");
      }
    })();

    return () => {
      disposed = true;
      positionSub?.remove();
      if (directionTimer) clearInterval(directionTimer);
      void stopNativeCameraDirection();
    };
  }, [cameraPermission?.granted, visible]);

  async function takeMappedPhoto() {
    if (!cameraReady || !cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const shutterAtMs = Date.now();
      const capturedAt = new Date(shutterAtMs).toISOString();
      const positionAtShutter = bestFreshPosition(positionSamplesRef.current, shutterAtMs);

      let directionSample = cameraDirectionRef.current;
      if (supportsNativeCameraDirection()) {
        try {
          directionSample = await readNativeCameraDirection();
          cameraDirectionRef.current = directionSample;
        } catch {
          // Keep the last sub-500ms native sample if the one-shot read races an update.
        }
      }
      const cameraDirection = cameraDirectionSnapshot(directionSample);

      const picture = await cameraRef.current.takePictureAsync({ quality: 0.9, exif: true });
      if (!picture?.uri) throw new Error("Camera did not return an image file.");

      const deviceMetadata = photoCaptureMetadataFromDeviceSnapshot({
        capturedAt,
        position: positionAtShutter,
        cameraDirection,
      });
      const exifMetadata = photoCaptureMetadataFromAsset({
        assetId: null,
        exif: (picture as CameraCapturedPicture).exif ?? null,
      });
      const captureMetadata = mergePhotoCaptureMetadata(deviceMetadata, exifMetadata);

      await onCaptured({
        uri: picture.uri,
        name: `field-photo-${shutterAtMs}.jpg`,
        type: "image/jpeg",
        captureMetadata,
      });
    } catch (error: any) {
      Alert.alert("Camera failed", String(error?.message ?? error ?? "Unable to capture photo."));
    } finally {
      setCapturing(false);
    }
  }

  const cameraGranted = cameraPermission?.granted === true;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      <View style={styles.container}>
        {cameraGranted ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setCameraReady(true)} />
        ) : (
          <SafeAreaView style={styles.permissionPane}>
            <Text style={styles.permissionTitle}>Camera Permission Required</Text>
            <Text style={styles.permissionText}>ERIS needs the camera to capture mapped field evidence.</Text>
            <Pressable style={styles.permissionButton} onPress={() => void requestCameraPermission()}>
              <Text style={styles.permissionButtonText}>Allow Camera</Text>
            </Pressable>
          </SafeAreaView>
        )}

        {cameraGranted ? (
          <SafeAreaView style={styles.overlay} pointerEvents="box-none">
            <View style={styles.topBar}>
              <Pressable style={styles.closeButton} onPress={onCancel} disabled={capturing}>
                <Text style={styles.closeText}>Cancel</Text>
              </Pressable>
              <View style={styles.telemetry}>
                <Text style={styles.telemetryText}>{locationLabel}</Text>
                <Text style={styles.telemetryText}>{headingLabel}</Text>
              </View>
            </View>
            <View style={styles.bottomBar}>
              <View style={styles.shutterOuter}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Take mapped photo"
                  style={[styles.shutter, (!cameraReady || capturing) && styles.shutterDisabled]}
                  onPress={() => void takeMappedPhoto()}
                  disabled={!cameraReady || capturing}
                >
                  {capturing ? <ActivityIndicator /> : null}
                </Pressable>
              </View>
              <Text style={styles.hint}>
                ERIS selects the best fresh GPS fix near shutter time and computes true-north direction from the rear camera axis. Weak GPS or magnetic calibration is retained as uncertainty, not presented as exact evidence.
              </Text>
            </View>
          </SafeAreaView>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  topBar: { paddingHorizontal: 16, paddingTop: 8, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  closeButton: { backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  closeText: { color: "#fff", fontWeight: "700" },
  telemetry: { marginLeft: "auto", backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  telemetryText: { color: "#fff", fontSize: 12, fontWeight: "600", textAlign: "right" },
  bottomBar: { alignItems: "center", paddingHorizontal: 24, paddingBottom: 24 },
  shutterOuter: { width: 82, height: 82, borderRadius: 41, borderWidth: 4, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutter: { width: 66, height: 66, borderRadius: 33, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterDisabled: { opacity: 0.55 },
  hint: { marginTop: 12, color: "#fff", fontSize: 11, textAlign: "center", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9 },
  permissionPane: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  permissionTitle: { color: "#fff", fontSize: 20, fontWeight: "800" },
  permissionText: { color: "#d1d5db", marginTop: 8, textAlign: "center" },
  permissionButton: { marginTop: 18, backgroundColor: "#2563eb", paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10 },
  permissionButtonText: { color: "#fff", fontWeight: "800" },
});
