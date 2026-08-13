#import "ArcGisPhotoMapViewController.h"
#import <ArcGIS/ArcGIS.h>

static NSString *const ErisPhotoMapDidFinishNotification = @"ErisPhotoMapDidFinishNotification";

@interface ArcGisPhotoMapViewController () <AGSGeoViewTouchDelegate>
@property(nonatomic, strong) AGSMapView *mapView;
@property(nonatomic, strong) AGSGraphicsOverlay *contextOverlay;
@property(nonatomic, strong) AGSGraphicsOverlay *headingOverlay;
@property(nonatomic, strong) AGSGraphicsOverlay *photoOverlay;
@property(nonatomic, strong) NSDictionary *payload;
@property(nonatomic, strong) UILabel *summaryLabel;
@property(nonatomic, strong) UIImage *coneImage;
@property(nonatomic, strong) AGSSketchEditor *positionEditor;
@property(nonatomic, assign) BOOL observingPositionEditor;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, AGSGraphic *> *photoGraphicsById;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, AGSGraphic *> *headingGraphicsById;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSDictionary *> *photoRowsById;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSDictionary *> *initialCorrectionsById;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSMutableDictionary *> *workingCorrectionsById;
@property(nonatomic, strong, nullable) NSNumber *editingAttachmentId;
@property(nonatomic, strong, nullable) AGSGraphic *editingPhotoGraphic;
@property(nonatomic, strong, nullable) AGSPoint *editingStartPoint;
@property(nonatomic, assign) BOOL positionResetRequested;
@property(nonatomic, assign) BOOL didPostResult;
@property(nonatomic, strong) UIView *editPanel;
@property(nonatomic, strong) UILabel *editPhotoLabel;
@property(nonatomic, strong) UILabel *headingValueLabel;
@property(nonatomic, strong) UISlider *headingSlider;
@end

@implementation ArcGisPhotoMapViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  self.title = @"Site Photo Map";
  self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithTitle:@"Close" style:UIBarButtonItemStyleDone target:self action:@selector(onClose)];

  self.photoGraphicsById = [NSMutableDictionary dictionary];
  self.headingGraphicsById = [NSMutableDictionary dictionary];
  self.photoRowsById = [NSMutableDictionary dictionary];
  self.initialCorrectionsById = [NSMutableDictionary dictionary];
  self.workingCorrectionsById = [NSMutableDictionary dictionary];
  self.coneImage = [self cameraDirectionConeImageWithSize:76.0];

  self.mapView = [[AGSMapView alloc] initWithFrame:CGRectZero];
  self.mapView.translatesAutoresizingMaskIntoConstraints = NO;
  self.mapView.map = [[AGSMap alloc] initWithBasemapStyle:AGSBasemapStyleArcGISImagery];
  self.mapView.touchDelegate = self;
  [self.view addSubview:self.mapView];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.mapView.topAnchor constraintEqualToAnchor:guide.topAnchor],
    [self.mapView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
    [self.mapView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    [self.mapView.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
  ]];

  self.contextOverlay = [[AGSGraphicsOverlay alloc] init];
  self.headingOverlay = [[AGSGraphicsOverlay alloc] init];
  self.photoOverlay = [[AGSGraphicsOverlay alloc] init];
  self.headingOverlay.renderingMode = AGSGraphicsRenderingModeDynamic;
  self.photoOverlay.renderingMode = AGSGraphicsRenderingModeDynamic;
  [self.mapView.graphicsOverlays addObject:self.contextOverlay];
  [self.mapView.graphicsOverlays addObject:self.headingOverlay];
  [self.mapView.graphicsOverlays addObject:self.photoOverlay];

  self.positionEditor = [[AGSSketchEditor alloc] init];
  self.mapView.sketchEditor = self.positionEditor;

  self.summaryLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.summaryLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.summaryLabel.textColor = UIColor.whiteColor;
  self.summaryLabel.font = [UIFont systemFontOfSize:12 weight:UIFontWeightSemibold];
  self.summaryLabel.numberOfLines = 2;
  self.summaryLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.68];
  self.summaryLabel.layer.cornerRadius = 9;
  self.summaryLabel.layer.masksToBounds = YES;
  [self.view addSubview:self.summaryLabel];
  [NSLayoutConstraint activateConstraints:@[
    [self.summaryLabel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:12],
    [self.summaryLabel.topAnchor constraintEqualToAnchor:guide.topAnchor constant:12],
    [self.summaryLabel.widthAnchor constraintLessThanOrEqualToConstant:280],
  ]];

  [self buildEditPanel];
  [self parsePayload];
  [self renderContext];
  [self renderPhotos];
  [self renderSummary];
  [self fitView];
  [self startLiveLocationDisplay];
}

