#import "ArcGisSketchViewController.h"

#import <ArcGIS/ArcGIS.h>

#import "ArcGisSketchStore.h"

@interface ArcGisSketchViewController ()

@property(nonatomic, strong) AGSMapView *mapView;
@property(nonatomic, strong) AGSSketchEditor *sketchEditor;
@property(nonatomic, strong) AGSGraphicsOverlay *incidentLocationOverlay;
@property(nonatomic, strong) AGSMobileMapPackage *mobileMapPackage;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *undoStack;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *redoStack;
@property(nonatomic, strong) NSArray<NSNumber *> *basemapStyles;
@property(nonatomic, strong) NSArray<NSString *> *basemapTitles;
@property(nonatomic, assign) NSInteger basemapIndex;
@property(nonatomic, strong) UIButton *basemapButton;
@property(nonatomic, assign) BOOL applyingHistory;
@property(nonatomic, assign) BOOL hasObservedGeometry;
@property(nonatomic, assign) BOOL hasNotifiedClose;

@end

@implementation ArcGisSketchViewController

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"";
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Back"
                                       style:UIBarButtonItemStylePlain
                                      target:self
                                      action:@selector(onCancel)];

  AGSBasemap *basemap = [[AGSBasemap alloc] initWithStyle:AGSBasemapStyleArcGISImagery];
  AGSMap *map = [[AGSMap alloc] initWithBasemap:basemap];
  self.mapView = [[AGSMapView alloc] initWithFrame:CGRectZero];
  self.mapView.translatesAutoresizingMaskIntoConstraints = NO;
  self.mapView.map = map;
  [self.view addSubview:self.mapView];

  // The incident/submission seed is a reference location, not the device's GPS
  // position and not editable sketch geometry. Keep it in its own graphics
  // overlay so it remains visible while the blue ArcGIS locationDisplay dot and
  // the red sketch editor are both active.
  self.incidentLocationOverlay = [[AGSGraphicsOverlay alloc] init];
  [self.mapView.graphicsOverlays addObject:self.incidentLocationOverlay];

  self.undoStack = [NSMutableArray array];
  self.redoStack = [NSMutableArray array];
  self.basemapStyles = @[
    @(AGSBasemapStyleArcGISStreets),
    @(AGSBasemapStyleArcGISTopographic),
    @(AGSBasemapStyleArcGISImagery)
  ];
  self.basemapTitles = @[ @"Streets", @"Topographic", @"Imagery" ];
  self.basemapIndex = 2;
  self.applyingHistory = NO;
  self.hasObservedGeometry = NO;
  self.hasNotifiedClose = NO;

  UIButton *zoomInButton = [self overlayButtonWithTitle:@"+" action:@selector(onZoomIn)];
  UIButton *zoomOutButton = [self overlayButtonWithTitle:@"-" action:@selector(onZoomOut)];
  UIButton *homeButton = [self overlayButtonWithTitle:@"Home" action:@selector(onHome)];
  UIButton *myLocationButton = [self overlayButtonWithTitle:@"Locate" action:@selector(onMyLocation)];
  self.basemapButton = [self overlayButtonWithTitle:@"Basemap" action:@selector(onBasemap)];
  UIButton *toolingButton = [self overlayButtonWithTitle:@"Tools" action:@selector(onTooling)];
  UIButton *undoButton = [self overlayButtonWithTitle:@"Undo" action:@selector(onUndo)];
  UIButton *redoButton = [self overlayButtonWithTitle:@"Redo" action:@selector(onRedo)];
  UIButton *clearButton = [self overlayButtonWithTitle:@"Clear" action:@selector(onClear)];
  UIButton *doneButton = [self overlayButtonWithTitle:@"Save" action:@selector(onDone)];

  UIStackView *leftTop = [[UIStackView alloc] initWithArrangedSubviews:@[ zoomInButton, zoomOutButton ]];
  leftTop.translatesAutoresizingMaskIntoConstraints = NO;
  leftTop.axis = UILayoutConstraintAxisVertical;
  leftTop.spacing = 6;
  [self.view addSubview:leftTop];

  UIStackView *leftMid = [[UIStackView alloc] initWithArrangedSubviews:@[ homeButton, myLocationButton ]];
  leftMid.translatesAutoresizingMaskIntoConstraints = NO;
  leftMid.axis = UILayoutConstraintAxisVertical;
  leftMid.spacing = 6;
  [self.view addSubview:leftMid];

  UIStackView *rightTop = [[UIStackView alloc] initWithArrangedSubviews:@[ self.basemapButton, toolingButton ]];
  rightTop.translatesAutoresizingMaskIntoConstraints = NO;
  rightTop.axis = UILayoutConstraintAxisVertical;
  rightTop.spacing = 6;
  [self.view addSubview:rightTop];

  UIStackView *rightBottom = [[UIStackView alloc] initWithArrangedSubviews:@[ undoButton, redoButton, clearButton, doneButton ]];
  rightBottom.translatesAutoresizingMaskIntoConstraints = NO;
  rightBottom.axis = UILayoutConstraintAxisHorizontal;
  rightBottom.spacing = 6;
  [self.view addSubview:rightBottom];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.mapView.topAnchor constraintEqualToAnchor:guide.topAnchor],
    [self.mapView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
    [self.mapView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    [self.mapView.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],

    [leftTop.topAnchor constraintEqualToAnchor:guide.topAnchor constant:10],
    [leftTop.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:10],

    [leftMid.topAnchor constraintEqualToAnchor:leftTop.bottomAnchor constant:40],
    [leftMid.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:10],

    [rightTop.topAnchor constraintEqualToAnchor:guide.topAnchor constant:10],
    [rightTop.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-10],

    [rightBottom.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-10],
    [rightBottom.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor constant:-10],
  ]];

  self.sketchEditor = [[AGSSketchEditor alloc] init];
  [self configureSketchAppearance];
  self.mapView.sketchEditor = self.sketchEditor;
  [self applyOfflineMapPackageIfAvailable];
  [self startLocationDisplay];
  [self.sketchEditor addObserver:self
                      forKeyPath:@"geometry"
                         options:NSKeyValueObservingOptionNew
                         context:nil];
  self.hasObservedGeometry = YES;

  if (![self startEditingExistingGeometry]) {
    [self.sketchEditor startWithCreationMode:AGSSketchCreationModePolygon];
  }
  [self centerFromInitialLocation];
  [self pushCurrentGeometryToUndo];
  [self cacheCurrentSketchGeometry];
}

