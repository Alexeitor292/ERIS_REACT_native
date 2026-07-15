#import "ErisRoadSliceSceneViewController.h"
#import <SceneKit/SceneKit.h>

// Scene scale: feet -> scene units, plus a modest vertical exaggeration so terrain
// slope reads without dominating. All procedural — no textures, no network.
static const double kUnitsPerFt = 0.40;
static const double kVExag = 2.0;
static const double kDepth = 8.0;          // along-road extrusion (upstation slab depth)
static const double kDeckThickness = 1.2;

// Small, safe dictionary readers (never throw on wrong types).
static double dnum(NSDictionary *d, NSString *k, double def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : def;
}
static NSString *dstr(NSDictionary *d, NSString *k, NSString *def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v isKindOfClass:[NSString class]] ? v : def;
}
static BOOL disnull(id v) { return v == nil || [v isKindOfClass:[NSNull class]]; }

@interface ErisRoadSliceSceneViewController ()
@property(nonatomic, strong) NSDictionary *slice;
@property(nonatomic, strong) NSDictionary *road;
@property(nonatomic, strong) SCNView *scnView;
@property(nonatomic, strong) SCNNode *cameraNode;
@property(nonatomic, assign) SCNMatrix4 defaultCamTransform;
@property(nonatomic, assign) double defaultOrthoScale;
@property(nonatomic, assign) double contentHalfWidthUnits;
@property(nonatomic, assign) double centerXUnits;
@property(nonatomic, assign) double datumFt;
@property(nonatomic, assign) BOOL hasElevation;
@property(nonatomic, assign) BOOL technical;
@property(nonatomic, strong) UITextView *technicalPanel;
@property(nonatomic, strong) UILabel *legendLabel;
@property(nonatomic, strong) UIBarButtonItem *technicalItem;
@end

@implementation ErisRoadSliceSceneViewController

- (instancetype)initWithSlice:(NSDictionary *)slice {
  if ((self = [super init])) {
    _slice = [slice isKindOfClass:[NSDictionary class]] ? slice : @{};
    _road = [_slice[@"road"] isKindOfClass:[NSDictionary class]] ? _slice[@"road"] : @{};
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"Road Cross Section";

  self.scnView = [[SCNView alloc] initWithFrame:self.view.bounds];
  self.scnView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.scnView.allowsCameraControl = YES;   // orbit / pan / zoom
  self.scnView.backgroundColor = [UIColor colorWithRed:0.10 green:0.14 blue:0.20 alpha:1.0];
  self.scnView.scene = [SCNScene scene];
  [self.view addSubview:self.scnView];

  self.datumFt = [self deckElevationFt:&_hasElevation];
  [self buildScene];
  [self setupCamera];
  [self addLighting];
  [self addOverlays];

  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(onClose)];
  self.technicalItem = [[UIBarButtonItem alloc] initWithTitle:@"Technical" style:UIBarButtonItemStylePlain target:self action:@selector(onToggleTechnical)];
  self.navigationItem.leftBarButtonItems = @[
    [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain target:self action:@selector(onReset)],
    self.technicalItem,
  ];
}

- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  [self applyOrthoScale];
}

- (void)onClose { [self dismissViewControllerAnimated:YES completion:nil]; }

#pragma mark - Elevation datum + parsing

// Reference elevation for the roadway deck (datum). Sampled center/median elevation
// when available, else the mean of available road samples, else 0 (flat schematic).
- (double)deckElevationFt:(BOOL *)outHasElevation {
  NSArray *samples = [self.slice[@"samples"] isKindOfClass:[NSArray class]] ? self.slice[@"samples"] : @[];
  double sum = 0; int n = 0; BOOL any = NO; double center = NAN;
  // Bound each side by ITS OWN shoulder edge so asymmetric roads never pull off-road
  // terrain into the deck reference elevation.
  double ltShoulder = [self shoulderEdgeFt:@"LT"];
  double rtShoulder = [self shoulderEdgeFt:@"RT"];
  for (id s in samples) {
    if (![s isKindOfClass:[NSDictionary class]]) continue;
    if (![dstr(s, @"status", @"") isEqualToString:@"OK"]) continue;
    id ev = s[@"elevationFt"]; if (disnull(ev)) continue;
    double e = [ev doubleValue];
    any = YES;
    double off = dnum(s, @"offsetFt", 0);
    if (off == 0) center = e;
    if (off >= ltShoulder - 1e-6 && off <= rtShoulder + 1e-6) { sum += e; n++; }
  }
  if (outHasElevation) *outHasElevation = any;
  if (!isnan(center)) return center;
  if (n > 0) return sum / n;
  return 0.0;
}