- (void)dealloc {
  if (self.observingPositionEditor) {
    [self.positionEditor removeObserver:self forKeyPath:@"geometry"];
    self.observingPositionEditor = NO;
  }
}

- (void)onClose {
  [self finishEditingPhoto];
  [self postResultIfNeeded];
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)postResultIfNeeded {
  if (self.didPostResult) return;
  self.didPostResult = YES;
  NSMutableArray *corrections = [NSMutableArray array];
  for (NSNumber *attachmentId in self.workingCorrectionsById) {
    NSDictionary *initial = self.initialCorrectionsById[attachmentId] ?: @{};
    NSDictionary *working = self.workingCorrectionsById[attachmentId] ?: @{};
    if ([initial isEqualToDictionary:working]) continue;
    [corrections addObject:@{
      @"attachment_id": attachmentId,
      @"location_override": working[@"location_override"] ?: NSNull.null,
      @"heading_override_deg": working[@"heading_override_deg"] ?: NSNull.null,
    }];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"corrections": corrections } options:0 error:nil];
  NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{\"corrections\":[]}";
  [[NSNotificationCenter defaultCenter] postNotificationName:ErisPhotoMapDidFinishNotification object:self userInfo:@{ @"resultJson": json }];
}

- (void)parsePayload {
  self.payload = @{};
  NSString *raw = [self.payloadJson stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (raw.length == 0) return;
  id parsed = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if ([parsed isKindOfClass:[NSDictionary class]]) self.payload = parsed;
}

- (void)startLiveLocationDisplay {
  self.mapView.locationDisplay.autoPanMode = AGSLocationDisplayAutoPanModeOff;
  [self.mapView.locationDisplay startWithCompletion:^(__unused NSError *_Nullable error) {}];
}

- (void)buildEditPanel {
  self.editPanel = [[UIView alloc] initWithFrame:CGRectZero];
  self.editPanel.translatesAutoresizingMaskIntoConstraints = NO;
  self.editPanel.backgroundColor = [UIColor colorWithWhite:0.06 alpha:0.94];
  self.editPanel.layer.cornerRadius = 14;
  self.editPanel.layer.masksToBounds = YES;
  self.editPanel.hidden = YES;
  [self.view addSubview:self.editPanel];

  UIStackView *stack = [[UIStackView alloc] initWithFrame:CGRectZero];
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 9;
  [self.editPanel addSubview:stack];

  self.editPhotoLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.editPhotoLabel.textColor = UIColor.whiteColor;
  self.editPhotoLabel.font = [UIFont systemFontOfSize:15 weight:UIFontWeightSemibold];
  [stack addArrangedSubview:self.editPhotoLabel];

  UILabel *help = [[UILabel alloc] initWithFrame:CGRectZero];
  help.textColor = [UIColor colorWithWhite:.88 alpha:1];
  help.font = [UIFont systemFontOfSize:12];
  help.numberOfLines = 2;
  help.text = @"Move the editable photo point to correct its position, then adjust the camera direction.";
  [stack addArrangedSubview:help];

  self.headingValueLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.headingValueLabel.textColor = UIColor.whiteColor;
  self.headingValueLabel.font = [UIFont monospacedDigitSystemFontOfSize:13 weight:UIFontWeightSemibold];
  [stack addArrangedSubview:self.headingValueLabel];

  self.headingSlider = [[UISlider alloc] initWithFrame:CGRectZero];
  self.headingSlider.minimumValue = 0;
  self.headingSlider.maximumValue = 359;
  self.headingSlider.continuous = YES;
  [self.headingSlider addTarget:self action:@selector(onHeadingSliderChanged:) forControlEvents:UIControlEventValueChanged];
  [stack addArrangedSubview:self.headingSlider];

  UIButton *resetPosition = [UIButton buttonWithType:UIButtonTypeSystem];
  [resetPosition setTitle:@"Reset Position" forState:UIControlStateNormal];
  [resetPosition addTarget:self action:@selector(onResetPosition) forControlEvents:UIControlEventTouchUpInside];
  UIButton *resetDirection = [UIButton buttonWithType:UIButtonTypeSystem];
  [resetDirection setTitle:@"Reset Direction" forState:UIControlStateNormal];
  [resetDirection addTarget:self action:@selector(onResetDirection) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *resetRow = [[UIStackView alloc] initWithArrangedSubviews:@[resetPosition, resetDirection]];
  resetRow.axis = UILayoutConstraintAxisHorizontal;
  resetRow.distribution = UIStackViewDistributionFillEqually;
  [stack addArrangedSubview:resetRow];

  UIButton *done = [UIButton buttonWithType:UIButtonTypeSystem];
  [done setTitle:@"Done Editing" forState:UIControlStateNormal];
  done.titleLabel.font = [UIFont systemFontOfSize:15 weight:UIFontWeightBold];
  [done addTarget:self action:@selector(onDoneEditing) forControlEvents:UIControlEventTouchUpInside];
  [stack addArrangedSubview:done];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.editPanel.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:12],
    [self.editPanel.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-12],
    [self.editPanel.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor constant:-12],
    [stack.topAnchor constraintEqualToAnchor:self.editPanel.topAnchor constant:12],
    [stack.leadingAnchor constraintEqualToAnchor:self.editPanel.leadingAnchor constant:14],
    [stack.trailingAnchor constraintEqualToAnchor:self.editPanel.trailingAnchor constant:-14],
    [stack.bottomAnchor constraintEqualToAnchor:self.editPanel.bottomAnchor constant:-12],
  ]];
}

