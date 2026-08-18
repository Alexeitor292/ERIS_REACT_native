const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");
const { withBuildSourceFile } = require("@expo/config-plugins/build/ios/XcodeProjectFile");

const ARC_GIS_POD = "pod 'ArcGIS-Runtime-SDK-iOS', '100.15.6'";

const IOS_FILES = [
  "ArcGisModule.h",
  "ArcGisModule.m",
  "ErisCameraDirectionModule.h",
  "ErisCameraDirectionModule.m",
  "ArcGisPencilSketchViewController.h",
  "ArcGisPencilSketchViewController.m",
  "ArcGisSketchStore.h",
  "ArcGisSketchStore.m",
  "ArcGisSketchViewController.h",
  "ArcGisSketchViewController.m",
  "ArcGisMissionCenterViewController.h",
  "ArcGisMissionCenterViewController.m",
  "ArcGisPhotoMapViewController.h",
  "ArcGisPhotoMapViewController.m",
  "ArcGisTerrainSceneViewController.h",
  "ArcGisTerrainSceneViewController.m",
  "ArcGisEristerrainSceneViewController.h",
  "ArcGisEristerrainSceneViewController.m",
  "ErisTerrainSceneViewController.h",
  "ErisTerrainSceneViewController.m",
  "ErisRoadSliceSceneViewController.h",
  "ErisRoadSliceSceneViewController.m",
  "ErisImmersiveCorridorViewController.h",
  "ErisImmersiveCorridorViewController.m",
  "ErisInspectionViewController.h",
  "ErisInspectionViewController.m",
];

function patchPodfile(podfileContent) {
  if (podfileContent.includes("ArcGIS-Runtime-SDK-iOS")) {
    return podfileContent;
  }

  const lines = podfileContent.split(/\r?\n/);
  const targetLineIndex = lines.findIndex((line) =>
    /^\s*target\s+['"][^'"]+['"]\s+do\s*$/.test(line)
  );

  if (targetLineIndex === -1) {
    return `${podfileContent}\n${ARC_GIS_POD}\n`;
  }

  let insertIndex = targetLineIndex + 1;
  while (
    insertIndex < lines.length &&
    /^\s*(#.*)?$/.test(lines[insertIndex])
  ) {
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, `  ${ARC_GIS_POD}`);
  return `${lines.join("\n")}\n`;
}

function withArcGisIosPod(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const podfilePath = path.join(
        modConfig.modRequest.platformProjectRoot,
        "Podfile"
      );
      if (!fs.existsSync(podfilePath)) {
        return modConfig;
      }
      const current = fs.readFileSync(podfilePath, "utf8");
      const next = patchPodfile(current);
      if (next !== current) {
        fs.writeFileSync(podfilePath, next, "utf8");
      }
      return modConfig;
    },
  ]);
}

function withArcGisIosSources(config) {
  let next = config;
  const templatesRoot = path.join(__dirname, "arcgis-ios");

  for (const fileName of IOS_FILES) {
    const templatePath = path.join(templatesRoot, fileName);
    const contents = fs.readFileSync(templatePath, "utf8");
    next = withBuildSourceFile(next, {
      filePath: fileName,
      contents,
      overwrite: true,
    });
  }

  return next;
}

// ArcGisModule.m is also a source template shared by existing builds. Patch only
// the generated iOS copy after the source-file mod runs so legacy `eristerrain`
// keeps using ErisTerrainSceneViewController, real `.mspk` keeps its existing
// path, and only the new `eristerrain_esri` catalog format uses SceneView+TPKX.
function withEsriTerrainPackageRouting(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const root = modConfig.modRequest.platformProjectRoot;
      const candidates = [];
      const walk = (dir, depth = 0) => {
        if (depth > 3 || !fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p, depth + 1);
          else if (entry.name === "ArcGisModule.m") candidates.push(p);
        }
      };
      walk(root);
      for (const file of candidates) {
        let src = fs.readFileSync(file, "utf8");
        if (!src.includes('#import "ArcGisEristerrainSceneViewController.h"')) {
          src = src.replace(
            '#import "ErisTerrainSceneViewController.h"',
            '#import "ErisTerrainSceneViewController.h"\n#import "ArcGisEristerrainSceneViewController.h"'
          );
        }
        const oldRoute = `if ([format isEqualToString:@"mspk"]) {\n      vc = [[ArcGisTerrainSceneViewController alloc] init];\n    } else {\n      vc = [[ErisTerrainSceneViewController alloc] init];\n    }`;
        const newRoute = `if ([format isEqualToString:@"mspk"]) {\n      vc = [[ArcGisTerrainSceneViewController alloc] init];\n    } else if ([format isEqualToString:@"eristerrain_esri"]) {\n      vc = [[ArcGisEristerrainSceneViewController alloc] init];\n    } else {\n      vc = [[ErisTerrainSceneViewController alloc] init];\n    }`;
        if (src.includes(oldRoute)) src = src.replace(oldRoute, newRoute);
        fs.writeFileSync(file, src, "utf8");
      }
      return modConfig;
    },
  ]);
}

module.exports = function withArcGisIos(config) {
  let next = withArcGisIosPod(config);
  next = withArcGisIosSources(next);
  next = withEsriTerrainPackageRouting(next);
  return next;
};

module.exports.__IOS_SOURCES__ = IOS_FILES.filter((f) => f.endsWith(".m")).map((f) => f.slice(0, -2));