- (void)applyOfflineMapPackageIfAvailable {
  NSString *rawPath = [[ArcGisSketchStore mmpkPath] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (rawPath == nil || rawPath.length == 0) {
    return;
  }
  BOOL isDir = NO;
  if (![[NSFileManager defaultManager] fileExistsAtPath:rawPath isDirectory:&isDir]) {
    [self toast:@"Offline map package path not found."];
    return;
  }

  NSURL *fileURL = [NSURL fileURLWithPath:rawPath];
  self.mobileMapPackage = [[AGSMobileMapPackage alloc] initWithFileURL:fileURL];
  __weak typeof(self) weakSelf = self;
  [self.mobileMapPackage loadWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      [weakSelf toast:[NSString stringWithFormat:@"Offline map failed: %@", error.localizedDescription ?: @"Unknown error"]];
      return;
    }
    if (weakSelf.mobileMapPackage.maps.count == 0) {
      [weakSelf toast:@"Offline map package has no maps."];
      return;
    }
    AGSMap *offlineMap = weakSelf.mobileMapPackage.maps.firstObject;
    if (offlineMap != nil) {
      weakSelf.mapView.map = offlineMap;
      weakSelf.mapView.sketchEditor = weakSelf.sketchEditor;
      // Loading an MMPK can apply the package's own initial viewpoint after the
      // screen has already centered. Re-assert the field incident reference so
      // the user remains at the expected location and the marker stays visible.
      [weakSelf centerFromInitialLocation];
      [weakSelf toast:@"Offline map package loaded."];
    }
  }];
}

- (UIButton *)overlayButtonWithTitle:(NSString *)title action:(SEL)selector {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setTitle:title forState:UIControlStateNormal];
  button.titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
  [button setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
  button.layer.cornerRadius = 6;
  button.layer.borderWidth = 1;
  button.layer.borderColor = [UIColor colorWithRed:0.20 green:0.23 blue:0.31 alpha:1.0].CGColor;
  button.backgroundColor = [UIColor colorWithRed:0.07 green:0.09 blue:0.12 alpha:0.80];
  button.contentEdgeInsets = UIEdgeInsetsMake(7, 10, 7, 10);
  [button addTarget:self action:selector forControlEvents:UIControlEventTouchUpInside];
  return button;
}