- (NSArray<AGSPoint *> *)pointsFromRing:(id)ring {
  if (![ring isKindOfClass:[NSArray class]]) return @[];
  NSMutableArray<AGSPoint *> *out = [NSMutableArray array];
  for (id rawPoint in (NSArray *)ring) {
    if (![rawPoint isKindOfClass:[NSArray class]] || [(NSArray *)rawPoint count] < 2) continue;
    id lon = rawPoint[0]; id lat = rawPoint[1];
    if (![lon isKindOfClass:[NSNumber class]] || ![lat isKindOfClass:[NSNumber class]]) continue;
    double x = [lon doubleValue], y = [lat doubleValue];
    if (x < -180 || x > 180 || y < -90 || y > 90) continue;
    [out addObject:[AGSPoint pointWithX:x y:y spatialReference:AGSSpatialReference.WGS84]];
  }
  return out;
}

- (AGSPolygon *)polygonFromGeoJSON:(id)raw {
  if (![raw isKindOfClass:[NSDictionary class]]) return nil;
  NSString *type = [NSString stringWithFormat:@"%@", raw[@"type"] ?: @""];
  id coordinates = raw[@"coordinates"];
  if (![coordinates isKindOfClass:[NSArray class]]) return nil;
  AGSPolygonBuilder *builder = [AGSPolygonBuilder polygonBuilderWithSpatialReference:AGSSpatialReference.WGS84];
  if ([type isEqualToString:@"Polygon"]) {
    for (id ring in coordinates) { NSArray *points = [self pointsFromRing:ring]; if (points.count >= 3) [builder addPartWithPoints:points]; }
  } else if ([type isEqualToString:@"MultiPolygon"]) {
    for (id polygon in coordinates) if ([polygon isKindOfClass:[NSArray class]]) for (id ring in polygon) { NSArray *points = [self pointsFromRing:ring]; if (points.count >= 3) [builder addPartWithPoints:points]; }
  } else return nil;
  return builder.isEmpty ? nil : builder.toGeometry;
}

- (void)renderContext {
  NSDictionary *incident = [self.payload[@"incident"] isKindOfClass:[NSDictionary class]] ? self.payload[@"incident"] : nil;
  NSNumber *lat = incident[@"latitude"], *lon = incident[@"longitude"];
  if ([lat isKindOfClass:[NSNumber class]] && [lon isKindOfClass:[NSNumber class]]) {
    AGSPoint *point = [AGSPoint pointWithX:lon.doubleValue y:lat.doubleValue spatialReference:AGSSpatialReference.WGS84];
    AGSSimpleMarkerSymbol *symbol = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleDiamond color:[UIColor colorWithRed:.90 green:.18 blue:.20 alpha:1] size:13];
    symbol.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:UIColor.whiteColor width:1.5];
    [self.contextOverlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:point symbol:symbol attributes:@{@"kind": @"incident"}]];
  }
  AGSPolygon *polygon = [self polygonFromGeoJSON:self.payload[@"affected_geometry"]];
  if (polygon) {
    UIColor *red = [UIColor colorWithRed:.88 green:.17 blue:.18 alpha:1];
    AGSSimpleLineSymbol *outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:red width:2];
    AGSSimpleFillSymbol *fill = [[AGSSimpleFillSymbol alloc] initWithStyle:AGSSimpleFillSymbolStyleSolid color:[red colorWithAlphaComponent:.12] outline:outline];
    [self.contextOverlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:polygon symbol:fill attributes:@{@"kind": @"affected_area"}]];
  }
}

