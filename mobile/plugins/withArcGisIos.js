const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");
const { withBuildSourceFile } = require("@expo/config-plugins/build/ios/XcodeProjectFile");

const ARC_GIS_POD = "pod 'ArcGIS-Runtime-SDK-iOS', '100.15.6'";

const IOS_FILES = [
  "ArcGisModule.h",
  "ArcGisModule.m",
  "ArcGisSketchStore.h",
  "ArcGisSketchStore.m",
  "ArcGisSketchViewController.h",
  "ArcGisSketchViewController.m",
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
    // Fallback: append to file if target block is not found.
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

module.exports = function withArcGisIos(config) {
  let next = withArcGisIosPod(config);
  next = withArcGisIosSources(next);
  return next;
};
