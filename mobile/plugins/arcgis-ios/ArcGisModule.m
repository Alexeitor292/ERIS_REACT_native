#import "ArcGisModule.h"

#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

#import "ArcGisSketchStore.h"
#import "ArcGisSketchViewController.h"

@implementation ArcGisModule

RCT_EXPORT_MODULE(ArcGis)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

RCT_REMAP_METHOD(loadMmpk,
                 loadMmpk:(NSString *)path
                 resolverLoadMmpk:(RCTPromiseResolveBlock)resolve
                 rejecterLoadMmpk:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setMmpkPath:path];
  resolve(nil);
}

RCT_REMAP_METHOD(setInitialLocation,
                 setInitialLocation:(nonnull NSNumber *)latitude
                 longitude:(nonnull NSNumber *)longitude
                 resolverSetInitialLocation:(RCTPromiseResolveBlock)resolve
                 rejecterSetInitialLocation:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setInitialLatitude:latitude];
  [ArcGisSketchStore setInitialLongitude:longitude];
  resolve(nil);
}

RCT_REMAP_METHOD(setInitialGeometry,
                 setInitialGeometry:(NSString *)esriJson
                 resolverSetInitialGeometry:(RCTPromiseResolveBlock)resolve
                 rejecterSetInitialGeometry:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setInitialEsriJson:esriJson];
  resolve(nil);
}

RCT_REMAP_METHOD(startSketchPolygon,
                 startSketchPolygonWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterStartSketch:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *root = RCTPresentedViewController();
    if (root == nil) {
      reject(@"E_START_SKETCH", @"No active view controller.", nil);
      return;
    }

    ArcGisSketchViewController *vc = [[ArcGisSketchViewController alloc] init];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
    [root presentViewController:nav animated:YES completion:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(getSketchGeoJson,
                 getSketchGeoJsonWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterGetSketch:(RCTPromiseRejectBlock)reject) {
  NSString *json = [ArcGisSketchStore latestGeoJson];
  if (json == nil || json.length == 0) {
    reject(@"E_NO_SKETCH", @"No sketch geometry found. Draw and save a sketch first.", nil);
    return;
  }
  resolve(json);
}

RCT_REMAP_METHOD(clearSketch,
                 clearSketchWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterClearSketch:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setLatestGeoJson:nil];
  resolve(nil);
}

@end