- (UIImage *)cameraDirectionConeImageWithSize:(CGFloat)size {
  UIGraphicsBeginImageContextWithOptions(CGSizeMake(size, size), NO, 0.0);
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  if (ctx == nil) { UIGraphicsEndImageContext(); return nil; }
  const CGFloat center = size / 2.0;
  const CGFloat radius = size * 0.47;
  const CGFloat halfAngle = 24.0 * (CGFloat)M_PI / 180.0;
  const CGFloat north = -(CGFloat)M_PI_2;
  const CGFloat start = north - halfAngle;
  const CGFloat end = north + halfAngle;
  CGPoint apex = CGPointMake(center, center);
  CGPoint startPoint = CGPointMake(center + radius * cos(start), center + radius * sin(start));
  UIBezierPath *fan = [UIBezierPath bezierPath];
  [fan moveToPoint:apex];
  [fan addLineToPoint:startPoint];
  [fan addArcWithCenter:apex radius:radius startAngle:start endAngle:end clockwise:YES];
  [fan closePath];
  UIColor *googleBlue = [UIColor colorWithRed:0.12 green:0.45 blue:0.95 alpha:1.0];
  [[googleBlue colorWithAlphaComponent:0.28] setFill]; [fan fill];
  fan.lineWidth = 1.5; [[googleBlue colorWithAlphaComponent:0.62] setStroke]; [fan stroke];
  UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();
  return image;
}

- (NSDictionary *)correctionStateForRow:(NSDictionary *)row {
  NSDictionary *correction = [row[@"correction"] isKindOfClass:[NSDictionary class]] ? row[@"correction"] : @{};
  id location = [correction[@"location_override"] isKindOfClass:[NSDictionary class]] ? correction[@"location_override"] : NSNull.null;
  id heading = [correction[@"heading_override_deg"] isKindOfClass:[NSNumber class]] ? correction[@"heading_override_deg"] : NSNull.null;
  return @{ @"location_override": location, @"heading_override_deg": heading };
}

- (AGSPictureMarkerSymbol *)coneSymbolWithHeading:(double)heading {
  if (self.coneImage == nil) return nil;
  AGSPictureMarkerSymbol *cone = [AGSPictureMarkerSymbol pictureMarkerSymbolWithImage:self.coneImage];
  cone.width = 76.0; cone.height = 76.0; cone.angleAlignment = AGSSymbolAngleAlignmentMap;
  double normalized = fmod(heading, 360.0); if (normalized < 0) normalized += 360.0;
  cone.angle = (float)normalized;
  return cone;
}

- (void)setHeadingForAttachmentId:(NSNumber *)attachmentId point:(AGSPoint *)point heading:(NSNumber *)heading {
  AGSGraphic *existing = self.headingGraphicsById[attachmentId];
  if (existing) { [self.headingOverlay.graphics removeObject:existing]; [self.headingGraphicsById removeObjectForKey:attachmentId]; }
  if (![heading isKindOfClass:[NSNumber class]] || point == nil) return;
  AGSPictureMarkerSymbol *cone = [self coneSymbolWithHeading:heading.doubleValue];
  if (!cone) return;
  AGSGraphic *graphic = [[AGSGraphic alloc] initWithGeometry:point symbol:cone attributes:@{@"kind": @"heading_cone", @"attachment_id": attachmentId}];
  [self.headingOverlay.graphics addObject:graphic];
  self.headingGraphicsById[attachmentId] = graphic;
}

