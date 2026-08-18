#import "ArcGisEristerrainSceneViewController.h"

#import <ArcGIS/ArcGIS.h>
#import "ArcGisSketchStore.h"

static uint16_t ErisU16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t ErisU32(const uint8_t *p) { return (uint32_t)(p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)); }

@interface ArcGisEristerrainSceneViewController ()
@property(nonatomic,strong) AGSSceneView *sceneView;
@property(nonatomic,strong) AGSGraphicsOverlay *overlay;
@property(nonatomic,strong) UILabel *statusLabel;
@property(nonatomic,strong) NSDictionary *payload;
@property(nonatomic,assign) double incidentLat;
@property(nonatomic,assign) double incidentLon;
@end

@implementation ArcGisEristerrainSceneViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = @"Offline 3D Terrain";
  self.view.backgroundColor = UIColor.blackColor;
  self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose target:self action:@selector(closeView)];
  self.navigationItem.rightBarButtonItems = @[
    [[UIBarButtonItem alloc] initWithTitle:@"North" style:UIBarButtonItemStylePlain target:self action:@selector(north)],
    [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain target:self action:@selector(resetCamera)]
  ];

  self.sceneView = [[AGSSceneView alloc] initWithFrame:self.view.bounds];
  self.sceneView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.view addSubview:self.sceneView];

  self.statusLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.statusLabel.textColor = UIColor.whiteColor;
  self.statusLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.72];
  self.statusLabel.font = [UIFont systemFontOfSize:12 weight:UIFontWeightSemibold];
  self.statusLabel.numberOfLines = 2;
  self.statusLabel.textAlignment = NSTextAlignmentCenter;
  self.statusLabel.layer.cornerRadius = 8;
  self.statusLabel.clipsToBounds = YES;
  self.statusLabel.text = @"Loading local Terrain 3D…";
  [self.view addSubview:self.statusLabel];
  [NSLayoutConstraint activateConstraints:@[
    [self.statusLabel.leadingAnchor constraintGreaterThanOrEqualToAnchor:self.view.leadingAnchor constant:16],
    [self.statusLabel.trailingAnchor constraintLessThanOrEqualToAnchor:self.view.trailingAnchor constant:-16],
    [self.statusLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [self.statusLabel.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor constant:-12],
    [self.statusLabel.heightAnchor constraintGreaterThanOrEqualToConstant:34]
  ]];
  [self loadOfflineScene];
}

- (void)closeView { [self dismissViewControllerAnimated:YES completion:nil]; }

- (NSDictionary *)readPayload {
  NSString *json = [ArcGisSketchStore offlineSceneParamsJson];
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id obj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [obj isKindOfClass:NSDictionary.class] ? obj : @{};
}