// Signed outside-shoulder edge offset (ft) from the centerline. LT negative, RT positive.
- (double)shoulderEdgeFt:(NSString *)side {
  double mh = MAX(0, dnum(self.road, @"median_width_ft", 0)) / 2.0;
  if ([side isEqualToString:@"LT"]) {
    return -(mh + dnum(self.road, @"lt_inside_shoulder_ft", 0)
             + dnum(self.road, @"lt_lane_count", 1) * dnum(self.road, @"lt_lane_width_ft", 12)
             + dnum(self.road, @"lt_outside_shoulder_ft", 0));
  }
  return mh + dnum(self.road, @"rt_inside_shoulder_ft", 0)
         + dnum(self.road, @"rt_lane_count", 1) * dnum(self.road, @"rt_lane_width_ft", 12)
         + dnum(self.road, @"rt_outside_shoulder_ft", 0);
}

- (double)xUnits:(double)offsetFt { return offsetFt * kUnitsPerFt; }
- (double)yUnits:(double)elevFt { return (elevFt - self.datumFt) * kUnitsPerFt * kVExag; }

#pragma mark - Scene construction

- (void)buildScene {
  SCNNode *root = self.scnView.scene.rootNode;
  double ltShoulder = [self shoulderEdgeFt:@"LT"];
  double rtShoulder = [self shoulderEdgeFt:@"RT"];
  double minX = ltShoulder - 50, maxX = rtShoulder + 50;
  self.centerXUnits = [self xUnits:(minX + maxX) / 2.0];
  self.contentHalfWidthUnits = [self xUnits:(maxX - minX) / 2.0];

  [self buildDeckInto:root];
  [self buildGroundInto:root side:@"LT" edgeFt:ltShoulder];
  [self buildGroundInto:root side:@"RT" edgeFt:rtShoulder];
  [self buildStakesInto:root];
}

// Deck spans (LT outer shoulder -> RT outer shoulder), mirroring deckSpansFt() in
// roadCrossSectionSliceModel.ts. Returns dicts {x0,x1,kind}.
- (NSArray<NSDictionary *> *)deckSpans {
  double mh = MAX(0, dnum(self.road, @"median_width_ft", 0)) / 2.0;
  double ltInside = -(mh + dnum(self.road, @"lt_inside_shoulder_ft", 0));
  double ltTravel = ltInside - dnum(self.road, @"lt_lane_count", 1) * dnum(self.road, @"lt_lane_width_ft", 12);
  double ltShoulder = [self shoulderEdgeFt:@"LT"];
  double rtInside = mh + dnum(self.road, @"rt_inside_shoulder_ft", 0);
  double rtTravel = rtInside + dnum(self.road, @"rt_lane_count", 1) * dnum(self.road, @"rt_lane_width_ft", 12);
  double rtShoulder = [self shoulderEdgeFt:@"RT"];
  NSMutableArray *out = [NSMutableArray array];
  void (^add)(NSString *, double, double) = ^(NSString *kind, double a, double b) {
    if (b - a > 1e-9) [out addObject:@{@"kind": kind, @"x0": @(a), @"x1": @(b)}];
  };
  add(@"lt_shoulder", ltShoulder, ltTravel);
  add(@"lt_lanes", ltTravel, ltInside);
  add(@"lt_inside_shoulder", ltInside, -mh);
  add(@"median", -mh, mh);
  add(@"rt_inside_shoulder", mh, rtInside);
  add(@"rt_lanes", rtInside, rtTravel);
  add(@"rt_shoulder", rtTravel, rtShoulder);
  return out;
}