- (void)onTooling {
  UIAlertController *sheet = [UIAlertController alertControllerWithTitle:@"Sketch Tooling"
                                                                 message:nil
                                                          preferredStyle:UIAlertControllerStyleActionSheet];
  __weak typeof(self) weakSelf = self;
  [sheet addAction:[UIAlertAction actionWithTitle:@"Start Polygon"
                                            style:UIAlertActionStyleDefault
                                          handler:^(__unused UIAlertAction *action) {
                                            [weakSelf.sketchEditor startWithCreationMode:AGSSketchCreationModePolygon];
                                          }]];
  [sheet addAction:[UIAlertAction actionWithTitle:@"Clear"
                                            style:UIAlertActionStyleDefault
                                          handler:^(__unused UIAlertAction *action) {
                                            [weakSelf onClear];
                                          }]];
  [sheet addAction:[UIAlertAction actionWithTitle:@"Save + Close"
                                            style:UIAlertActionStyleDefault
                                          handler:^(__unused UIAlertAction *action) {
                                            [weakSelf onDone];
                                          }]];
  [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel"
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  [self presentViewController:sheet animated:YES completion:nil];
}

- (BOOL)startEditingExistingGeometry {
  NSString *raw = [ArcGisSketchStore initialEsriJson];
  if (raw == nil || raw.length == 0) {
    return NO;
  }

  NSError *jsonError = nil;
  NSData *data = [raw dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
  if (jsonError != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    return NO;
  }
  NSDictionary *json = (NSDictionary *)parsed;
  NSArray *rings = json[@"rings"];
  if (![rings isKindOfClass:[NSArray class]] || rings.count == 0) {
    return NO;
  }

  NSError *geomError = nil;
  id<AGSJSONSerializable> jsonSerializable = [AGSGeometry fromJSON:json error:&geomError];
  AGSGeometry *geometry = [jsonSerializable isKindOfClass:[AGSGeometry class]]
                              ? (AGSGeometry *)jsonSerializable
                              : nil;
  if (geomError != nil || geometry == nil) {
    return NO;
  }

  [self.sketchEditor startWithGeometry:geometry];
  [self.mapView setViewpointGeometry:geometry.extent padding:80 completion:nil];
  return YES;
}

- (void)renderIncidentLocationMarkerAtPoint:(AGSPoint *)point {
  if (point == nil || self.incidentLocationOverlay == nil) {
    return;
  }

  [self.incidentLocationOverlay.graphics removeAllObjects];

  // A soft halo makes the incident reference visible on both dark imagery and
  // light street/topographic basemaps without resembling ArcGIS' blue GPS dot.
  UIColor *incidentRed = [UIColor colorWithRed:0.91 green:0.18 blue:0.18 alpha:1.0];
  AGSSimpleMarkerSymbol *halo = [[AGSSimpleMarkerSymbol alloc]
      initWithStyle:AGSSimpleMarkerSymbolStyleCircle
              color:[incidentRed colorWithAlphaComponent:0.20]
               size:30.0];
  halo.outline = [[AGSSimpleLineSymbol alloc]
      initWithStyle:AGSSimpleLineSymbolStyleSolid
              color:[incidentRed colorWithAlphaComponent:0.75]
              width:1.5];

  AGSGraphic *haloGraphic = [[AGSGraphic alloc]
      initWithGeometry:point
                symbol:halo
            attributes:@{ @"kind": @"incident_location" }];
  [self.incidentLocationOverlay.graphics addObject:haloGraphic];

  AGSSimpleMarkerSymbol *marker = [[AGSSimpleMarkerSymbol alloc]
      initWithStyle:AGSSimpleMarkerSymbolStyleDiamond
              color:incidentRed
               size:18.0];
  marker.outline = [[AGSSimpleLineSymbol alloc]
      initWithStyle:AGSSimpleLineSymbolStyleSolid
              color:[UIColor whiteColor]
              width:2.5];

  AGSGraphic *markerGraphic = [[AGSGraphic alloc]
      initWithGeometry:point
                symbol:marker
            attributes:@{ @"kind": @"incident_location", @"title": @"Incident Location" }];
  [self.incidentLocationOverlay.graphics addObject:markerGraphic];
}

- (void)centerFromInitialLocation {
  NSNumber *lat = [ArcGisSketchStore initialLatitude];
  NSNumber *lon = [ArcGisSketchStore initialLongitude];
  if (lat == nil || lon == nil) {
    [self.incidentLocationOverlay.graphics removeAllObjects];
    return;
  }

  double latitude = lat.doubleValue;
  double longitude = lon.doubleValue;
  if (!isfinite(latitude) || !isfinite(longitude) ||
      latitude < -90.0 || latitude > 90.0 ||
      longitude < -180.0 || longitude > 180.0) {
    [self.incidentLocationOverlay.graphics removeAllObjects];
    return;
  }

  AGSPoint *point = [AGSPoint pointWithX:longitude
                                       y:latitude
                         spatialReference:AGSSpatialReference.WGS84];
  [self renderIncidentLocationMarkerAtPoint:point];
  [self.mapView setViewpointCenter:point scale:12000 completion:nil];
}

- (AGSSimpleMarkerSymbol *)vertexMarkerWithSize:(CGFloat)size
                                   outlineColor:(UIColor *)outlineColor
                                    outlineWidth:(CGFloat)outlineWidth {
  AGSSimpleMarkerSymbol *symbol = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleCircle
                                                                         color:[UIColor whiteColor]
                                                                          size:size];
  symbol.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                        color:outlineColor
                                                        width:outlineWidth];
  return symbol;
}

