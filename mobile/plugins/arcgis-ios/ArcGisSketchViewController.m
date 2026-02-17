#import "ArcGisSketchViewController.h"

#import <ArcGIS/ArcGIS.h>

#import "ArcGisSketchStore.h"

@interface ArcGisSketchViewController ()

@property(nonatomic, strong) AGSMapView *mapView;
@property(nonatomic, strong) AGSSketchEditor *sketchEditor;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *undoStack;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *redoStack;
@property(nonatomic, strong) NSArray<NSNumber *> *basemapStyles;
@property(nonatomic, strong) NSArray<NSString *> *basemapTitles;
@property(nonatomic, assign) NSInteger basemapIndex;
@property(nonatomic, strong) UIButton *basemapButton;
@property(nonatomic, assign) BOOL applyingHistory;
@property(nonatomic, assign) BOOL hasObservedGeometry;

@end

@implementation ArcGisSketchViewController

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = [UIColor systemBackgroundColor];
  self.title = @"ArcGIS Sketch";

  AGSBasemap *basemap = [[AGSBasemap alloc] initWithStyle:AGSBasemapStyleArcGISStreets];
  AGSMap *map = [[AGSMap alloc] initWithBasemap:basemap];
  self.mapView = [[AGSMapView alloc] initWithFrame:CGRectZero];
  self.mapView.translatesAutoresizingMaskIntoConstraints = NO;
  self.mapView.map = map;
  [self.view addSubview:self.mapView];

  UILabel *help = [[UILabel alloc] initWithFrame:CGRectZero];
  help.translatesAutoresizingMaskIntoConstraints = NO;
  help.numberOfLines = 0;
  help.font = [UIFont systemFontOfSize:12 weight:UIFontWeightRegular];
  help.text = @"Tap map to add polygon points. Drag vertices to reshape. Use Undo/Redo, then Done to save.";
  [self.view addSubview:help];

  UIStackView *stackContainer = [[UIStackView alloc] initWithFrame:CGRectZero];
  stackContainer.translatesAutoresizingMaskIntoConstraints = NO;
  stackContainer.axis = UILayoutConstraintAxisVertical;
  stackContainer.distribution = UIStackViewDistributionFillEqually;
  stackContainer.spacing = 8;
  [self.view addSubview:stackContainer];

  UIStackView *editStack = [[UIStackView alloc] initWithFrame:CGRectZero];
  editStack.axis = UILayoutConstraintAxisHorizontal;
  editStack.distribution = UIStackViewDistributionFillEqually;
  editStack.spacing = 8;

  UIStackView *mapStack = [[UIStackView alloc] initWithFrame:CGRectZero];
  mapStack.axis = UILayoutConstraintAxisHorizontal;
  mapStack.distribution = UIStackViewDistributionFillEqually;
  mapStack.spacing = 8;

  self.undoStack = [NSMutableArray array];
  self.redoStack = [NSMutableArray array];
  self.basemapStyles = @[
    @(AGSBasemapStyleArcGISStreets),
    @(AGSBasemapStyleArcGISTopographic),
    @(AGSBasemapStyleArcGISImagery)
  ];
  self.basemapTitles = @[ @"Streets", @"Topographic", @"Imagery" ];
  self.basemapIndex = 0;
  self.applyingHistory = NO;
  self.hasObservedGeometry = NO;

  UIButton *undoButton = [self buttonWithTitle:@"Undo" action:@selector(onUndo)];
  UIButton *redoButton = [self buttonWithTitle:@"Redo" action:@selector(onRedo)];
  UIButton *clearButton = [self buttonWithTitle:@"Clear" action:@selector(onClear)];
  UIButton *cancelButton = [self buttonWithTitle:@"Cancel" action:@selector(onCancel)];
  UIButton *doneButton = [self buttonWithTitle:@"Done" action:@selector(onDone)];
  self.basemapButton = [self buttonWithTitle:@"Layer: Streets" action:@selector(onBasemap)];
  UIButton *myLocationButton = [self buttonWithTitle:@"My Location" action:@selector(onMyLocation)];
  UIButton *homeButton = [self buttonWithTitle:@"Home" action:@selector(onHome)];
  UIButton *zoomInButton = [self buttonWithTitle:@"Zoom +" action:@selector(onZoomIn)];
  UIButton *zoomOutButton = [self buttonWithTitle:@"Zoom -" action:@selector(onZoomOut)];

  [editStack addArrangedSubview:undoButton];
  [editStack addArrangedSubview:redoButton];
  [editStack addArrangedSubview:clearButton];
  [editStack addArrangedSubview:cancelButton];
  [editStack addArrangedSubview:doneButton];

  [mapStack addArrangedSubview:self.basemapButton];
  [mapStack addArrangedSubview:myLocationButton];
  [mapStack addArrangedSubview:homeButton];
  [mapStack addArrangedSubview:zoomInButton];
  [mapStack addArrangedSubview:zoomOutButton];

  [stackContainer addArrangedSubview:editStack];
  [stackContainer addArrangedSubview:mapStack];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [help.topAnchor constraintEqualToAnchor:guide.topAnchor constant:10],
    [help.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:12],
    [help.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-12],

    [stackContainer.topAnchor constraintEqualToAnchor:help.bottomAnchor constant:10],
    [stackContainer.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:12],
    [stackContainer.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-12],
    [stackContainer.heightAnchor constraintEqualToConstant:84],

    [self.mapView.topAnchor constraintEqualToAnchor:stackContainer.bottomAnchor constant:10],
    [self.mapView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
    [self.mapView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    [self.mapView.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
  ]];

  self.sketchEditor = [[AGSSketchEditor alloc] init];
  [self configureSketchAppearance];
  self.mapView.sketchEditor = self.sketchEditor;
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
}

