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
c("plugins/arcgis-ios/ErisCameraDirectionModule.m", ["CoreMotion","CMAttitudeReferenceFrameXTrueNorthZVertical","const double north = -r.m31;","const double west = -r.m32;","const double east = -west;","atan2(east, north)","CMMagneticFieldCalibrationAccuracyMedium"]);
c("plugins/withArcGisIos.js", ["ErisCameraDirectionModule.h","ErisCameraDirectionModule.m"]);
c("app.json", ["NSMotionUsageDescription"]);
c("src/api/submissions.ts", ["capture_metadata_json","/photo-map"]);
c("src/api/client.ts", [
  "readSitePhotoMapCache",
  "writeSitePhotoMapCache",
  "sitePhotoMapSubmissionId",
  "if (photoMapSubmissionId && opts.token)",
]);
c("src/offline/sitePhotoMapCache.ts", [
  "site_photo_map_payload_v1_",
  "stripEphemeralServerUrls",
  "download_url: _downloadUrl",
  "writeSitePhotoMapCache",
  "readSitePhotoMapCache",
]);
c("src/offline/fieldPhotoMetadata.ts", ["offline_photo_correction_queue_v1","enqueuePhotoCorrectionsForSync","flushQueuedPhotoCorrections","applyQueuedPhotoCorrectionsToPayload"]);
c("src/offline/syncLoop.ts", ["flushQueuedPhotoCorrections"]);
c("src/offline/localAttachmentUris.ts", [
  "draft_local_attachment_uris_",
  "staged-uploads",
  "resolveAvailableLocalAttachmentUri",
  "FileSystem.documentDirectory",
  "FileSystem.getInfoAsync",
  "matches.length !== 1",
]);
c("src/offline/queue.ts", [
  "registerLocalAttachmentUri",
  "const uploaded = await uploadSubmissionAttachment",
  "Number(uploaded?.attachment_id)",
  "registerLocalAttachmentUri(submissionId, attachmentId, payload.file.uri)",
]);
c("src/arcgis/ArcGISNative.ts", [
  "openSitePhotoMap",
  "supportsSitePhotoMap",
  "applyQueuedPhotoCorrectionsToPayload",
  "enqueuePhotoCorrectionsForSync",
  "Promise<string>",
  "resolveAvailableLocalAttachmentUri",
  "preferLocalSitePhotoFiles",
  "download_url: localUri",
  "local_uri: localUri",
]);
c("plugins/arcgis-ios/ArcGisModule.m", ["ErisPhotoMapDidFinishNotification","resultJson","resolve(resultJson)"]);
c("plugins/arcgis-ios/ArcGisPhotoMapViewController.m", [
  "AGSBasemapStyleArcGISImagery",
  "cameraDirectionConeImageWithSize",
  "AGSPictureMarkerSymbol",
  "AGSSymbolAngleAlignmentMap",
  "heading_reference",
  "TRUE_NORTH",
  "cone.angle = (float)normalized",
  "heading_cone",
  "startLiveLocationDisplay",
  "AGSLocationDisplayAutoPanModeOff",
  "locationDisplay startWithCompletion",
  "identifyGraphicsOverlay",
  "AGSSketchEditor",
  "startWithGeometry",
  "replaceGeometry",
  "Adjust Position & Direction",
  "Reset Position",
  "Reset Direction",
  "headingSlider",
  "captured_metadata",
  "can_edit_correction",
  "ErisPhotoMapDidFinishNotification",
  "download_url",
  "Open Photo",
  "openURL:url",
]);
forbid("plugins/arcgis-ios/ArcGisPhotoMapViewController.m", ["360.0 - normalized","AGSSimpleMarkerSymbolStyleTriangle","arrow.angle = (float)normalized"]);
c("app/(tabs)/submissions/[id].tsx", ["Site Photo Map","MappedPhotoCamera","exif: true","captureMetadata","draft_local_attachment_uris_","registerLocalAttachmentUri"]);
console.log("Site Photo Map source contract: PASS");