- (UIImage *)circlePlusImageWithSize:(CGFloat)size
                        outlineColor:(UIColor *)outlineColor
                           plusColor:(UIColor *)plusColor
                        outlineWidth:(CGFloat)outlineWidth
                       plusLineWidth:(CGFloat)plusLineWidth {
  UIGraphicsBeginImageContextWithOptions(CGSizeMake(size, size), NO, 0.0);

  CGRect bounds = CGRectMake(0, 0, size, size);
  CGRect circleBounds = CGRectInset(bounds, outlineWidth / 2.0, outlineWidth / 2.0);
  UIBezierPath *circle = [UIBezierPath bezierPathWithOvalInRect:circleBounds];
  [[UIColor whiteColor] setFill];
  [circle fill];
  circle.lineWidth = outlineWidth;
  [outlineColor setStroke];
  [circle stroke];

  CGFloat center = size / 2.0;
  CGFloat inset = MAX(2.0, size * 0.28);
  UIBezierPath *plus = [UIBezierPath bezierPath];
  plus.lineCapStyle = kCGLineCapRound;
  plus.lineWidth = plusLineWidth;
  [plus moveToPoint:CGPointMake(center, inset)];
  [plus addLineToPoint:CGPointMake(center, size - inset)];
  [plus moveToPoint:CGPointMake(inset, center)];
  [plus addLineToPoint:CGPointMake(size - inset, center)];
  [plusColor setStroke];
  [plus stroke];

  UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();
  return image;
}

- (AGSPictureMarkerSymbol *)midVertexMarkerWithSize:(CGFloat)size
                                       outlineColor:(UIColor *)outlineColor
                                          plusColor:(UIColor *)plusColor
                                       outlineWidth:(CGFloat)outlineWidth
                                      plusLineWidth:(CGFloat)plusLineWidth {
  UIImage *image = [self circlePlusImageWithSize:size
                                    outlineColor:outlineColor
                                       plusColor:plusColor
                                    outlineWidth:outlineWidth
                                   plusLineWidth:plusLineWidth];
  AGSPictureMarkerSymbol *symbol = [AGSPictureMarkerSymbol pictureMarkerSymbolWithImage:image];
  symbol.width = size;
  symbol.height = size;
  return symbol;
}