- (NSURL *)extractTerrainTPKXFromBundle:(NSString *)path version:(NSString *)version error:(NSError **)error {
  NSData *archive = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:error];
  if (!archive) return nil;
  const uint8_t *b = archive.bytes;
  NSUInteger n = archive.length;
  if (n < 22) return nil;

  NSInteger min = (NSInteger)MAX((NSUInteger)0, n > 65557 ? n - 65557 : 0);
  NSInteger eocd = -1;
  for (NSInteger i = (NSInteger)n - 22; i >= min; i--) {
    if (ErisU32(b + i) == 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return nil;
  uint16_t total = ErisU16(b + eocd + 10);
  uint32_t off = ErisU32(b + eocd + 16);
  uint32_t localOffset = 0, size = 0;
  BOOL found = NO;
  for (uint16_t i = 0; i < total && off + 46 <= n; i++) {
    if (ErisU32(b + off) != 0x02014b50) break;
    uint16_t method = ErisU16(b + off + 10);
    uint32_t comp = ErisU32(b + off + 20);
    uint16_t nameLen = ErisU16(b + off + 28);
    uint16_t extraLen = ErisU16(b + off + 30);
    uint16_t commentLen = ErisU16(b + off + 32);
    uint32_t loc = ErisU32(b + off + 42);
    if (off + 46 + nameLen > n) break;
    NSData *nameData = [NSData dataWithBytes:b + off + 46 length:nameLen];
    NSString *name = [[NSString alloc] initWithData:nameData encoding:NSUTF8StringEncoding];
    if ([name isEqualToString:@"esri-terrain.tpkx"] && method == 0) {
      localOffset = loc; size = comp; found = YES; break;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!found || localOffset + 30 > n || ErisU32(b + localOffset) != 0x04034b50) return nil;
  uint16_t localNameLen = ErisU16(b + localOffset + 26);
  uint16_t localExtraLen = ErisU16(b + localOffset + 28);
  NSUInteger start = localOffset + 30 + localNameLen + localExtraLen;
  if (start + size > n || size < 1024) return nil;

  NSURL *cache = [[[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  NSString *safeVersion = version.length ? version : @"current";
  NSURL *dir = [[cache URLByAppendingPathComponent:@"eris-esri-terrain" isDirectory:YES] URLByAppendingPathComponent:safeVersion isDirectory:YES];
  [[NSFileManager defaultManager] createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:error];
  NSURL *target = [dir URLByAppendingPathComponent:@"terrain.tpkx"];
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:target.path error:nil];
  if ([attrs[NSFileSize] unsignedLongLongValue] == size) return target;
  NSData *payload = [archive subdataWithRange:NSMakeRange(start, size)];
  if (![payload writeToURL:target options:NSDataWritingAtomic error:error]) return nil;
  return target;
}

- (void)loadOfflineScene {
  self.payload = [self readPayload];
  NSString *packagePath = [self.payload[@"packagePath"] isKindOfClass:NSString.class] ? self.payload[@"packagePath"] : nil;
  NSString *version = [self.payload[@"packageVersion"] isKindOfClass:NSString.class] ? self.payload[@"packageVersion"] : @"current";
  NSDictionary *center = [self.payload[@"center"] isKindOfClass:NSDictionary.class] ? self.payload[@"center"] : nil;
  self.incidentLat = [center[@"lat"] doubleValue];
  self.incidentLon = [center[@"lon"] doubleValue];
  if (!packagePath.length) { [self fatal:@"Offline package path is missing."]; return; }

  NSError *extractError = nil;
  NSURL *tpkx = [self extractTerrainTPKXFromBundle:packagePath version:version error:&extractError];
  if (!tpkx) { [self fatal:extractError.localizedDescription ?: @"This package does not contain the Esri Terrain 3D tile cache. Re-download the area."]; return; }

  AGSTileCache *cache = [[AGSTileCache alloc] initWithFileURL:tpkx];
  AGSArcGISTiledElevationSource *elevation = [[AGSArcGISTiledElevationSource alloc] initWithTileCache:cache];
  AGSSurface *surface = [AGSSurface surface];
  surface.elevationSources = @[elevation];
  surface.elevationExaggeration = 1.0;

  AGSScene *scene = [[AGSScene alloc] init];
  scene.baseSurface = surface;
  self.overlay = [[AGSGraphicsOverlay alloc] init];
  self.overlay.sceneProperties.surfacePlacement = AGSSurfacePlacementDraped;
  [self.sceneView.graphicsOverlays addObject:self.overlay];
  self.sceneView.scene = scene;

  __weak typeof(self) weakSelf = self;
  [elevation loadWithCompletion:^(NSError * _Nullable error) {
    __strong typeof(weakSelf) self = weakSelf;
    if (!self) return;
    if (error) { [self fatal:error.localizedDescription ?: @"Local Terrain 3D failed to load."]; return; }
    [self drawOperationalOverlays];
    self.statusLabel.text = @"Offline · Esri Terrain 3D · 1.0×";
    [self resetCamera];
  }];
}

- (void)drawOperationalOverlays {
  AGSSpatialReference *wgs = [AGSSpatialReference WGS84];
  if (isfinite(self.incidentLat) && isfinite(self.incidentLon)) {
    AGSPoint *p = [AGSPoint pointWithX:self.incidentLon y:self.incidentLat spatialReference:wgs];
    AGSSimpleMarkerSceneSymbol *s = [AGSSimpleMarkerSceneSymbol simpleMarkerSceneSymbolWithStyle:AGSSimpleMarkerSceneSymbolStyleSphere color:UIColor.systemRedColor height:10 width:10 depth:10 anchorPosition:AGSSymbolAnchorPositionBottom];
    [self.overlay.graphics addObject:[AGSGraphic graphicWithGeometry:p symbol:s attributes:nil]];
  }
  NSNumber *bearing = [self.payload[@"roadBearingDeg"] isKindOfClass:NSNumber.class] ? self.payload[@"roadBearingDeg"] : nil;
  if (bearing && isfinite(self.incidentLat) && isfinite(self.incidentLon)) {
    double rad = bearing.doubleValue * M_PI / 180.0, len = 150.0, mLat = 111320.0;
    double dLat = cos(rad) * len / mLat;
    double dLon = sin(rad) * len / (mLat * MAX(0.05, cos(self.incidentLat * M_PI / 180.0)));
    AGSPolylineBuilder *pb = [[AGSPolylineBuilder alloc] initWithSpatialReference:wgs];
    [pb addPointWithX:self.incidentLon-dLon y:self.incidentLat-dLat];
    [pb addPointWithX:self.incidentLon+dLon y:self.incidentLat+dLat];
    AGSSimpleLineSymbol *ls = [AGSSimpleLineSymbol simpleLineSymbolWithStyle:AGSSimpleLineSymbolStyleSolid color:UIColor.systemYellowColor width:3];
    [self.overlay.graphics addObject:[AGSGraphic graphicWithGeometry:pb.toGeometry symbol:ls attributes:nil]];
  }
}

- (void)resetCamera {
  if (!isfinite(self.incidentLat) || !isfinite(self.incidentLon)) return;
  AGSPoint *target = [AGSPoint pointWithX:self.incidentLon y:self.incidentLat spatialReference:[AGSSpatialReference WGS84]];
  AGSCamera *camera = [AGSCamera cameraLookingAtPoint:target distance:1800 heading:0 pitch:65 roll:0];
  [self.sceneView setViewpointCamera:camera duration:0.35 completion:nil];
}

- (void)north {
  AGSCamera *c = self.sceneView.currentViewpointCamera;
  if (!c) { [self resetCamera]; return; }
  AGSCamera *north = [c rotateToHeading:0 pitch:c.pitch roll:c.roll];
  [self.sceneView setViewpointCamera:north duration:0.25 completion:nil];
}

- (void)fatal:(NSString *)message {
  self.statusLabel.text = message;
  self.statusLabel.backgroundColor = [UIColor colorWithRed:0.65 green:0.08 blue:0.08 alpha:0.88];
}

@end
