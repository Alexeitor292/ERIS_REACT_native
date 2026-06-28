#import "ArcGisModule.h"

#import <ArcGIS/ArcGIS.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>

#import "ArcGisSketchStore.h"
#import "ArcGisSketchViewController.h"
#import "ArcGisMissionCenterViewController.h"
#import "ArcGisPencilSketchViewController.h"
#import "ArcGisTerrainSceneViewController.h"
#import "ErisTerrainSceneViewController.h"

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

RCT_REMAP_METHOD(setApiKey,
                 setApiKey:(NSString *)apiKey
                 resolverSetApiKey:(RCTPromiseResolveBlock)resolve
                 rejecterSetApiKey:(RCTPromiseRejectBlock)reject) {
  if (apiKey == nil || apiKey.length == 0) {
    reject(@"E_ARCGIS_API_KEY", @"ArcGIS API key is empty.", nil);
    return;
  }
  [AGSArcGISRuntimeEnvironment setAPIKey:apiKey];
  resolve(nil);
}

RCT_REMAP_METHOD(setLicenseKey,
                 setLicenseKey:(NSString *)licenseKey
                 resolverSetLicenseKey:(RCTPromiseResolveBlock)resolve
                 rejecterSetLicenseKey:(RCTPromiseRejectBlock)reject) {
  if (licenseKey == nil || licenseKey.length == 0) {
    reject(@"E_ARCGIS_LICENSE", @"ArcGIS license key is empty.", nil);
    return;
  }
  NSError *error = nil;
  BOOL ok = [AGSArcGISRuntimeEnvironment setLicenseKey:licenseKey error:&error];
  if (!ok || error != nil) {
    reject(@"E_ARCGIS_LICENSE", error.localizedDescription ?: @"ArcGIS license apply failed.", error);
    return;
  }
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

RCT_REMAP_METHOD(setMissionIncidents,
                 setMissionIncidents:(NSString *)incidentsJson
                 resolverSetMissionIncidents:(RCTPromiseResolveBlock)resolve
                 rejecterSetMissionIncidents:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setMissionIncidentsJson:incidentsJson];
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

RCT_REMAP_METHOD(startMissionCenterMap,
                 startMissionCenterMapWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterStartMissionCenterMap:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *root = RCTPresentedViewController();
    if (root == nil) {
      reject(@"E_START_MISSION_MAP", @"No active view controller.", nil);
      return;
    }

    ArcGisMissionCenterViewController *vc = [[ArcGisMissionCenterViewController alloc] init];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
    [root presentViewController:nav animated:YES completion:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(openOfflineTerrainScene,
                 openOfflineTerrainScene:(NSString *)paramsJson
                 resolverOpenOfflineScene:(RCTPromiseResolveBlock)resolve
                 rejecterOpenOfflineScene:(RCTPromiseRejectBlock)reject) {
  [ArcGisSketchStore setOfflineSceneParamsJson:paramsJson];
  // Route by package format: 'mspk' -> ArcGIS Runtime SceneView; 'eristerrain'
  // (default) -> native SceneKit terrain renderer. An eristerrain bundle is NEVER
  // loaded as an Esri AGSMobileScenePackage.
  NSString *format = @"eristerrain";
  NSData *jd = [paramsJson dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = jd ? [NSJSONSerialization JSONObjectWithData:jd options:0 error:nil] : nil;
  if ([parsed isKindOfClass:[NSDictionary class]]) {
    NSString *f = ((NSDictionary *)parsed)[@"packageFormat"];
    if ([f isKindOfClass:[NSString class]] && f.length > 0) format = f;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *root = RCTPresentedViewController();
    if (root == nil) {
      reject(@"E_OPEN_OFFLINE_SCENE", @"No active view controller.", nil);
      return;
    }
    UIViewController *vc;
    if ([format isEqualToString:@"mspk"]) {
      vc = [[ArcGisTerrainSceneViewController alloc] init];
    } else {
      vc = [[ErisTerrainSceneViewController alloc] init];
    }
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
    [root presentViewController:nav animated:YES completion:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(sha256OfFile,
                 sha256OfFile:(NSString *)path
                 resolverSha256:(RCTPromiseResolveBlock)resolve
                 rejecterSha256:(RCTPromiseRejectBlock)reject) {
  if (path == nil || path.length == 0) {
    reject(@"E_SHA256", @"File path is empty.", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSError *err = nil;
    NSFileHandle *fh = [NSFileHandle fileHandleForReadingFromURL:[NSURL fileURLWithPath:path] error:&err];
    if (fh == nil || err != nil) {
      reject(@"E_SHA256", err.localizedDescription ?: @"Could not open file for hashing.", err);
      return;
    }
    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);
    @try {
      while (YES) {
        @autoreleasepool {
          NSData *chunk = [fh readDataOfLength:1024 * 1024];
          if (chunk.length == 0) break;
          CC_SHA256_Update(&ctx, chunk.bytes, (CC_LONG)chunk.length);
        }
      }
    } @finally {
      [fh closeFile];
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &ctx);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
      [hex appendFormat:@"%02x", digest[i]];
    }
    resolve([hex copy]);
  });
}

RCT_REMAP_METHOD(validateScenePackage,
                 validateScenePackage:(NSString *)path
                 resolverValidatePkg:(RCTPromiseResolveBlock)resolve
                 rejecterValidatePkg:(RCTPromiseRejectBlock)reject) {
  if (path == nil || path.length == 0 ||
      ![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    reject(@"E_VALIDATE_PKG", @"Scene package file not found.", nil);
    return;
  }
  AGSMobileScenePackage *pkg = [[AGSMobileScenePackage alloc] initWithFileURL:[NSURL fileURLWithPath:path]];
  [pkg loadWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      reject(@"E_VALIDATE_PKG", error.localizedDescription ?: @"Package failed to load.", error);
      return;
    }
    // A valid offline 3D package must contain at least one usable scene.
    resolve(@(pkg.scenes.count > 0));
  }];
}

RCT_REMAP_METHOD(startPencilSketch,
                 startPencilSketchWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterStartPencilSketch:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *root = RCTPresentedViewController();
    if (root == nil) {
      reject(@"E_START_PENCIL_SKETCH", @"No active view controller.", nil);
      return;
    }

    ArcGisPencilSketchViewController *vc = [[ArcGisPencilSketchViewController alloc] init];
    __block BOOL didResolve = NO;
    vc.onClose = ^{
      if (didResolve) {
        return;
      }
      didResolve = YES;
      resolve(nil);
    };
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
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
  [ArcGisSketchStore setLatestSketchImagePath:nil];
  resolve(nil);
}

RCT_REMAP_METHOD(getSketchImagePath,
                 getSketchImagePathWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterGetSketchImagePath:(RCTPromiseRejectBlock)reject) {
  NSString *path = [ArcGisSketchStore latestSketchImagePath];
  if (path == nil || path.length == 0) {
    reject(@"E_NO_SKETCH_IMAGE", @"No sketch image found. Save a sketch first.", nil);
    return;
  }
  resolve(path);
}

@end
