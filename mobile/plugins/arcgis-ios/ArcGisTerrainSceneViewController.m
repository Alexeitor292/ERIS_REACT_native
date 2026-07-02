#import "ArcGisTerrainSceneViewController.h"

#import <ArcGIS/ArcGIS.h>

#import "ArcGisSketchStore.h"

// Native offline 3D terrain SceneView.
//
// Loads a locally-downloaded .mspk (AGSMobileScenePackage) into an AGSSceneView
// so terrain (real elevation), imagery/basemap, and the scene render entirely
// from local data — no network after download. Operational overlays (incident
// marker, uploaded geometry, road bearing, terrain sample extent) are drawn from
// params, only when real data exists, and are NOT baked into the package.
@interface ArcGisTerrainSceneViewController ()

@property(nonatomic, strong) AGSSceneView *sceneView;
@property(nonatomic, strong) AGSGraphicsOverlay *overlay;
@property(nonatomic, strong) AGSMobileScenePackage *scenePackage;
@property(nonatomic, assign) double incidentLat;
@property(nonatomic, assign) double incidentLon;
@property(nonatomic, assign) BOOL hasIncident;
@property(nonatomic, strong) UILabel *statusLabel;

@end

@implementation ArcGisTerrainSceneViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"3D Terrain (offline)";

  self.sceneView = [[AGSSceneView alloc] initWithFrame:CGRectZero];
  self.sceneView.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:self.sceneView];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.sceneView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
    [self.sceneView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.sceneView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [self.sceneView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
  ]];

  self.overlay = [[AGSGraphicsOverlay alloc] init];
  AGSLayerSceneProperties *props =
      [AGSLayerSceneProperties layerScenePropertiesWithSurfacePlacement:AGSSurfacePlacementDrapedFlat];
  self.overlay.sceneProperties = props;
  [self.sceneView.graphicsOverlays addObject:self.overlay];

  // Offline status pill (package age/version/size).
  self.statusLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.statusLabel.numberOfLines = 2;
  self.statusLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
  self.statusLabel.textColor = [UIColor whiteColor];
  self.statusLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.55];
  self.statusLabel.textAlignment = NSTextAlignmentLeft;
  self.statusLabel.layer.cornerRadius = 6;
  self.statusLabel.clipsToBounds = YES;
  [self.view addSubview:self.statusLabel];
  [NSLayoutConstraint activateConstraints:@[
    [self.statusLabel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:10],
    [self.statusLabel.topAnchor constraintEqualToAnchor:guide.topAnchor constant:10],
    [self.statusLabel.widthAnchor constraintLessThanOrEqualToAnchor:guide.widthAnchor multiplier:0.62],
  ]];

  // Controls: Close, Reset-to-incident (home), North reset (compass).
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Close" style:UIBarButtonItemStyleDone
                                      target:self action:@selector(onClose)];
  self.navigationItem.leftBarButtonItems = @[
    [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain
                                    target:self action:@selector(resetToIncident)],
    [[UIBarButtonItem alloc] initWithTitle:@"North" style:UIBarButtonItemStylePlain
                                    target:self action:@selector(resetNorth)],
  ];

  [self loadFromParams];
}

- (void)onClose {
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (NSDictionary *)params {
  NSString *raw = [ArcGisSketchStore offlineSceneParamsJson];
  if (raw == nil || raw.length == 0) return @{};
  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding]
                                              options:0 error:&err];
  return [parsed isKindOfClass:[NSDictionary class]] ? (NSDictionary *)parsed : @{};
}

