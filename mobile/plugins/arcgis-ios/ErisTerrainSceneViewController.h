#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// Native, fully-offline 3D terrain viewer for the ERIS 'eristerrain' bundle
// (auto-generated from USGS 3DEP). Builds a SceneKit terrain mesh from the local
// height grid and drapes the local hillshade as the texture. No ArcGIS Runtime
// and no network are used. Params (extractedDir, incident, overlays, version) are
// read from ArcGisSketchStore.offlineSceneParamsJson.
@interface ErisTerrainSceneViewController : UIViewController

@end

NS_ASSUME_NONNULL_END