- (void)configureSketchAppearance {
  AGSSketchStyle *style = [[AGSSketchStyle alloc] init];
  UIColor *red = [UIColor colorWithRed:0.84 green:0.15 blue:0.16 alpha:1.0];
  UIColor *selectedRed = [UIColor colorWithRed:0.67 green:0.10 blue:0.11 alpha:1.0];

  AGSSimpleLineSymbol *outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                       color:red
                                                                       width:2.5];
  AGSSimpleFillSymbol *fill = [[AGSSimpleFillSymbol alloc] initWithStyle:AGSSimpleFillSymbolStyleSolid
                                                                    color:[red colorWithAlphaComponent:0.16]
                                                                  outline:outline];
  AGSSimpleMarkerSymbol *vertex = [self vertexMarkerWithSize:12
                                                outlineColor:red
                                                outlineWidth:1.8];
  AGSSimpleMarkerSymbol *selectedVertex = [self vertexMarkerWithSize:14
                                                        outlineColor:selectedRed
                                                        outlineWidth:2.2];
  AGSPictureMarkerSymbol *midVertex = [self midVertexMarkerWithSize:10
                                                       outlineColor:red
                                                          plusColor:red
                                                       outlineWidth:1.4
                                                      plusLineWidth:1.7];
  AGSPictureMarkerSymbol *selectedMidVertex = [self midVertexMarkerWithSize:11
                                                               outlineColor:selectedRed
                                                                  plusColor:selectedRed
                                                               outlineWidth:1.6
                                                              plusLineWidth:1.9];
  AGSSimpleMarkerSymbol *feedbackVertex = [self vertexMarkerWithSize:16
                                                        outlineColor:red
                                                        outlineWidth:2.3];

  style.lineSymbol = outline;
  style.fillSymbol = fill;
  style.vertexSymbol = vertex;
  style.selectedVertexSymbol = selectedVertex;
  style.midVertexSymbol = midVertex;
  style.selectedMidVertexSymbol = selectedMidVertex;
  style.feedbackVertexSymbol = feedbackVertex;
  self.sketchEditor.style = style;
}

- (void)startLocationDisplay {
  self.mapView.locationDisplay.autoPanMode = AGSLocationDisplayAutoPanModeOff;
  [self.mapView.locationDisplay startWithCompletion:^(NSError *_Nullable error) {
    (void)error;
  }];
}

- (void)onBasemap {
  if (self.basemapStyles.count == 0) {
    return;
  }
  self.basemapIndex = (self.basemapIndex + 1) % self.basemapStyles.count;
  AGSBasemapStyle style = (AGSBasemapStyle)self.basemapStyles[self.basemapIndex].integerValue;
  self.mapView.map.basemap = [[AGSBasemap alloc] initWithStyle:style];
  NSString *title = self.basemapTitles[self.basemapIndex];
  [self toast:[NSString stringWithFormat:@"Layer: %@", title]];
}

- (void)onMyLocation {
  AGSPoint *current = self.mapView.locationDisplay.mapLocation;
  if (current != nil) {
    [self.mapView setViewpointCenter:current scale:8000 completion:nil];
    return;
  }
  [self centerFromInitialLocation];
}

- (void)onHome {
  [self centerFromInitialLocation];
}

- (void)onZoomIn {
  double scale = self.mapView.mapScale;
  if (scale > 0) {
    [self.mapView setViewpointScale:(scale * 0.5) completion:nil];
  }
}

- (void)onZoomOut {
  double scale = self.mapView.mapScale;
  if (scale > 0) {
    [self.mapView setViewpointScale:(scale * 2.0) completion:nil];
  }
}

- (void)onClear {
  NSLog(@"[ArcGisDebug] onClear");
  [self.sketchEditor startWithCreationMode:AGSSketchCreationModePolygon];
  [ArcGisSketchStore setLatestGeoJson:nil];
  [self.undoStack removeAllObjects];
  [self.redoStack removeAllObjects];
}

- (void)onUndo {
  if (self.undoStack.count <= 1) {
    return;
  }
  NSDictionary *current = self.undoStack.lastObject;
  if (current != nil) {
    [self.redoStack addObject:current];
  }
  [self.undoStack removeLastObject];
  NSDictionary *previous = self.undoStack.lastObject;
  [self applyHistoryGeometry:previous];
}

- (void)onRedo {
  if (self.redoStack.count == 0) {
    return;
  }
  NSDictionary *next = self.redoStack.lastObject;
  [self.redoStack removeLastObject];
  [self applyHistoryGeometry:next];
  if (next != nil) {
    [self.undoStack addObject:next];
  }
}

- (void)onCancel {
  [self dismissViewControllerAnimated:YES
                           completion:^{
                             [self notifyClosedOnce];
                           }];
}

