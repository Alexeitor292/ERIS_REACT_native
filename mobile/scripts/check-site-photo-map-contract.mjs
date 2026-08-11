import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function c(file, needles) { const source=text(file); for (const needle of needles) if(!source.includes(needle)) throw new Error(`${file} missing ${needle}`); }
function forbid(file, needles) { const source=text(file); for (const needle of needles) if(source.includes(needle)) throw new Error(`${file} contains forbidden ${needle}`); }
c("src/photos/captureMetadata.ts", ["DEVICE_AT_CAPTURE","MAX_MAPPED_PHOTO_ACCURACY_M = 20","MIN_MAPPED_HEADING_ACCURACY_CODE = 2","CameraDirectionSnapshot","DEVICE_TRUE_HEADING"]);
c("src/photos/CameraDirectionNative.ts", ["ErisCameraDirection","startTracking","getDirection","TRUE_NORTH"]);
c("src/components/MappedPhotoCamera.tsx", ["CameraView","BestForNavigation","bestFreshPosition","readNativeCameraDirection","Rear camera","POSITION_WINDOW_MS = 3000"]);
forbid("src/components/MappedPhotoCamera.tsx", ["watchHeadingAsync"]);
c("plugins/arcgis-ios/ErisCameraDirectionModule.m", ["CoreMotion","CMAttitudeReferenceFrameXTrueNorthZVertical","Rear camera looks","atan2(east, north)","CMMagneticFieldCalibrationAccuracyMedium"]);
c("plugins/withArcGisIos.js", ["ErisCameraDirectionModule.h","ErisCameraDirectionModule.m"]);
c("app.json", ["NSMotionUsageDescription"]);
c("src/api/submissions.ts", ["capture_metadata_json","/photo-map"]);
c("src/arcgis/ArcGISNative.ts", ["openSitePhotoMap","supportsSitePhotoMap"]);
c("plugins/arcgis-ios/ArcGisPhotoMapViewController.m", ["AGSBasemapStyleArcGISImagery","AGSSymbolAngleAlignmentMap","heading_reference","TRUE_NORTH","arrow.angle = (float)normalized","identifyGraphicsOverlay"]);
forbid("plugins/arcgis-ios/ArcGisPhotoMapViewController.m", ["360.0 - normalized"]);
c("app/(tabs)/submissions/[id].tsx", ["Site Photo Map","MappedPhotoCamera","exif: true","captureMetadata"]);
console.log("Site Photo Map source contract: PASS");