- (SCNMaterial *)matWithColor:(UIColor *)c {
  SCNMaterial *m = [SCNMaterial material];
  m.diffuse.contents = c;
  m.doubleSided = YES;
  return m;
}

- (void)buildDeckInto:(SCNNode *)root {
  NSString *medianCat = dstr(self.road, @"median_category", @"NONE");
  for (NSDictionary *s in [self deckSpans]) {
    double x0 = [s[@"x0"] doubleValue], x1 = [s[@"x1"] doubleValue];
    NSString *kind = s[@"kind"];
    double wUnits = (x1 - x0) * kUnitsPerFt;
    if (wUnits <= 0) continue;
    SCNBox *box = [SCNBox boxWithWidth:wUnits height:kDeckThickness length:kDepth chamferRadius:0];
    box.firstMaterial = [self matWithColor:[self deckColorForKind:kind medianCategory:medianCat]];
    SCNNode *n = [SCNNode nodeWithGeometry:box];
    n.position = SCNVector3Make((float)([self xUnits:(x0 + x1) / 2.0]), (float)(-kDeckThickness / 2.0), 0);
    [root addChildNode:n];

    // Raised / barrier median gets a curb/barrier block above the deck.
    if ([kind isEqualToString:@"median"] && ([medianCat isEqualToString:@"RAISED"] || [medianCat isEqualToString:@"BARRIER"])) {
      double h = [medianCat isEqualToString:@"BARRIER"] ? 2.2 : 0.9;
      SCNBox *curb = [SCNBox boxWithWidth:MAX(0.4, wUnits * 0.8) height:h length:kDepth chamferRadius:0.1];
      curb.firstMaterial = [self matWithColor:[medianCat isEqualToString:@"BARRIER"] ? [UIColor colorWithWhite:0.62 alpha:1] : [UIColor colorWithWhite:0.45 alpha:1]];
      SCNNode *cn = [SCNNode nodeWithGeometry:curb];
      cn.position = SCNVector3Make((float)([self xUnits:(x0 + x1) / 2.0]), (float)(h / 2.0), 0);
      [root addChildNode:cn];
    }
  }
  [self buildLaneMarkingsInto:root medianCategory:medianCat];
}

- (UIColor *)deckColorForKind:(NSString *)kind medianCategory:(NSString *)medianCat {
  if ([kind hasSuffix:@"lanes"]) return [UIColor colorWithRed:0.20 green:0.22 blue:0.25 alpha:1];
  if ([kind hasSuffix:@"inside_shoulder"]) return [UIColor colorWithRed:0.34 green:0.37 blue:0.41 alpha:1];
  if ([kind hasSuffix:@"shoulder"]) return [UIColor colorWithRed:0.29 green:0.33 blue:0.37 alpha:1];
  if ([kind isEqualToString:@"median"]) {
    if ([medianCat isEqualToString:@"DEPRESSED"]) return [UIColor colorWithRed:0.25 green:0.42 blue:0.23 alpha:1];
    return [UIColor colorWithRed:0.20 green:0.22 blue:0.25 alpha:1];
  }
  return [UIColor colorWithWhite:0.25 alpha:1];
}