- (void)renderPhotos {
  NSArray *photos = [self.payload[@"photos"] isKindOfClass:[NSArray class]] ? self.payload[@"photos"] : @[];
  for (id raw in photos) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *row = raw;
    NSNumber *attachmentId = [row[@"attachment_id"] isKindOfClass:[NSNumber class]] ? row[@"attachment_id"] : nil;
    if (!attachmentId) continue;
    self.photoRowsById[attachmentId] = row;
    NSDictionary *correction = [self correctionStateForRow:row];
    self.initialCorrectionsById[attachmentId] = correction;
    self.workingCorrectionsById[attachmentId] = [correction mutableCopy];
    NSNumber *lat = row[@"latitude"], *lon = row[@"longitude"];
    if (![lat isKindOfClass:[NSNumber class]] || ![lon isKindOfClass:[NSNumber class]]) continue;
    AGSPoint *point = [AGSPoint pointWithX:lon.doubleValue y:lat.doubleValue spatialReference:AGSSpatialReference.WGS84];
    NSNumber *heading = row[@"camera_heading_deg"];
    NSString *headingReference = [row[@"heading_reference"] isKindOfClass:[NSString class]] ? row[@"heading_reference"] : nil;
    if ([heading isKindOfClass:[NSNumber class]] && [headingReference isEqualToString:@"TRUE_NORTH"]) [self setHeadingForAttachmentId:attachmentId point:point heading:heading];
    UIColor *googleBlue = [UIColor colorWithRed:0.12 green:0.45 blue:0.95 alpha:1.0];
    AGSSimpleMarkerSymbol *pin = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleCircle color:googleBlue size:14];
    pin.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:UIColor.whiteColor width:2.5];
    NSMutableDictionary *attributes = [row mutableCopy]; attributes[@"kind"] = @"photo";
    AGSGraphic *photoGraphic = [[AGSGraphic alloc] initWithGeometry:point symbol:pin attributes:attributes];
    [self.photoOverlay.graphics addObject:photoGraphic];
    self.photoGraphicsById[attachmentId] = photoGraphic;
  }
}

- (void)renderSummary {
  NSDictionary *summary = [self.payload[@"summary"] isKindOfClass:[NSDictionary class]] ? self.payload[@"summary"] : @{};
  NSInteger total = [summary[@"photos_total"] integerValue];
  NSInteger mapped = [summary[@"photos_geotagged"] integerValue];
  NSInteger headed = [summary[@"photos_with_heading"] integerValue];
  NSInteger unmapped = [summary[@"photos_unmapped"] integerValue];
  self.summaryLabel.text = [NSString stringWithFormat:@"  %ld photos • %ld mapped • %ld directions  \\n  %ld without GPS  ", (long)total, (long)mapped, (long)headed, (long)unmapped];
}

- (void)fitView {
  NSMutableArray<AGSGeometry *> *geometries = [NSMutableArray array];
  for (AGSGraphic *graphic in self.contextOverlay.graphics) if (graphic.geometry) [geometries addObject:graphic.geometry];
  for (AGSGraphic *graphic in self.photoOverlay.graphics) if (graphic.geometry) [geometries addObject:graphic.geometry];
  if (geometries.count == 0) return;
  AGSEnvelope *extent = [AGSGeometryEngine combineExtentsOfGeometries:geometries];
  if (extent) [self.mapView setViewpointGeometry:extent padding:90 completion:nil];
}

- (NSString *)cardinal:(double)heading {
  NSArray *labels = @[@"N",@"NE",@"E",@"SE",@"S",@"SW",@"W",@"NW"];
  return labels[((NSInteger)lround(heading / 45.0)) % 8];
}

- (AGSPoint *)wgs84PointFromGeometry:(AGSGeometry *)geometry {
  if (!geometry) return nil;
  AGSGeometry *projected = [AGSGeometryEngine projectGeometry:geometry toSpatialReference:AGSSpatialReference.WGS84];
  return [projected isKindOfClass:[AGSPoint class]] ? (AGSPoint *)projected : nil;
}

- (BOOL)pointsNearlyEqual:(AGSPoint *)a other:(AGSPoint *)b {
  if (!a || !b) return NO;
  AGSPoint *aw = [self wgs84PointFromGeometry:a];
  AGSPoint *bw = [self wgs84PointFromGeometry:b];
  if (!aw || !bw) return NO;
  return fabs(aw.x - bw.x) <= 0.0000001 && fabs(aw.y - bw.y) <= 0.0000001;
}