- (void)loadFromParams {
  NSDictionary *p = [self params];

  NSDictionary *incident = [p[@"incident"] isKindOfClass:[NSDictionary class]] ? p[@"incident"] : nil;
  if (incident != nil) {
    NSNumber *lat = incident[@"lat"];
    NSNumber *lon = incident[@"lon"];
    if ([lat isKindOfClass:[NSNumber class]] && [lon isKindOfClass:[NSNumber class]]) {
      self.incidentLat = lat.doubleValue;
      self.incidentLon = lon.doubleValue;
      self.hasIncident = YES;
    }
  }

  NSString *packagePath = [p[@"packagePath"] isKindOfClass:[NSString class]] ? p[@"packagePath"] : nil;
  [self updateStatusLabelWithParams:p];

  if (packagePath == nil || packagePath.length == 0 ||
      ![[NSFileManager defaultManager] fileExistsAtPath:packagePath]) {
    [self showFatal:@"No offline package found on this device. Download the 3D area first."];
    return;
  }

  self.scenePackage = [[AGSMobileScenePackage alloc] initWithFileURL:[NSURL fileURLWithPath:packagePath]];
  __weak typeof(self) weakSelf = self;
  [self.scenePackage loadWithCompletion:^(NSError *_Nullable error) {
    typeof(self) strongSelf = weakSelf;
    if (strongSelf == nil) return;
    if (error != nil || strongSelf.scenePackage.scenes.count == 0) {
      [strongSelf showFatal:@"This offline package could not be opened. Delete and re-download the 3D area."];
      return;
    }
    AGSScene *scene = strongSelf.scenePackage.scenes.firstObject;
    strongSelf.sceneView.scene = scene;
    [strongSelf renderOverlaysWithParams:[strongSelf params]];
    [strongSelf resetToIncident];
  }];
}

- (void)updateStatusLabelWithParams:(NSDictionary *)p {
  NSString *version = [p[@"packageVersion"] isKindOfClass:[NSString class]] ? p[@"packageVersion"] : @"—";
  NSString *downloadedAt = [p[@"downloadedAt"] isKindOfClass:[NSString class]] ? p[@"downloadedAt"] : nil;
  NSNumber *sizeBytes = [p[@"sizeBytes"] isKindOfClass:[NSNumber class]] ? p[@"sizeBytes"] : @0;
  double mb = sizeBytes.doubleValue / (1024.0 * 1024.0);
  NSString *when = downloadedAt != nil ? [downloadedAt substringToIndex:MIN((NSUInteger)10, downloadedAt.length)] : @"—";
  self.statusLabel.text = [NSString stringWithFormat:@"  Offline package · v%@\n  %.0f MB · downloaded %@  ", version, mb, when];
}

- (AGSGraphic *)pointGraphicAtLat:(double)lat lon:(double)lon color:(UIColor *)color size:(CGFloat)size {
  AGSPoint *pt = [AGSPoint pointWithX:lon y:lat spatialReference:AGSSpatialReference.WGS84];
  AGSSimpleMarkerSymbol *sym = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleCircle
                                                                       color:color size:size];
  sym.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:[UIColor whiteColor] width:2];
  return [[AGSGraphic alloc] initWithGeometry:pt symbol:sym attributes:nil];
}

// ArcGIS Runtime 100.15 multipart geometries are IMMUTABLE and are constructed
// with the geometry BUILDER classes (AGSPolylineBuilder / AGSPolygonBuilder, base
// AGSMultipartBuilder) via -addPointWithX:y: then -toGeometry. The immutable
// geometry / point-collection classes have no mutating add-or-init constructors
// in 100.15 (using them was the EAS compile failure this replaced). All overlays
// are WGS84; `pairs` are [lon, lat] arrays (GeoJSON order). Returns nil for
// undersized/degenerate input so callers render nothing (never crash).

- (nullable AGSPolyline *)polylineFromLonLatPairs:(NSArray *)pairs {
  if (![pairs isKindOfClass:[NSArray class]]) return nil;
  AGSPolylineBuilder *builder = [[AGSPolylineBuilder alloc] initWithSpatialReference:AGSSpatialReference.WGS84];
  NSUInteger n = 0;
  for (id pair in pairs) {
    if ([pair isKindOfClass:[NSArray class]] && [(NSArray *)pair count] >= 2) {
      [builder addPointWithX:[pair[0] doubleValue] y:[pair[1] doubleValue]];
      n++;
    }
  }
  return n >= 2 ? [builder toGeometry] : nil;  // a line needs >= 2 vertices
}

