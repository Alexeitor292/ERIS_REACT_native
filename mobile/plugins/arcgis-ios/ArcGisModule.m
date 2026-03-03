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

RCT_REMAP_METHOD(downloadMmpk,
                 downloadMmpk:(NSString *)urlString
                 resolverDownloadMmpk:(RCTPromiseResolveBlock)resolve
                 rejecterDownloadMmpk:(RCTPromiseRejectBlock)reject) {
  if (urlString == nil || urlString.length == 0) {
    reject(@"E_MMPK_URL", @"MMPK URL is empty.", nil);
    return;
  }
  NSURL *url = [NSURL URLWithString:urlString];
  if (url == nil) {
    reject(@"E_MMPK_URL", @"MMPK URL is invalid.", nil);
    return;
  }

  NSURLSessionDownloadTask *task =
      [[NSURLSession sharedSession] downloadTaskWithURL:url
                                      completionHandler:^(NSURL *_Nullable location,
                                                          NSURLResponse *_Nullable response,
                                                          NSError *_Nullable error) {
    if (error != nil) {
      reject(@"E_MMPK_DOWNLOAD", error.localizedDescription ?: @"Download failed.", error);
      return;
    }

    NSHTTPURLResponse *http = [response isKindOfClass:[NSHTTPURLResponse class]]
                                  ? (NSHTTPURLResponse *)response
                                  : nil;
    if (http != nil && (http.statusCode < 200 || http.statusCode >= 300)) {
      NSString *msg = [NSString stringWithFormat:@"Failed to download MMPK: HTTP %ld", (long)http.statusCode];
      reject(@"E_MMPK_HTTP", msg, nil);
      return;
    }
    if (location == nil) {
      reject(@"E_MMPK_DOWNLOAD", @"No file downloaded.", nil);
      return;
    }

    NSError *fsError = nil;
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *docs = [[fm URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject];
    NSURL *targetDir = [docs URLByAppendingPathComponent:@"arcgis-offline" isDirectory:YES];
    [fm createDirectoryAtURL:targetDir withIntermediateDirectories:YES attributes:nil error:&fsError];
    if (fsError != nil) {
      reject(@"E_MMPK_FS", fsError.localizedDescription ?: @"Could not create target directory.", fsError);
      return;
    }

    NSURL *targetFile = [targetDir URLByAppendingPathComponent:@"offline_map.mmpk"];
    [fm removeItemAtURL:targetFile error:nil];
    if (![fm moveItemAtURL:location toURL:targetFile error:&fsError]) {
      reject(@"E_MMPK_FS", fsError.localizedDescription ?: @"Could not save downloaded MMPK.", fsError);
      return;
    }

    NSString *savedPath = targetFile.path;
    [ArcGisSketchStore setMmpkPath:savedPath];
    resolve(savedPath);
  }];
  [task resume];
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
    __block BOOL didResolve = NO;
    vc.onClose = ^{
      if (didResolve) {
        return;
      }
      didResolve = YES;
      NSLog(@"[ArcGisDebug] startSketchPolygon:onClose resolve");
      resolve(nil);
    };
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
    NSLog(@"[ArcGisDebug] startSketchPolygon:present");
    [root presentViewController:nav animated:YES completion:nil];
  });
}

RCT_REMAP_METHOD(getSketchGeoJson,
                 getSketchGeoJsonWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterGetSketch:(RCTPromiseRejectBlock)reject) {
  NSString *json = [ArcGisSketchStore latestGeoJson];
  NSLog(@"[ArcGisDebug] getSketchGeoJson length=%lu", (unsigned long)(json != nil ? json.length : 0));
  if (json == nil || json.length == 0) {
    reject(@"E_NO_SKETCH", @"No sketch geometry found. Draw and save a sketch first.", nil);
    return;
  }
  resolve(json);
}

RCT_REMAP_METHOD(clearSketch,
                 clearSketchWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterClearSketch:(RCTPromiseRejectBlock)reject) {
  NSLog(@"[ArcGisDebug] clearSketch");
  [ArcGisSketchStore setLatestGeoJson:nil];
  resolve(nil);
}

@end
