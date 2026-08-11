import { CameraView, useCameraPermissions, type CameraCapturedPicture } from "expo-camera";
import * as Location from "expo-location";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import {
  mergePhotoCaptureMetadata,
  normalizePhotoHeading,
  photoCaptureMetadataFromAsset,
  photoCaptureMetadataFromDeviceSnapshot,
  type PhotoCaptureMetadata,
} from "../photos/captureMetadata";

export type MappedPhotoCapture = {
  uri: string;
  name: string;
  type: "image/jpeg";
  captureMetadata: PhotoCaptureMetadata | null;
};

type TimedHeading = { value: Location.LocationHeadingObject; observedAt: number };
type TimedPosition = { value: Location.LocationObject; observedAt: number };

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
  const headingRef = useRef<TimedHeading | null>(null);
  const positionRef = useRef<TimedPosition | null>(null);
  const [headingLabel, setHeadingLabel] = useState("Direction acquiring…");
  const [locationLabel, setLocationLabel] = useState("GPS acquiring…");
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCameraReady(false);
      headingRef.current = null;
      positionRef.current = null;
      return;
    }
    if (!cameraPermission?.granted) return;

    let disposed = false;
    let headingSub: Location.LocationSubscription | null = null;
    let positionSub: Location.LocationSubscription | null = null;

    void (async () => {
      const locationPermission = await Location.requestForegroundPermissionsAsync();
      if (!locationPermission.granted || disposed) {
        setLocationLabel("GPS unavailable • photo may be unmapped");
        setHeadingLabel("Direction unavailable");
        return;
      }
      if (!(await Location.hasServicesEnabledAsync()) || disposed) {
        setLocationLabel("Location services disabled");
        setHeadingLabel("Direction unavailable");
        return;
      }

      try {
        headingSub = await Location.watchHeadingAsync((value) => {
          if (disposed) return;
          headingRef.current = { value, observedAt: Date.now() };
          const selected = value.trueHeading >= 0 ? value.trueHeading : value.magHeading;
          const normalized = normalizePhotoHeading(selected);
          setHeadingLabel(normalized == null ? "Direction unavailable" : `Camera direction ${Math.round(normalized)}°`);
        });
      } catch {
        setHeadingLabel("Direction unavailable");
      }

      try {
        positionSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Highest, timeInterval: 1000, distanceInterval: 0 },
          (value) => {
            if (disposed) return;
            positionRef.current = { value, observedAt: Date.now() };
            const accuracy = value.coords.accuracy;
            setLocationLabel(accuracy != null ? `GPS ±${Math.round(accuracy)} m` : "GPS ready");
          },
        );
      } catch {
        setLocationLabel("GPS unavailable • photo may be unmapped");
      }
    })();

    return () => {
      disposed = true;
      headingSub?.remove();
      positionSub?.remove();
    };
  }, [cameraPermission?.granted, visible]);

  async function takeMappedPhoto() {
    if (!cameraReady || !cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const shutterAtMs = Date.now();
      const capturedAt = new Date(shutterAtMs).toISOString();
      const headingTimed = headingRef.current;
      const headingAtShutter =
        headingTimed && shutterAtMs - headingTimed.observedAt <= 3000 && headingTimed.value.accuracy >= 1
          ? headingTimed.value
          : null;
      const positionTimed = positionRef.current;
      const positionAtShutter =
        positionTimed && shutterAtMs - positionTimed.observedAt <= 5000 ? positionTimed.value : null;

      const picture = await cameraRef.current.takePictureAsync({ quality: 0.9, exif: true });
      if (!picture?.uri) throw new Error("Camera did not return an image file.");

      const deviceMetadata = photoCaptureMetadataFromDeviceSnapshot({
        capturedAt,
        position: positionAtShutter,
        heading: headingAtShutter,
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
                Heading is sampled at shutter press. Stale direction is discarded instead of drawing a misleading arrow.
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
