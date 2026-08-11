#import "ArcGisPhotoMapViewController.h"
#import <ArcGIS/ArcGIS.h>

@interface ArcGisPhotoMapViewController () <AGSGeoViewTouchDelegate>
@property(nonatomic, strong) AGSMapView *mapView;
@property(nonatomic, strong) AGSGraphicsOverlay *contextOverlay;
@property(nonatomic, strong) AGSGraphicsOverlay *headingOverlay;
@property(nonatomic, strong) AGSGraphicsOverlay *photoOverlay;
@property(nonatomic, strong) NSDictionary *payload;
@property(nonatomic, strong) UILabel *summaryLabel;
@end

@implementation ArcGisPhotoMapViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  self.title = @"Site Photo Map";
  self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithTitle:@"Close" style:UIBarButtonItemStyleDone target:self action:@selector(onClose)];

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

  [self parsePayload];
  [self renderContext];
  [self renderPhotos];
  [self renderSummary];
  [self fitView];
}

- (void)onClose { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)parsePayload {
  self.payload = @{};
  NSString *raw = [self.payloadJson stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (raw.length == 0) return;
  id parsed = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if ([parsed isKindOfClass:[NSDictionary class]]) self.payload = parsed;
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

- (void)renderPhotos {
  NSArray *photos = [self.payload[@"photos"] isKindOfClass:[NSArray class]] ? self.payload[@"photos"] : @[];
  for (id raw in photos) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *row = raw;
    NSNumber *lat = row[@"latitude"], *lon = row[@"longitude"];
    if (![lat isKindOfClass:[NSNumber class]] || ![lon isKindOfClass:[NSNumber class]]) continue;
    AGSPoint *point = [AGSPoint pointWithX:lon.doubleValue y:lat.doubleValue spatialReference:AGSSpatialReference.WGS84];
    AGSSimpleMarkerSymbol *pin = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleCircle color:[UIColor colorWithRed:.05 green:.60 blue:.95 alpha:1] size:12];
    pin.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:UIColor.whiteColor width:2];
    NSMutableDictionary *attributes = [row mutableCopy]; attributes[@"kind"] = @"photo";
    [self.photoOverlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:point symbol:pin attributes:attributes]];

    NSNumber *heading = row[@"camera_heading_deg"];
    NSString *headingReference = [row[@"heading_reference"] isKindOfClass:[NSString class]] ? row[@"heading_reference"] : nil;
    if ([heading isKindOfClass:[NSNumber class]] && [headingReference isEqualToString:@"TRUE_NORTH"]) {
      AGSSimpleMarkerSymbol *arrow = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleTriangle color:[UIColor colorWithRed:1 green:.72 blue:.10 alpha:.94] size:23];
      arrow.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:[UIColor colorWithWhite:.08 alpha:.9] width:1.2];
      arrow.angleAlignment = AGSSymbolAngleAlignmentMap;
      double normalized = fmod(heading.doubleValue, 360.0); if (normalized < 0) normalized += 360.0;
      // ArcGIS marker angles rotate clockwise. Compass azimuth is also clockwise
      // from north, so use the normalized heading directly; do not mirror it.
      arrow.angle = (float)normalized;
      arrow.offsetY = 12;
      [self.headingOverlay.graphics addObject:[[AGSGraphic alloc] initWithGeometry:point symbol:arrow attributes:@{@"kind": @"heading"}]];
    }
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

- (void)showPhoto:(NSDictionary *)attributes {
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
  NSString *source = [attributes[@"location_source"] isKindOfClass:[NSString class]] ? attributes[@"location_source"] : nil;
  if (source.length) [details addObject:[NSString stringWithFormat:@"Location source: %@", source]];

  UIAlertController *sheet = [UIAlertController alertControllerWithTitle:name message:[details componentsJoinedByString:@"\\n"] preferredStyle:UIAlertControllerStyleActionSheet];
  NSString *urlString = [attributes[@"download_url"] isKindOfClass:[NSString class]] ? attributes[@"download_url"] : nil;
  if (urlString.length) [sheet addAction:[UIAlertAction actionWithTitle:@"Open Photo" style:UIAlertActionStyleDefault handler:^(__unused UIAlertAction *action) { NSURL *url = [NSURL URLWithString:urlString]; if (url) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil]; }]];
  [sheet addAction:[UIAlertAction actionWithTitle:@"Close" style:UIAlertActionStyleCancel handler:nil]];
  if (sheet.popoverPresentationController) { sheet.popoverPresentationController.sourceView = self.view; sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1); }
  [self presentViewController:sheet animated:YES completion:nil];
}

- (void)geoView:(AGSGeoView *)geoView didTapAtScreenPoint:(CGPoint)screenPoint mapPoint:(AGSPoint *)mapPoint {
  (void)geoView; (void)mapPoint;
  __weak typeof(self) weakSelf = self;
  [self.mapView identifyGraphicsOverlay:self.photoOverlay screenPoint:screenPoint tolerance:22 returnPopupsOnly:NO maximumResults:1 completion:^(AGSIdentifyGraphicsOverlayResult *result) {
    AGSGraphic *graphic = result.graphics.firstObject;
    if (graphic) [weakSelf showPhoto:graphic.attributes];
  }];
}
@end
