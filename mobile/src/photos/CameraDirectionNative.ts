import { NativeModules, Platform } from "react-native";

export type CameraDirectionSample = {
  heading: number;
  accuracyCode: number;
  headingReference: "TRUE_NORTH";
  sampleAgeMs: number;
  cameraElevationDeg: number;
  horizontalProjection: number;
};

type CameraDirectionNativeModule = {
  startTracking(): Promise<void>;
  getDirection(): Promise<CameraDirectionSample>;
  stopTracking(): Promise<void>;
};

const { ErisCameraDirection } = NativeModules as {
  ErisCameraDirection?: CameraDirectionNativeModule;
};

export function supportsNativeCameraDirection(): boolean {
  return Platform.OS === "ios" && !!ErisCameraDirection;
}

export async function startNativeCameraDirection(): Promise<void> {
  if (!ErisCameraDirection) throw new Error("Native camera-direction module is unavailable in this build.");
  await ErisCameraDirection.startTracking();
}

export async function readNativeCameraDirection(): Promise<CameraDirectionSample> {
  if (!ErisCameraDirection) throw new Error("Native camera-direction module is unavailable in this build.");
  return ErisCameraDirection.getDirection();
}

export async function stopNativeCameraDirection(): Promise<void> {
  if (!ErisCameraDirection) return;
  await ErisCameraDirection.stopTracking();
}