- (void)onDone {
  NSLog(@"[ArcGisDebug] onDone:start");
  if ([self.sketchEditor respondsToSelector:@selector(stop)]) {
    [self.sketchEditor stop];
  }
  [self cacheCurrentSketchGeometry];
  NSString *json = [ArcGisSketchStore latestGeoJson];
  if ((json == nil || json.length == 0) && self.undoStack.count > 0) {
    NSDictionary *last = self.undoStack.lastObject;
    json = [self geoJsonStringFromSnapshot:last];
    [ArcGisSketchStore setLatestGeoJson:json];
  }
  if (json == nil || json.length == 0) {
    NSLog(@"[ArcGisDebug] onDone:no-geometry");
    [self toast:@"Draw a polygon first."];
    return;
  }
  NSLog(@"[ArcGisDebug] onDone:geometry-length=%lu", (unsigned long)json.length);
  [self dismissViewControllerAnimated:YES
                           completion:^{
                             [self notifyClosedOnce];
                           }];
}

- (void)pushCurrentGeometryToUndo {
  NSDictionary *snapshot = [self sketchGeometrySnapshot];
  NSDictionary *last = self.undoStack.lastObject;
  if ((last == nil && snapshot == nil) || (last != nil && snapshot != nil && [last isEqualToDictionary:snapshot])) {
    return;
  }
  if (snapshot != nil) {
    [self.undoStack addObject:snapshot];
  }
}

- (NSDictionary *)sketchGeometrySnapshot {
  AGSGeometry *geometry = self.sketchEditor.geometry;
  if (geometry == nil) {
    return nil;
  }
  NSError *error = nil;
  AGSGeometry *wgs84 = [AGSGeometryEngine projectGeometry:geometry
                                       toSpatialReference:AGSSpatialReference.WGS84];
  NSDictionary *json = [wgs84 toJSON:&error];
  if (error != nil || json == nil) {
    return nil;
  }
  return json;
}

- (NSString *)currentSketchGeoJsonString {
  NSDictionary *snapshot = [self sketchGeometrySnapshot];
  return [self geoJsonStringFromSnapshot:snapshot];
}

- (NSString *)geoJsonStringFromSnapshot:(NSDictionary *)snapshot {
  if (snapshot == nil) {
    return nil;
  }
  NSError *stringError = nil;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:&stringError];
  if (stringError != nil || jsonData == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
}

- (void)cacheCurrentSketchGeometry {
  NSString *json = [self currentSketchGeoJsonString];
  NSLog(@"[ArcGisDebug] cacheCurrentSketchGeometry length=%lu", (unsigned long)(json != nil ? json.length : 0));
  [ArcGisSketchStore setLatestGeoJson:json];
}

- (void)notifyClosedOnce {
  if (self.hasNotifiedClose) {
    return;
  }
  self.hasNotifiedClose = YES;
  NSLog(@"[ArcGisDebug] notifyClosedOnce");
  if (self.onClose != nil) {
    self.onClose();
    self.onClose = nil;
  }
}

- (void)applyHistoryGeometry:(NSDictionary *)geometryJson {
  self.applyingHistory = YES;
  if (geometryJson == nil) {
    [self.sketchEditor startWithCreationMode:AGSSketchCreationModePolygon];
  } else {
    NSError *error = nil;
    id<AGSJSONSerializable> serializable = [AGSGeometry fromJSON:geometryJson error:&error];
    AGSGeometry *geometry = [serializable isKindOfClass:[AGSGeometry class]] ? (AGSGeometry *)serializable : nil;
    if (error == nil && geometry != nil) {
      [self.sketchEditor startWithGeometry:geometry];
    }
  }
  self.applyingHistory = NO;
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  (void)object;
  (void)change;
  (void)context;
  if (![keyPath isEqualToString:@"geometry"] || self.applyingHistory) {
    return;
  }
  NSLog(@"[ArcGisDebug] observe geometry changed");
  [self cacheCurrentSketchGeometry];
  [self pushCurrentGeometryToUndo];
  [self.redoStack removeAllObjects];
}

- (void)toast:(NSString *)message {
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil
                                                                 message:message
                                                          preferredStyle:UIAlertControllerStyleAlert];
  [self presentViewController:alert animated:YES completion:nil];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.4 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   [alert dismissViewControllerAnimated:YES completion:nil];
                 });
}

- (void)dealloc {
  if (self.hasObservedGeometry) {
    @try {
      [self.sketchEditor removeObserver:self forKeyPath:@"geometry"];
    } @catch (NSException *exception) {
      (void)exception;
    }
  }
}

@end