- (BOOL)capturedLocationForRow:(NSDictionary *)row point:(AGSPoint * _Nullable * _Nullable)pointOut {
  NSDictionary *captured = [row[@"captured_metadata"] isKindOfClass:[NSDictionary class]] ? row[@"captured_metadata"] : nil;
  NSNumber *lat = [captured[@"latitude"] isKindOfClass:[NSNumber class]] ? captured[@"latitude"] : nil;
  NSNumber *lon = [captured[@"longitude"] isKindOfClass:[NSNumber class]] ? captured[@"longitude"] : nil;
  NSNumber *accuracy = [captured[@"horizontal_accuracy_m"] isKindOfClass:[NSNumber class]] ? captured[@"horizontal_accuracy_m"] : nil;
  if (!lat || !lon || !accuracy || accuracy.doubleValue < 0 || accuracy.doubleValue > 20.0) return NO;
  if (pointOut) *pointOut = [AGSPoint pointWithX:lon.doubleValue y:lat.doubleValue spatialReference:AGSSpatialReference.WGS84];
  return YES;
}

- (NSNumber *)capturedHeadingForRow:(NSDictionary *)row {
  NSDictionary *captured = [row[@"captured_metadata"] isKindOfClass:[NSDictionary class]] ? row[@"captured_metadata"] : nil;
  NSNumber *heading = [captured[@"camera_heading_deg"] isKindOfClass:[NSNumber class]] ? captured[@"camera_heading_deg"] : nil;
  NSNumber *accuracy = [captured[@"camera_heading_accuracy_code"] isKindOfClass:[NSNumber class]] ? captured[@"camera_heading_accuracy_code"] : nil;
  NSString *reference = [captured[@"heading_reference"] isKindOfClass:[NSString class]] ? captured[@"heading_reference"] : nil;
  if (!heading || !accuracy || accuracy.integerValue < 2 || ![reference isEqualToString:@"TRUE_NORTH"]) return nil;
  return heading;
}

- (void)startObservingPositionEditor {
  if (self.observingPositionEditor) return;
  [self.positionEditor addObserver:self forKeyPath:@"geometry" options:NSKeyValueObservingOptionNew context:nil];
  self.observingPositionEditor = YES;
}

- (void)stopObservingPositionEditor {
  if (!self.observingPositionEditor) return;
  [self.positionEditor removeObserver:self forKeyPath:@"geometry"];
  self.observingPositionEditor = NO;
}

- (void)beginEditingPhotoGraphic:(AGSGraphic *)graphic {
  NSNumber *attachmentId = [graphic.attributes[@"attachment_id"] isKindOfClass:[NSNumber class]] ? graphic.attributes[@"attachment_id"] : nil;
  if (!attachmentId || ![graphic.attributes[@"can_edit_correction"] boolValue]) return;
  [self finishEditingPhoto];
  self.editingAttachmentId = attachmentId;
  self.editingPhotoGraphic = graphic;
  self.editingStartPoint = [self wgs84PointFromGeometry:graphic.geometry];
  self.positionResetRequested = NO;
  [self.photoOverlay.graphics removeObject:graphic];
  [self startObservingPositionEditor];
  [self.positionEditor startWithGeometry:graphic.geometry];

  NSDictionary *row = self.photoRowsById[attachmentId] ?: @{};
  NSString *name = [row[@"file_name"] isKindOfClass:[NSString class]] ? row[@"file_name"] : @"Photo";
  self.editPhotoLabel.text = [NSString stringWithFormat:@"Adjust %@", name];
  NSNumber *effectiveHeading = [row[@"camera_heading_deg"] isKindOfClass:[NSNumber class]] ? row[@"camera_heading_deg"] : nil;
  NSDictionary *working = self.workingCorrectionsById[attachmentId] ?: @{};
  if ([working[@"heading_override_deg"] isKindOfClass:[NSNumber class]]) effectiveHeading = working[@"heading_override_deg"];
  self.headingSlider.value = effectiveHeading ? (float)effectiveHeading.doubleValue : 0.0f;
  self.headingValueLabel.text = effectiveHeading ? [NSString stringWithFormat:@"Camera direction: %.0f° %@", effectiveHeading.doubleValue, [self cardinal:effectiveHeading.doubleValue]] : @"Camera direction: unavailable • move slider to set";
  self.editPanel.hidden = NO;
  [self.view bringSubviewToFront:self.editPanel];
}