- (nullable AGSPolygon *)polygonFromLonLatPairs:(NSArray *)pairs {
  if (![pairs isKindOfClass:[NSArray class]]) return nil;
  AGSPolygonBuilder *builder = [[AGSPolygonBuilder alloc] initWithSpatialReference:AGSSpatialReference.WGS84];
  NSUInteger n = 0;
  for (id pair in pairs) {
    if ([pair isKindOfClass:[NSArray class]] && [(NSArray *)pair count] >= 2) {
      [builder addPointWithX:[pair[0] doubleValue] y:[pair[1] doubleValue]];
      n++;
    }
  }
  return n >= 3 ? [builder toGeometry] : nil;  // a polygon ring needs >= 3 vertices
}

- (void)renderOverlaysWithParams:(NSDictionary *)p {
  [self.overlay.graphics removeAllObjects];

  // Incident marker (only with a real incident location).
  if (self.hasIncident) {
    UIColor *blue = [UIColor colorWithRed:0.14 green:0.39 blue:0.92 alpha:0.95];
    [self.overlay.graphics addObject:[self pointGraphicAtLat:self.incidentLat lon:self.incidentLon color:blue size:14]];
  }

  // Road bearing direction — ONLY when a real bearing exists (no fake road).
  id bearingObj = p[@"roadBearingDeg"];
  if (self.hasIncident && [bearingObj isKindOfClass:[NSNumber class]]) {
    double bearing = ((NSNumber *)bearingObj).doubleValue;
    double halfLenM = 130.0;
    double rad = bearing * M_PI / 180.0;
    double dLat = (cos(rad) * halfLenM) / 111320.0;
    double cosLat = cos(self.incidentLat * M_PI / 180.0);
    if (fabs(cosLat) < 1e-6) cosLat = 1e-6;
    double dLon = (sin(rad) * halfLenM) / (111320.0 * cosLat);
    AGSPolyline *line = [self polylineFromLonLatPairs:@[
      @[@(self.incidentLon - dLon), @(self.incidentLat - dLat)],
      @[@(self.incidentLon + dLon), @(self.incidentLat + dLat)],
    ]];
    if (line != nil) {
      AGSSimpleLineSymbol *ls = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                     color:[UIColor colorWithRed:0.98 green:0.80 blue:0.13 alpha:0.95] width:3];
      [self.overlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:line symbol:ls attributes:nil]];
    }
  }

  // Terrain sample extent (only when present).
  id ext = p[@"sampleExtent"];
  if ([ext isKindOfClass:[NSDictionary class]]) {
    NSDictionary *e = (NSDictionary *)ext;
    NSNumber *minLat = e[@"minLat"], *minLon = e[@"minLon"], *maxLat = e[@"maxLat"], *maxLon = e[@"maxLon"];
    if ([minLat isKindOfClass:[NSNumber class]] && [minLon isKindOfClass:[NSNumber class]] &&
        [maxLat isKindOfClass:[NSNumber class]] && [maxLon isKindOfClass:[NSNumber class]]) {
      AGSPolygon *poly = [self polygonFromLonLatPairs:@[
        @[@(minLon.doubleValue), @(minLat.doubleValue)],
        @[@(maxLon.doubleValue), @(minLat.doubleValue)],
        @[@(maxLon.doubleValue), @(maxLat.doubleValue)],
        @[@(minLon.doubleValue), @(maxLat.doubleValue)],
      ]];
      if (poly != nil) {
        AGSSimpleLineSymbol *outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                            color:[UIColor colorWithRed:0.22 green:0.74 blue:0.97 alpha:0.9] width:1.5];
        AGSSimpleFillSymbol *fill = [[AGSSimpleFillSymbol alloc] initWithStyle:AGSSimpleFillSymbolStyleSolid
                                                                         color:[UIColor colorWithRed:0.22 green:0.74 blue:0.97 alpha:0.08] outline:outline];
        [self.overlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:poly symbol:fill attributes:nil]];
      }
    }
  }

  // Uploaded incident geometry (GeoJSON point/line/polygon), when present.
  id geom = p[@"geometry"];
  if ([geom isKindOfClass:[NSDictionary class]]) {
    [self renderGeoJson:(NSDictionary *)geom];
  }
}

