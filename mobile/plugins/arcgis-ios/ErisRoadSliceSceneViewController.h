#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// Realistic, fully-offline roadway CROSS-SECTION cutaway (SceneKit). Presented by
// ErisTerrainSceneViewController after the user taps a road in the 3D terrain map.
// It renders a procedural 2.5D roadway/terrain slice looking UPSTATION (LT left, RT
// right): roadway deck (lanes / shoulders / median by category), an elevation-driven
// terrain surface beyond each shoulder sampled from the packaged USGS 3DEP grid, and
// 10/20/50 ft stakes with elevations + deltas. No network, no external textures — all
// geometry comes from the RoadCrossSectionSlice payload and materials are procedural.
//
// `slice` is the RoadCrossSectionSlice dictionary (see roadCrossSectionSlice.ts) built
// natively from the tapped station: road layout (Road Inventory / default) + ground
// elevation samples. Missing/out-of-bounds samples are shown honestly.
@interface ErisRoadSliceSceneViewController : UIViewController

- (instancetype)initWithSlice:(NSDictionary *)slice;

@end

NS_ASSUME_NONNULL_END