- (void)finishEditingPhoto {
  if (!self.editingAttachmentId || !self.editingPhotoGraphic) return;
  NSNumber *attachmentId = self.editingAttachmentId;
  AGSPoint *finalPoint = [self wgs84PointFromGeometry:self.positionEditor.geometry];
  NSDictionary *row = self.photoRowsById[attachmentId] ?: @{};
  NSMutableDictionary *working = self.workingCorrectionsById[attachmentId];
  AGSPoint *capturedPoint = nil;
  BOOL capturedAvailable = [self capturedLocationForRow:row point:&capturedPoint];
  AGSPoint *baseline = (self.positionResetRequested && capturedAvailable) ? capturedPoint : self.editingStartPoint;

  if (finalPoint && working) {
    if (![self pointsNearlyEqual:finalPoint other:baseline]) {
      working[@"location_override"] = @{ @"latitude": @(finalPoint.y), @"longitude": @(finalPoint.x) };
    } else if (self.positionResetRequested) {
      working[@"location_override"] = NSNull.null;
    }
    self.editingPhotoGraphic.geometry = finalPoint;
  }

  [self.positionEditor stop];
  [self stopObservingPositionEditor];
  if (![self.photoOverlay.graphics containsObject:self.editingPhotoGraphic]) [self.photoOverlay.graphics addObject:self.editingPhotoGraphic];

  NSNumber *heading = nil;
  if ([working[@"heading_override_deg"] isKindOfClass:[NSNumber class]]) heading = working[@"heading_override_deg"];
  else heading = [self capturedHeadingForRow:row];
  [self setHeadingForAttachmentId:attachmentId point:(AGSPoint *)self.editingPhotoGraphic.geometry heading:heading];

  self.editingAttachmentId = nil;
  self.editingPhotoGraphic = nil;
  self.editingStartPoint = nil;
  self.positionResetRequested = NO;
  self.editPanel.hidden = YES;
}

- (void)onDoneEditing { [self finishEditingPhoto]; }

- (void)onHeadingSliderChanged:(UISlider *)slider {
  if (!self.editingAttachmentId) return;
  double heading = round(slider.value);
  NSMutableDictionary *working = self.workingCorrectionsById[self.editingAttachmentId];
  if (!working) return;
  working[@"heading_override_deg"] = @(heading);
  self.headingValueLabel.text = [NSString stringWithFormat:@"Camera direction: %.0f° %@", heading, [self cardinal:heading]];
  AGSPoint *point = [self wgs84PointFromGeometry:self.positionEditor.geometry];
  if (point) [self setHeadingForAttachmentId:self.editingAttachmentId point:point heading:@(heading)];
}

- (void)onResetPosition {
  if (!self.editingAttachmentId) return;
  NSDictionary *row = self.photoRowsById[self.editingAttachmentId] ?: @{};
  NSMutableDictionary *working = self.workingCorrectionsById[self.editingAttachmentId];
  if (!working) return;
  working[@"location_override"] = NSNull.null;
  self.positionResetRequested = YES;
  AGSPoint *capturedPoint = nil;
  if ([self capturedLocationForRow:row point:&capturedPoint] && capturedPoint) {
    [self.positionEditor replaceGeometry:capturedPoint];
  } else {
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Captured GPS unavailable" message:@"The original GPS fix did not meet the map quality threshold. Saving this reset will make the photo unmapped until a new manual position is set." preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
  }
}