- (void)renderGeoJson:(NSDictionary *)g {
  NSString *type = [g[@"type"] isKindOfClass:[NSString class]] ? [g[@"type"] lowercaseString] : nil;
  id coords = g[@"coordinates"];
  if (type == nil || coords == nil) return;

  if ([type isEqualToString:@"point"] && [coords isKindOfClass:[NSArray class]] && [(NSArray *)coords count] >= 2) {
    NSArray *c = (NSArray *)coords;
    UIColor *blue = [UIColor colorWithRed:0.08 green:0.36 blue:0.80 alpha:0.92];
    [self.overlay.graphics addObject:[self pointGraphicAtLat:[c[1] doubleValue] lon:[c[0] doubleValue] color:blue size:10]];
  } else if ([type isEqualToString:@"linestring"] && [coords isKindOfClass:[NSArray class]]) {
    AGSPolyline *line = [self polylineFromLonLatPairs:(NSArray *)coords];
    if (line != nil) {
      AGSSimpleLineSymbol *ls = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                     color:[UIColor colorWithRed:0.08 green:0.36 blue:0.80 alpha:0.95] width:3];
      [self.overlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:line symbol:ls attributes:nil]];
    }
  } else if ([type isEqualToString:@"polygon"] && [coords isKindOfClass:[NSArray class]] && [(NSArray *)coords count] > 0) {
    NSArray *ringArr = [(NSArray *)coords firstObject];
    AGSPolygon *poly = [self polygonFromLonLatPairs:ringArr];
    if (poly != nil) {
      AGSSimpleLineSymbol *outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                          color:[UIColor colorWithRed:0.86 green:0.15 blue:0.15 alpha:0.95] width:2];
      AGSSimpleFillSymbol *fill = [[AGSSimpleFillSymbol alloc] initWithStyle:AGSSimpleFillSymbolStyleSolid
                                                                       color:[UIColor colorWithRed:0.86 green:0.15 blue:0.15 alpha:0.14] outline:outline];
      [self.overlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:poly symbol:fill attributes:nil]];
    }
  }
}

// Reset-to-incident: oblique (tilted, not overhead) camera framed on the incident.
- (void)resetToIncident {
  if (!self.hasIncident) return;
  AGSPoint *center = [AGSPoint pointWithX:self.incidentLon y:self.incidentLat spatialReference:AGSSpatialReference.WGS84];
  AGSCamera *camera = [[AGSCamera alloc] initWithLookAtPoint:center
                                                   distance:1200.0
                                                    heading:0.0
                                                      pitch:65.0
                                                       roll:0.0];
  [self.sceneView setViewpointCamera:camera duration:0.8 completion:nil];
}

// North reset: keep position/pitch, set heading to 0.
- (void)resetNorth {
  AGSCamera *current = self.sceneView.currentViewpointCamera;
  if (current == nil) {
    [self resetToIncident];
    return;
  }
  AGSCamera *north = [[AGSCamera alloc] initWithLocation:current.location
                                                 heading:0.0
                                                   pitch:current.pitch
                                                    roll:current.roll];
  [self.sceneView setViewpointCamera:north duration:0.5 completion:nil];
}

- (void)showFatal:(NSString *)message {
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectZero];
  label.translatesAutoresizingMaskIntoConstraints = NO;
  label.numberOfLines = 0;
  label.textAlignment = NSTextAlignmentCenter;
  label.textColor = [UIColor whiteColor];
  label.font = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
  label.text = message;
  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [label.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:32],
    [label.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-32],
  ]];
}

@end
