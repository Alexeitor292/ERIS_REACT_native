#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// Native, fully-offline 3D terrain viewer. Opens a locally-downloaded Mobile
// Scene Package (.mspk) into an AGSSceneView (real elevation + local basemap),
// and draws the live ERIS overlays. No network is required once the package is
// downloaded. Params are read from ArcGisSketchStore.offlineSceneParamsJson.
@interface ArcGisTerrainSceneViewController : UIViewController

@end

NS_ASSUME_NONNULL_END
