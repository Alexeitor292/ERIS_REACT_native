#import "ArcGisSketchStore.h"

@implementation ArcGisSketchStore

static NSString *_latestGeoJson = nil;
static NSString *_mmpkPath = nil;
static NSString *_initialEsriJson = nil;
static NSNumber *_initialLatitude = nil;
static NSNumber *_initialLongitude = nil;
static NSString *_missionIncidentsJson = nil;
static NSString *_latestSketchImagePath = nil;
static NSString *_offlineSceneParamsJson = nil;

+ (NSString *)latestGeoJson {
  return _latestGeoJson;
}

+ (void)setLatestGeoJson:(NSString *)value {
  _latestGeoJson = value;
}

+ (NSString *)mmpkPath {
  return _mmpkPath;
}

+ (void)setMmpkPath:(NSString *)value {
  _mmpkPath = value;
}

+ (NSString *)initialEsriJson {
  return _initialEsriJson;
}

+ (void)setInitialEsriJson:(NSString *)value {
  _initialEsriJson = value;
}

+ (NSNumber *)initialLatitude {
  return _initialLatitude;
}

+ (void)setInitialLatitude:(NSNumber *)value {
  _initialLatitude = value;
}

+ (NSNumber *)initialLongitude {
  return _initialLongitude;
}

+ (void)setInitialLongitude:(NSNumber *)value {
  _initialLongitude = value;
}

+ (NSString *)missionIncidentsJson {
  return _missionIncidentsJson;
}

+ (void)setMissionIncidentsJson:(NSString *)value {
  _missionIncidentsJson = value;
}

+ (NSString *)latestSketchImagePath {
  return _latestSketchImagePath;
}

+ (void)setLatestSketchImagePath:(NSString *)value {
  _latestSketchImagePath = value;
}

+ (NSString *)offlineSceneParamsJson {
  return _offlineSceneParamsJson;
}

+ (void)setOfflineSceneParamsJson:(NSString *)value {
  _offlineSceneParamsJson = value;
}

@end
