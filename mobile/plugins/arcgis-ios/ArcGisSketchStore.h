#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArcGisSketchStore : NSObject

+ (nullable NSString *)latestGeoJson;
+ (void)setLatestGeoJson:(nullable NSString *)value;

+ (nullable NSString *)mmpkPath;
+ (void)setMmpkPath:(nullable NSString *)value;

+ (nullable NSString *)initialEsriJson;
+ (void)setInitialEsriJson:(nullable NSString *)value;

+ (nullable NSNumber *)initialLatitude;
+ (void)setInitialLatitude:(nullable NSNumber *)value;

+ (nullable NSNumber *)initialLongitude;
+ (void)setInitialLongitude:(nullable NSNumber *)value;

+ (nullable NSString *)missionIncidentsJson;
+ (void)setMissionIncidentsJson:(nullable NSString *)value;

+ (nullable NSString *)latestSketchImagePath;
+ (void)setLatestSketchImagePath:(nullable NSString *)value;

// Params JSON for the native offline 3D terrain SceneView (see
// OpenOfflineSceneParams in ArcGISNative.ts): packagePath, incident lat/lon,
// uploaded geometry, road bearing, sample extent, version/age/size.
+ (nullable NSString *)offlineSceneParamsJson;
+ (void)setOfflineSceneParamsJson:(nullable NSString *)value;

@end

NS_ASSUME_NONNULL_END