// Lane dividers (interior) + outer pavement edge lines + painted centerline.
- (void)buildLaneMarkingsInto:(SCNNode *)root medianCategory:(NSString *)medianCat {
  double mh = MAX(0, dnum(self.road, @"median_width_ft", 0)) / 2.0;
  double ltTravel = -(mh + dnum(self.road, @"lt_inside_shoulder_ft", 0) + dnum(self.road, @"lt_lane_count", 1) * dnum(self.road, @"lt_lane_width_ft", 12));
  double rtInside = mh + dnum(self.road, @"rt_inside_shoulder_ft", 0);
  double rtTravel = rtInside + dnum(self.road, @"rt_lane_count", 1) * dnum(self.road, @"rt_lane_width_ft", 12);
  UIColor *white = [UIColor colorWithWhite:0.95 alpha:1];
  UIColor *yellow = [UIColor colorWithRed:0.96 green:0.77 blue:0.27 alpha:1];

  void (^mark)(double, UIColor *) = ^(double offsetFt, UIColor *color) {
    SCNBox *b = [SCNBox boxWithWidth:0.18 height:0.12 length:kDepth chamferRadius:0];
    b.firstMaterial = [self matWithColor:color];
    b.firstMaterial.lightingModelName = SCNLightingModelConstant;
    SCNNode *n = [SCNNode nodeWithGeometry:b];
    n.position = SCNVector3Make((float)[self xUnits:offsetFt], 0.08f, 0);
    [root addChildNode:n];
  };
  // Interior lane dividers.
  for (int k = 1; k < (int)dnum(self.road, @"lt_lane_count", 1); k++) mark(ltTravel + k * dnum(self.road, @"lt_lane_width_ft", 12), white);
  for (int k = 1; k < (int)dnum(self.road, @"rt_lane_count", 1); k++) mark(rtInside + k * dnum(self.road, @"rt_lane_width_ft", 12), white);
  // Outer pavement edge lines.
  mark(ltTravel, white);
  mark(rtTravel, white);
  // Painted centerline for undivided / painted medians.
  if ([medianCat isEqualToString:@"NONE"] || [medianCat isEqualToString:@"PAINTED"]) mark(0, yellow);
}

// Elevation-driven terrain cutaway beyond one shoulder, extruded as a solid SCNShape.
- (void)buildGroundInto:(SCNNode *)root side:(NSString *)side edgeFt:(double)edgeFt {
  NSArray *samples = [self.slice[@"samples"] isKindOfClass:[NSArray class]] ? self.slice[@"samples"] : @[];
  BOOL isLT = [side isEqualToString:@"LT"];
  // Collect OK ground points beyond the shoulder edge, ordered outward from the edge.
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];  // CGPoint(x=offsetFt, y=elevFt)
  for (id s in samples) {
    if (![s isKindOfClass:[NSDictionary class]]) continue;
    if (![dstr(s, @"side", @"") isEqualToString:side]) continue;
    if (![dstr(s, @"status", @"") isEqualToString:@"OK"]) continue;
    id ev = s[@"elevationFt"]; if (disnull(ev)) continue;
    double off = dnum(s, @"offsetFt", 0);
    if (isLT ? (off > edgeFt + 1e-6) : (off < edgeFt - 1e-6)) continue;  // must be beyond the shoulder
    [pts addObject:[NSValue valueWithCGPoint:CGPointMake(off, [ev doubleValue])]];
  }
  if (pts.count < 1) return;   // no ground data -> draw nothing (honest; shown in legend)
  [pts sortUsingComparator:^NSComparisonResult(NSValue *a, NSValue *b) {
    double ao = fabs(a.CGPointValue.x - edgeFt), bo = fabs(b.CGPointValue.x - edgeFt);
    return ao < bo ? NSOrderedAscending : (ao > bo ? NSOrderedDescending : NSOrderedSame);
  }];

  UIBezierPath *path = [UIBezierPath bezierPath];
  // Ground meets the deck at the shoulder edge (datum level = y 0).
  [path moveToPoint:CGPointMake([self xUnits:edgeFt], [self yUnits:self.datumFt])];
  double minY = 0, lastX = [self xUnits:edgeFt];
  for (NSValue *v in pts) {
    CGPoint p = v.CGPointValue;
    double x = [self xUnits:p.x], y = [self yUnits:p.y];
    [path addLineToPoint:CGPointMake(x, y)];
    if (y < minY) minY = y;
    lastX = x;
  }
  double baseY = minY - 4.0;
  [path addLineToPoint:CGPointMake(lastX, baseY)];
  [path addLineToPoint:CGPointMake([self xUnits:edgeFt], baseY)];
  [path closePath];

  SCNShape *shape = [SCNShape shapeWithPath:path extrusionDepth:kDepth];
  shape.firstMaterial = [self matWithColor:[UIColor colorWithRed:0.36 green:0.42 blue:0.24 alpha:1]];
  SCNNode *n = [SCNNode nodeWithGeometry:shape];
  n.position = SCNVector3Make(0, 0, (float)(-kDepth / 2.0));  // centre the slab on z=0
  [root addChildNode:n];
}