- (void)onResetDirection {
  if (!self.editingAttachmentId) return;
  NSMutableDictionary *working = self.workingCorrectionsById[self.editingAttachmentId];
  NSDictionary *row = self.photoRowsById[self.editingAttachmentId] ?: @{};
  if (!working) return;
  working[@"heading_override_deg"] = NSNull.null;
  NSNumber *capturedHeading = [self capturedHeadingForRow:row];
  AGSPoint *point = [self wgs84PointFromGeometry:self.positionEditor.geometry];
  if (capturedHeading) {
    self.headingSlider.value = (float)capturedHeading.doubleValue;
    self.headingValueLabel.text = [NSString stringWithFormat:@"Camera direction: %.0f° %@", capturedHeading.doubleValue, [self cardinal:capturedHeading.doubleValue]];
  } else {
    self.headingSlider.value = 0;
    self.headingValueLabel.text = @"Camera direction: unavailable • move slider to set";
  }
  if (point) [self setHeadingForAttachmentId:self.editingAttachmentId point:point heading:capturedHeading];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary<NSKeyValueChangeKey,id> *)change context:(void *)context {
  if (object == self.positionEditor && [keyPath isEqualToString:@"geometry"] && self.editingAttachmentId) {
    AGSPoint *point = [self wgs84PointFromGeometry:self.positionEditor.geometry];
    AGSGraphic *headingGraphic = self.headingGraphicsById[self.editingAttachmentId];
    if (point && headingGraphic) headingGraphic.geometry = point;
    return;
  }
  [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)showPhotoGraphic:(AGSGraphic *)graphic {
  NSDictionary *attributes = graphic.attributes;
  NSString *name = [NSString stringWithFormat:@"%@", attributes[@"file_name"] ?: @"Photo"];
  NSMutableArray<NSString *> *details = [NSMutableArray array];
  NSString *section = [attributes[@"section_key"] isKindOfClass:[NSString class]] ? attributes[@"section_key"] : nil;
  if (section.length) [details addObject:[NSString stringWithFormat:@"Section: %@", section]];
  NSString *captured = [attributes[@"captured_at"] isKindOfClass:[NSString class]] ? attributes[@"captured_at"] : nil;
  if (captured.length) [details addObject:[NSString stringWithFormat:@"Captured: %@", captured]];
  NSNumber *accuracy = attributes[@"horizontal_accuracy_m"];
  if ([accuracy isKindOfClass:[NSNumber class]]) [details addObject:[NSString stringWithFormat:@"GPS accuracy: ±%.1f m", accuracy.doubleValue]];
  NSNumber *heading = attributes[@"camera_heading_deg"];
  if ([heading isKindOfClass:[NSNumber class]]) [details addObject:[NSString stringWithFormat:@"Camera: %.0f° %@", heading.doubleValue, [self cardinal:heading.doubleValue]]];
  else [details addObject:@"Camera direction: unavailable"];
  NSDictionary *correction = [attributes[@"correction"] isKindOfClass:[NSDictionary class]] ? attributes[@"correction"] : nil;
  if ([correction[@"location_overridden"] boolValue]) [details addObject:@"Position: manually corrected"];
  if ([correction[@"heading_overridden"] boolValue]) [details addObject:@"Direction: manually corrected"];

  UIAlertController *sheet = [UIAlertController alertControllerWithTitle:name message:[details componentsJoinedByString:@"\n"] preferredStyle:UIAlertControllerStyleActionSheet];
  if ([attributes[@"can_edit_correction"] boolValue]) {
    __weak typeof(self) weakSelf = self;
    [sheet addAction:[UIAlertAction actionWithTitle:@"Adjust Position & Direction" style:UIAlertActionStyleDefault handler:^(__unused UIAlertAction *action) { [weakSelf beginEditingPhotoGraphic:graphic]; }]];
  }
  NSString *urlString = [attributes[@"download_url"] isKindOfClass:[NSString class]] ? attributes[@"download_url"] : nil;
  if (urlString.length) [sheet addAction:[UIAlertAction actionWithTitle:@"Open Photo" style:UIAlertActionStyleDefault handler:^(__unused UIAlertAction *action) { NSURL *url = [NSURL URLWithString:urlString]; if (url) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil]; }]];
  [sheet addAction:[UIAlertAction actionWithTitle:@"Close" style:UIAlertActionStyleCancel handler:nil]];
  if (sheet.popoverPresentationController) { sheet.popoverPresentationController.sourceView = self.view; sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1); }
  [self presentViewController:sheet animated:YES completion:nil];
}

- (void)geoView:(AGSGeoView *)geoView didTapAtScreenPoint:(CGPoint)screenPoint mapPoint:(AGSPoint *)mapPoint {
  (void)geoView; (void)mapPoint;
  if (self.editingAttachmentId) return;
  __weak typeof(self) weakSelf = self;
  [self.mapView identifyGraphicsOverlay:self.photoOverlay screenPoint:screenPoint tolerance:22 returnPopupsOnly:NO maximumResults:1 completion:^(AGSIdentifyGraphicsOverlayResult *result) {
    AGSGraphic *graphic = result.graphics.firstObject;
    if (graphic) [weakSelf showPhotoGraphic:graphic];
  }];
}

@end