- (UIButton *)buttonWithTitle:(NSString *)title action:(SEL)selector {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setTitle:title forState:UIControlStateNormal];
  button.titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
  button.layer.cornerRadius = 8;
  button.layer.borderWidth = 1;
  button.layer.borderColor = [UIColor systemGray4Color].CGColor;
  [button addTarget:self action:selector forControlEvents:UIControlEventTouchUpInside];
  return button;
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
  // If seed geometry is only a point, start fresh polygon creation instead.
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

- (void)centerFromInitialLocation {
  NSNumber *lat = [ArcGisSketchStore initialLatitude];
  NSNumber *lon = [ArcGisSketchStore initialLongitude];
  if (lat == nil || lon == nil) {
    return;
  }

  AGSPoint *point = [AGSPoint pointWithX:lon.doubleValue
                                       y:lat.doubleValue
                         spatialReference:AGSSpatialReference.WGS84];
  [self.mapView setViewpointCenter:point scale:12000 completion:nil];
}

- (void)configureSketchAppearance {
  AGSSketchStyle *style = [[AGSSketchStyle alloc] init];
  UIColor *red = [UIColor colorWithRed:0.84 green:0.15 blue:0.16 alpha:1.0];

  AGSSimpleLineSymbol *outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid
                                                                       color:red
                                                                       width:2.5];
  AGSSimpleFillSymbol *fill = [[AGSSimpleFillSymbol alloc] initWithStyle:AGSSimpleFillSymbolStyleSolid
                                                                    color:[red colorWithAlphaComponent:0.16]
                                                                  outline:outline];
  AGSSimpleMarkerSymbol *vertex = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleSquare
                                                                          color:red
                                                                           size:10];
  AGSSimpleMarkerSymbol *selectedVertex = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleSquare
                                                                                   color:[UIColor colorWithRed:0.67 green:0.10 blue:0.11 alpha:1.0]
                                                                                    size:12];

  style.lineSymbol = outline;
  style.fillSymbol = fill;
  style.vertexSymbol = vertex;
  style.selectedVertexSymbol = selectedVertex;
  self.sketchEditor.style = style;
}

- (void)startLocationDisplay {
  self.mapView.locationDisplay.autoPanMode = AGSLocationDisplayAutoPanModeOff;
  [self.mapView.locationDisplay startWithCompletion:^(NSError *_Nullable error) {
    // Keep sketch usable even if location display fails.
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
  [self.basemapButton setTitle:[NSString stringWithFormat:@"Layer: %@", title] forState:UIControlStateNormal];
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
  [self.sketchEditor startWithCreationMode:AGSSketchCreationModePolygon];
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
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)onDone {
  AGSGeometry *geometry = self.sketchEditor.geometry;
  if (geometry == nil) {
    [self toast:@"Draw a polygon first."];
    return;
  }

  AGSGeometry *wgs84 = [AGSGeometryEngine projectGeometry:geometry
                                       toSpatialReference:AGSSpatialReference.WGS84];
  NSError *jsonError = nil;
  NSDictionary *jsonDict = [wgs84 toJSON:&jsonError];
  if (jsonError != nil || jsonDict == nil) {
    [self toast:@"Could not serialize sketch geometry."];
    return;
  }

  NSError *stringError = nil;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:jsonDict options:0 error:&stringError];
  if (stringError != nil || jsonData == nil) {
    [self toast:@"Could not save sketch geometry."];
    return;
  }

  NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
  [ArcGisSketchStore setLatestGeoJson:json];
  [self dismissViewControllerAnimated:YES completion:nil];
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