// 10/20/50 ft stakes on both sides (posts). Colour by sample status.
- (void)buildStakesInto:(SCNNode *)root {
  NSDictionary *km = [self.slice[@"keyMarkers"] isKindOfClass:[NSDictionary class]] ? self.slice[@"keyMarkers"] : @{};
  NSArray *names = @[@"lt10ft", @"lt20ft", @"lt50ft", @"rt10ft", @"rt20ft", @"rt50ft"];
  for (NSString *name in names) {
    NSDictionary *mk = [km[name] isKindOfClass:[NSDictionary class]] ? km[name] : nil;
    if (mk == nil) continue;
    double off = dnum(mk, @"offsetFt", 0);
    NSString *status = dstr(mk, @"status", @"OUT_OF_BOUNDS");
    BOOL ok = [status isEqualToString:@"OK"];
    double groundY = 0;
    id ev = mk[@"elevationFt"];
    if (ok && !disnull(ev)) groundY = [self yUnits:[ev doubleValue]];
    SCNBox *post = [SCNBox boxWithWidth:0.16 height:2.4 length:0.16 chamferRadius:0];
    post.firstMaterial = [self matWithColor:ok ? [UIColor colorWithRed:0.90 green:0.33 blue:0.24 alpha:1] : [UIColor colorWithWhite:0.55 alpha:0.7]];
    post.firstMaterial.lightingModelName = SCNLightingModelConstant;
    SCNNode *n = [SCNNode nodeWithGeometry:post];
    n.position = SCNVector3Make((float)[self xUnits:off], (float)(groundY + 1.2), 0);
    [root addChildNode:n];
  }
}

#pragma mark - Camera + lighting

- (void)setupCamera {
  SCNCamera *cam = [SCNCamera camera];
  cam.usesOrthographicProjection = YES;
  cam.zNear = 0.1;
  cam.zFar = 500;
  self.cameraNode = [SCNNode node];
  self.cameraNode.camera = cam;
  // Above + downstation, looking UPSTATION (-Z) with a slight downward tilt (2.5D).
  self.cameraNode.position = SCNVector3Make((float)self.centerXUnits, 6.0f, 34.0f);
  SCNNode *target = [SCNNode node];
  target.position = SCNVector3Make((float)self.centerXUnits, 0.5f, 0);
  [self.scnView.scene.rootNode addChildNode:target];
  SCNLookAtConstraint *look = [SCNLookAtConstraint lookAtConstraintWithTarget:target];
  look.gimbalLockEnabled = YES;
  self.cameraNode.constraints = @[look];
  [self.scnView.scene.rootNode addChildNode:self.cameraNode];
  self.scnView.pointOfView = self.cameraNode;
  [self applyOrthoScale];
  self.defaultCamTransform = self.cameraNode.transform;
}

- (void)applyOrthoScale {
  if (self.cameraNode.camera == nil) return;
  CGSize sz = self.scnView.bounds.size;
  double aspect = (sz.height > 0 && sz.width > 0) ? (sz.width / sz.height) : 1.4;
  double halfW = MAX(2.0, self.contentHalfWidthUnits * 1.12);
  double orthoScale = aspect > 0 ? halfW / aspect : halfW;   // fit the full width
  self.cameraNode.camera.orthographicScale = orthoScale;
  self.defaultOrthoScale = orthoScale;
}

- (void)addLighting {
  SCNNode *amb = [SCNNode node];
  amb.light = [SCNLight light];
  amb.light.type = SCNLightTypeAmbient;
  amb.light.color = [UIColor colorWithWhite:0.55 alpha:1];
  [self.scnView.scene.rootNode addChildNode:amb];
  SCNNode *sun = [SCNNode node];
  sun.light = [SCNLight light];
  sun.light.type = SCNLightTypeDirectional;
  sun.light.color = [UIColor colorWithWhite:0.9 alpha:1];
  sun.eulerAngles = SCNVector3Make(-0.9f, 0.5f, 0);
  [self.scnView.scene.rootNode addChildNode:sun];
}

