#import "ArcGisMissionCenterViewController.h"

#import <ArcGIS/ArcGIS.h>

#import "ArcGisSketchStore.h"

@interface ArcGisMissionCenterViewController ()

@property(nonatomic, strong) AGSMapView *mapView;
@property(nonatomic, strong) AGSGraphicsOverlay *overlay;
@property(nonatomic, strong) AGSMobileMapPackage *mobileMapPackage;

@end

@implementation ArcGisMissionCenterViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"Mission Center";

  self.mapView = [[AGSMapView alloc] initWithFrame:CGRectZero];
  self.mapView.translatesAutoresizingMaskIntoConstraints = NO;
  self.mapView.map = [[AGSMap alloc] initWithBasemapStyle:AGSBasemapStyleArcGISTopographic];
  [self.view addSubview:self.mapView];

  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.mapView.topAnchor constraintEqualToAnchor:guide.topAnchor],
    [self.mapView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
    [self.mapView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    [self.mapView.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
  ]];

  self.overlay = [[AGSGraphicsOverlay alloc] init];
  [self.mapView.graphicsOverlays addObject:self.overlay];

  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Close"
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(onClose)];

  [self applyOfflineMapPackageIfAvailable];
  [self renderIncidentPins];
}

- (void)onClose {
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)applyOfflineMapPackageIfAvailable {
  NSString *path = [[ArcGisSketchStore mmpkPath] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (path == nil || path.length == 0) return;
  BOOL isDir = NO;
  if (![[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDir]) return;

  self.mobileMapPackage = [[AGSMobileMapPackage alloc] initWithFileURL:[NSURL fileURLWithPath:path]];
  __weak typeof(self) weakSelf = self;
  [self.mobileMapPackage loadWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) return;
    if (weakSelf.mobileMapPackage.maps.count > 0) {
      weakSelf.mapView.map = weakSelf.mobileMapPackage.maps.firstObject;
    }
  }];
}

- (void)renderIncidentPins {
  NSString *raw = [[ArcGisSketchStore missionIncidentsJson] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (raw == nil || raw.length == 0) {
    AGSPoint *ca = [AGSPoint pointWithX:-119.4179 y:36.7783 spatialReference:AGSSpatialReference.WGS84];
    [self.mapView setViewpointCenter:ca scale:9000000 completion:nil];
    return;
  }

  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding]
                                              options:0
                                                error:&err];
  if (err != nil || ![parsed isKindOfClass:[NSArray class]]) {
    return;
  }
  NSArray *items = (NSArray *)parsed;
  for (id item in items) {
    if (![item isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *row = (NSDictionary *)item;
    NSNumber *latN = row[@"latitude"];
    NSNumber *lonN = row[@"longitude"];
    if (![latN isKindOfClass:[NSNumber class]] || ![lonN isKindOfClass:[NSNumber class]]) continue;
    NSString *status = [NSString stringWithFormat:@"%@", row[@"status"] ?: @"NEW"];
    UIColor *color = [status isEqualToString:@"RESOLVED"]
      ? [UIColor colorWithRed:0.13 green:0.77 blue:0.37 alpha:1.0]
      : [status isEqualToString:@"IN_PROGRESS"]
        ? [UIColor colorWithRed:0.96 green:0.62 blue:0.04 alpha:1.0]
        : [UIColor colorWithRed:0.94 green:0.27 blue:0.27 alpha:1.0];
    AGSPoint *pt = [AGSPoint pointWithX:lonN.doubleValue y:latN.doubleValue spatialReference:AGSSpatialReference.WGS84];
    AGSSimpleMarkerSymbol *sym = [[AGSSimpleMarkerSymbol alloc] initWithStyle:AGSSimpleMarkerSymbolStyleCircle
                                                                         color:color
                                                                          size:10];
    sym.outline = [[AGSSimpleLineSymbol alloc] initWithStyle:AGSSimpleLineSymbolStyleSolid color:[UIColor whiteColor] width:1.5];
    NSMutableDictionary *attrs = [NSMutableDictionary dictionary];
    attrs[@"id"] = row[@"id"] ?: @0;
    attrs[@"title"] = row[@"title"] ?: @"Incident";
    attrs[@"status"] = status;
    AGSGraphic *graphic = [[AGSGraphic alloc] initWithGeometry:pt symbol:sym attributes:attrs];
    [self.overlay.graphics addObject:graphic];
  }
  if (self.overlay.graphics.count > 0) {
    [self.mapView setViewpointGeometry:self.overlay.extent padding:80 completion:nil];
  }
}

- (void)viewWillAppear:(BOOL)animated {
  [super viewWillAppear:animated];
  [self.mapView.locationDisplay startWithCompletion:^(__unused NSError * _Nullable error) {}];
}

@end

