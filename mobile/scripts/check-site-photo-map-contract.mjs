import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
function c(file, needles) { const text=fs.readFileSync(path.join(root,file),"utf8"); for (const needle of needles) if(!text.includes(needle)) throw new Error(`${file} missing ${needle}`); }
c("src/photos/captureMetadata.ts", ["DEVICE_AT_CAPTURE","EXIF_GPS_IMG_DIRECTION","photoCaptureMetadataFromDeviceSnapshot"]);
c("src/components/MappedPhotoCamera.tsx", ["CameraView","watchHeadingAsync","observedAt","takePictureAsync","3000"]);
c("src/api/submissions.ts", ["capture_metadata_json","/photo-map"]);
c("src/arcgis/ArcGISNative.ts", ["openSitePhotoMap","supportsSitePhotoMap"]);
c("plugins/arcgis-ios/ArcGisPhotoMapViewController.m", ["AGSBasemapStyleArcGISImagery","AGSSymbolAngleAlignmentMap","identifyGraphicsOverlay"]);
c("app/(tabs)/submissions/[id].tsx", ["Site Photo Map","MappedPhotoCamera","exif: true","captureMetadata"]);
console.log("Site Photo Map source contract: PASS");
