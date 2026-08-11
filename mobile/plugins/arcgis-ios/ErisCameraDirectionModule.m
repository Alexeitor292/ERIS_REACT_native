#import "ErisCameraDirectionModule.h"

#import <CoreMotion/CoreMotion.h>
#import <React/RCTUtils.h>
#import <math.h>

@interface ErisCameraDirectionModule ()
@property(nonatomic, strong) CMMotionManager *motionManager;
@property(nonatomic, strong, nullable) CMDeviceMotion *latestMotion;
@end

@implementation ErisCameraDirectionModule

RCT_EXPORT_MODULE(ErisCameraDirection)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _motionManager = [[CMMotionManager alloc] init];
    _motionManager.deviceMotionUpdateInterval = 1.0 / 30.0;
    _motionManager.showsDeviceMovementDisplay = YES;
  }
  return self;
}

- (NSInteger)accuracyCodeForMotion:(CMDeviceMotion *)motion {
  switch (motion.magneticField.accuracy) {
    case CMMagneticFieldCalibrationAccuracyHigh: return 3;
    case CMMagneticFieldCalibrationAccuracyMedium: return 2;
    case CMMagneticFieldCalibrationAccuracyLow: return 1;
    case CMMagneticFieldCalibrationAccuracyUncalibrated:
    default: return 0;
  }
}

- (nullable NSDictionary *)cameraDirectionForMotion:(CMDeviceMotion *)motion error:(NSString * _Nullable * _Nullable)errorMessage {
  if (motion == nil) {
    if (errorMessage) *errorMessage = @"No Core Motion sample is available yet.";
    return nil;
  }

  NSTimeInterval ageSeconds = NSProcessInfo.processInfo.systemUptime - motion.timestamp;
  if (!isfinite(ageSeconds) || ageSeconds < 0 || ageSeconds > 0.5) {
    if (errorMessage) *errorMessage = @"Core Motion sample is stale.";
    return nil;
  }

  CMRotationMatrix r = motion.attitude.rotationMatrix;

  // Core Motion's attitude matrix is a direction-cosine matrix from the
  // true-north reference frame into device coordinates. The rear camera looks
  // along the device -Z axis. Transpose the DCM to express that optical axis in
  // the reference frame. In XTrueNorthZVertical, +X is north and +Y is west,
  // so east is -Y and compass azimuth is atan2(east, north).
  const double north = -r.m31;
  const double west = -r.m32;
  const double up = -r.m33;
  const double east = -west;
  const double horizontal = hypot(north, east);

  if (!isfinite(horizontal) || horizontal < 0.15) {
    if (errorMessage) *errorMessage = @"Rear camera is pointed too close to vertical for a stable horizontal direction.";
    return nil;
  }

  double heading = atan2(east, north) * 180.0 / M_PI;
  if (heading < 0) heading += 360.0;
  if (heading >= 360.0) heading = fmod(heading, 360.0);

  double elevation = asin(fmax(-1.0, fmin(1.0, up))) * 180.0 / M_PI;
  NSInteger accuracyCode = [self accuracyCodeForMotion:motion];

  return @{
    @"heading": @(heading),
    @"accuracyCode": @(accuracyCode),
    @"headingReference": @"TRUE_NORTH",
    @"sampleAgeMs": @(ageSeconds * 1000.0),
    @"cameraElevationDeg": @(elevation),
    @"horizontalProjection": @(horizontal),
  };
}

RCT_REMAP_METHOD(startTracking,
                 startTrackingWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterStartTracking:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!self.motionManager.deviceMotionAvailable) {
      reject(@"E_CAMERA_DIRECTION_UNAVAILABLE", @"Device Motion is not available on this device.", nil);
      return;
    }

    CMAttitudeReferenceFrame available = [CMMotionManager availableAttitudeReferenceFrames];
    if ((available & CMAttitudeReferenceFrameXTrueNorthZVertical) == 0) {
      reject(@"E_CAMERA_DIRECTION_REFERENCE", @"True-north Core Motion reference frame is unavailable.", nil);
      return;
    }

    self.latestMotion = nil;
    if (self.motionManager.deviceMotionActive) {
      [self.motionManager stopDeviceMotionUpdates];
    }

    __weak typeof(self) weakSelf = self;
    [self.motionManager startDeviceMotionUpdatesUsingReferenceFrame:CMAttitudeReferenceFrameXTrueNorthZVertical
                                                            toQueue:[NSOperationQueue mainQueue]
                                                        withHandler:^(CMDeviceMotion * _Nullable motion, NSError * _Nullable error) {
      if (error != nil || motion == nil) return;
      weakSelf.latestMotion = motion;
    }];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(getDirection,
                 getDirectionWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterGetDirection:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *message = nil;
    NSDictionary *result = [self cameraDirectionForMotion:self.latestMotion error:&message];
    if (result == nil) {
      reject(@"E_CAMERA_DIRECTION_SAMPLE", message ?: @"Camera direction is unavailable.", nil);
      return;
    }
    resolve(result);
  });
}

RCT_REMAP_METHOD(stopTracking,
                 stopTrackingWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecterStopTracking:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.motionManager.deviceMotionActive) {
      [self.motionManager stopDeviceMotionUpdates];
    }
    self.latestMotion = nil;
    resolve(nil);
  });
}

@end