// Restore the default upstation ortho framing without disturbing the scene. Public so
// the inspection container's Reset can drive it when Technical is the active child.
- (void)resetCameraFraming {
  self.scnView.pointOfView = self.cameraNode;
  self.cameraNode.transform = self.defaultCamTransform;
  self.cameraNode.camera.orthographicScale = self.defaultOrthoScale;
}

- (void)onReset { [self resetCameraFraming]; }

#pragma mark - Overlays (labels, provenance, technical panel)

- (UILabel *)pinnedLabel:(NSString *)text size:(CGFloat)size {
  UILabel *l = [[UILabel alloc] init];
  l.translatesAutoresizingMaskIntoConstraints = NO;
  l.text = text;
  l.font = [UIFont systemFontOfSize:size weight:UIFontWeightSemibold];
  l.textColor = [UIColor whiteColor];
  [self.view addSubview:l];
  return l;
}

- (void)addOverlays {
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  NSDictionary *prov = [self.slice[@"provenance"] isKindOfClass:[NSDictionary class]] ? self.slice[@"provenance"] : @{};

  UILabel *lt = [self pinnedLabel:@"LT" size:16];
  UILabel *rt = [self pinnedLabel:@"RT" size:16];
  UILabel *up = [self pinnedLabel:@"Looking upstation" size:13];

  // Self-contained "Values" toggle (works when embedded in the inspection container,
  // where this controller's own nav-bar items are not shown).
  UIButton *valuesBtn = [UIButton buttonWithType:UIButtonTypeSystem];
  valuesBtn.translatesAutoresizingMaskIntoConstraints = NO;
  [valuesBtn setTitle:@"Values" forState:UIControlStateNormal];
  valuesBtn.titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
  [valuesBtn setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
  valuesBtn.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
  valuesBtn.layer.cornerRadius = 8; valuesBtn.contentEdgeInsets = UIEdgeInsetsMake(6, 12, 6, 12);
  [valuesBtn addTarget:self action:@selector(onToggleTechnical) forControlEvents:UIControlEventTouchUpInside];
  [self.view addSubview:valuesBtn];
  [NSLayoutConstraint activateConstraints:@[
    [valuesBtn.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-12],
    [valuesBtn.topAnchor constraintEqualToAnchor:g.topAnchor constant:40],
  ]];
  NSString *route = dstr(self.road, @"route_name", nil);
  NSString *pm = [self postmileText];
  NSString *hdr = route ? [NSString stringWithFormat:@"Route %@%@", route, pm.length ? [@"  ·  " stringByAppendingString:pm] : @""] : pm;
  UILabel *header = [self pinnedLabel:(hdr.length ? hdr : @"") size:11];
  header.textColor = [UIColor colorWithWhite:0.8 alpha:1];

  [NSLayoutConstraint activateConstraints:@[
    [lt.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:14],
    [lt.topAnchor constraintEqualToAnchor:g.topAnchor constant:10],
    [rt.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-14],
    [rt.topAnchor constraintEqualToAnchor:g.topAnchor constant:10],
    [up.centerXAnchor constraintEqualToAnchor:g.centerXAnchor],
    [up.topAnchor constraintEqualToAnchor:g.topAnchor constant:8],
    [header.centerXAnchor constraintEqualToAnchor:g.centerXAnchor],
    [header.topAnchor constraintEqualToAnchor:up.bottomAnchor constant:2],
  ]];

  // Always-visible stake legend (honest values; kept compact so the scene stays clean).
  self.legendLabel = [[UILabel alloc] init];
  self.legendLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.legendLabel.numberOfLines = 0;
  self.legendLabel.font = [UIFont monospacedDigitSystemFontOfSize:10 weight:UIFontWeightRegular];
  self.legendLabel.textColor = [UIColor colorWithWhite:0.92 alpha:1];
  self.legendLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
  self.legendLabel.text = [self stakeLegendText];
  [self.view addSubview:self.legendLabel];

  // Provenance footer (honest labelling).
  UILabel *footer = [[UILabel alloc] init];
  footer.translatesAutoresizingMaskIntoConstraints = NO;
  footer.numberOfLines = 0;
  footer.font = [UIFont systemFontOfSize:10];
  footer.textColor = [UIColor colorWithWhite:0.78 alpha:1];
  footer.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
  NSString *layoutSrc = dstr(prov, @"roadLayoutSource", @"DEFAULT");
  NSString *layoutLabel = [layoutSrc isEqualToString:@"ROAD_INVENTORY"] ? @"Road Inventory" : ([layoutSrc isEqualToString:@"FORM_FIELDS"] ? @"form/default assumptions" : @"default assumptions");
  NSString *snapNote = [prov[@"snappedToRoadContext"] boolValue]
      ? [NSString stringWithFormat:@"Snapped to %@", dstr(prov, @"roadContextSource", @"road context")]
      : @"Fallback orientation (not snapped to a road feature)";
  // Part 10: never imply LT/RT are authoritative Caltrans directions when the upstation
  // is only geometry-derived.
  NSString *orientNote = [self.slice[@"orientationAuthoritative"] boolValue]
      ? @"Upstation from the packaged bearing."
      : @"Orientation follows packaged centerline geometry; upstation is not verified.";
  NSString *defaultNote = [layoutSrc isEqualToString:@"DEFAULT"]
      ? @"\nDefault roadway assumptions — verify lane, shoulder, and median dimensions." : @"";
  footer.text = [NSString stringWithFormat:
                 @"Roadway layout: %@  ·  Ground elevation: USGS 3DEP offline grid\n%@\n%@\nRoadway surface is schematic unless pavement crown/superelevation data is available.%@",
                 layoutLabel, snapNote, orientNote, defaultNote];
  [self.view addSubview:footer];

  [NSLayoutConstraint activateConstraints:@[
    [self.legendLabel.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [self.legendLabel.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [self.legendLabel.bottomAnchor constraintEqualToAnchor:footer.topAnchor constant:-6],
    [footer.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [footer.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [footer.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-8],
  ]];

  // Technical panel (exact dimensions + sample values), hidden until toggled.
  self.technicalPanel = [[UITextView alloc] init];
  self.technicalPanel.translatesAutoresizingMaskIntoConstraints = NO;
  self.technicalPanel.editable = NO;
  self.technicalPanel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.78];
  self.technicalPanel.textColor = [UIColor colorWithWhite:0.95 alpha:1];
  self.technicalPanel.font = [UIFont monospacedSystemFontOfSize:10 weight:UIFontWeightRegular];
  self.technicalPanel.hidden = YES;
  self.technicalPanel.text = [self technicalText];
  [self.view addSubview:self.technicalPanel];
  [NSLayoutConstraint activateConstraints:@[
    [self.technicalPanel.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [self.technicalPanel.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [self.technicalPanel.topAnchor constraintEqualToAnchor:header.bottomAnchor constant:8],
    [self.technicalPanel.heightAnchor constraintLessThanOrEqualToAnchor:g.heightAnchor multiplier:0.42],
  ]];
}

- (void)onToggleTechnical {
  self.technical = !self.technical;
  self.technicalPanel.hidden = !self.technical;
  self.technicalItem.title = self.technical ? @"Hide values" : @"Technical";
}

- (NSString *)postmileText {
  id b = self.road[@"begin_pm"], e = self.road[@"end_pm"];
  if (!disnull(b) && !disnull(e)) return [NSString stringWithFormat:@"PM %@–%@", b, e];
  if (!disnull(b)) return [NSString stringWithFormat:@"PM %@", b];
  return @"";
}

- (NSString *)markerLine:(NSDictionary *)km name:(NSString *)name label:(NSString *)label ref:(NSDictionary *)ref {
  NSDictionary *mk = [km[name] isKindOfClass:[NSDictionary class]] ? km[name] : nil;
  if (mk == nil) return [NSString stringWithFormat:@"%@: —", label];
  NSString *status = dstr(mk, @"status", @"OUT_OF_BOUNDS");
  if (![status isEqualToString:@"OK"] || disnull(mk[@"elevationFt"])) {
    return [NSString stringWithFormat:@"%@: %@", label, [status isEqualToString:@"NO_DATA"] ? @"No data" : @"Outside package"];
  }
  double e = [mk[@"elevationFt"] doubleValue];
  NSString *delta = @"";
  if (ref && !disnull(ref[@"elevationFt"]) && [dstr(ref, @"status", @"") isEqualToString:@"OK"]) {
    double d = e - [ref[@"elevationFt"] doubleValue];
    delta = [NSString stringWithFormat:@" (%@%.1f ft)", d >= 0 ? @"+" : @"", d];
  }
  return [NSString stringWithFormat:@"%@: %.1f ft%@", label, e, delta];
}

- (NSString *)stakeLegendText {
  NSDictionary *km = [self.slice[@"keyMarkers"] isKindOfClass:[NSDictionary class]] ? self.slice[@"keyMarkers"] : @{};
  NSDictionary *ltRef = [km[@"ltOutsideShoulderEdge"] isKindOfClass:[NSDictionary class]] ? km[@"ltOutsideShoulderEdge"] : nil;
  NSDictionary *rtRef = [km[@"rtOutsideShoulderEdge"] isKindOfClass:[NSDictionary class]] ? km[@"rtOutsideShoulderEdge"] : nil;
  NSString *lt = [NSString stringWithFormat:@"LT beyond shoulder — %@   %@   %@",
                  [self markerLine:km name:@"lt10ft" label:@"10ft" ref:ltRef],
                  [self markerLine:km name:@"lt20ft" label:@"20ft" ref:ltRef],
                  [self markerLine:km name:@"lt50ft" label:@"50ft" ref:ltRef]];
  NSString *rt = [NSString stringWithFormat:@"RT beyond shoulder — %@   %@   %@",
                  [self markerLine:km name:@"rt10ft" label:@"10ft" ref:rtRef],
                  [self markerLine:km name:@"rt20ft" label:@"20ft" ref:rtRef],
                  [self markerLine:km name:@"rt50ft" label:@"50ft" ref:rtRef]];
  return [NSString stringWithFormat:@"  %@\n  %@  ", lt, rt];
}

- (NSString *)technicalText {
  NSMutableString *s = [NSMutableString string];
  [s appendString:@"ROAD CROSS SECTION — technical\n\n"];
  [s appendFormat:@"Cross-section bearing: %.0f°  (upstation %.0f°)\n",
   dnum(self.slice, @"crossSectionBearingDeg", 0), dnum(self.slice, @"upstationBearingDeg", 0)];
  [s appendFormat:@"Total width: %.1f ft\n\n", dnum(self.road, @"total_width_ft", 0)];
  [s appendString:@"Roadway elements (LT→RT), widths in feet:\n"];
  for (NSDictionary *sp in [self deckSpans]) {
    [s appendFormat:@"  %@: %.1f ft  [%.1f … %.1f]\n", sp[@"kind"],
     ([sp[@"x1"] doubleValue] - [sp[@"x0"] doubleValue]), [sp[@"x0"] doubleValue], [sp[@"x1"] doubleValue]];
  }
  [s appendFormat:@"  median: %.1f ft (%@)\n\n", dnum(self.road, @"median_width_ft", 0), dstr(self.road, @"median_category", @"NONE")];
  [s appendString:@"Ground samples beyond shoulder (USGS 3DEP offline grid):\n"];
  [s appendFormat:@"  %@\n", [self stakeLegendText]];
  [s appendString:@"\nElevations sampled from the packaged terrain grid; missing samples shown as No data / Outside package (never interpolated beyond coverage).\n"];
  return s;
}

@end
