#import "ErisRoadSliceSceneViewController.h"
#import <SceneKit/SceneKit.h>

// Scene scale: feet -> scene units, plus a modest vertical exaggeration so terrain
// slope reads without dominating. All procedural — no textures, no network.
static const double kUnitsPerFt = 0.40;
static const double kVExag = 2.0;
static const double kDepth = 8.0;          // along-road extrusion (upstation slab depth)
static const double kDeckThickness = 1.2;
static const double kFtPerM = 3.280839895;

static NSString *const kSliceRenderingObservedDividedCorridor = @"observed_divided_corridor";
static NSString *const kSliceMedianSeparationLabel  = @"Median / separation area";
static NSString *const kSliceMedianSeparationDetail =
    @"Interval between observed carriageway centerlines. Pavement edges and physical median width are unavailable.";

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
// The shared immutable divided-corridor model from the terrain controller. READ ONLY —
// this view renders it and never reprojects the station or re-derives the section.
@property(nonatomic, strong) NSDictionary *inspectionGeometry;
@property(nonatomic, assign) BOOL sceneReleased;
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
  return [self initWithSlice:slice inspectionGeometry:nil];
}

- (instancetype)initWithSlice:(NSDictionary *)slice inspectionGeometry:(NSDictionary *)inspectionGeometry {
  if ((self = [super init])) {
    _slice = [slice isKindOfClass:[NSDictionary class]] ? slice : @{};
    _road = [_slice[@"road"] isKindOfClass:[NSDictionary class]] ? _slice[@"road"] : @{};
    _inspectionGeometry = [inspectionGeometry isKindOfClass:[NSDictionary class]] ? inspectionGeometry : nil;
  }
  return self;
}

// The ONLY switch onto the observed-divided path. When it is YES this controller must not
// touch the roadway template at all: no shoulderEdgeFt, no deckSpans, no buildDeckInto, no
// buildLaneMarkingsInto, and no DEFAULT lane counts / lane widths / median. The package
// contains two observed centerlines and terrain — nothing else may be drawn as fact.
- (BOOL)isObservedDividedCorridor {
  return self.inspectionGeometry != nil &&
         [dstr(self.slice, @"renderingMode", @"") isEqualToString:kSliceRenderingObservedDividedCorridor];
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

  // The divided path derives its datum from the station itself — deckElevationFt would
  // bound the average by the DEFAULT template's shoulder edges, which do not exist here.
  self.datumFt = [self isObservedDividedCorridor] ? [self stationElevationFt:&_hasElevation]
                                                  : [self deckElevationFt:&_hasElevation];
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

- (void)onClose {
  [self releaseSceneResources];
  [self dismissViewControllerAnimated:YES completion:nil];
}

#pragma mark - Deterministic teardown (Part 12F)

// Release geometry, materials and the camera as soon as the section closes rather than
// waiting on dealloc timing. Idempotent — safe from onClose, viewDidDisappear and dealloc.
- (void)releaseSceneResources {
  if (self.sceneReleased) return;
  self.sceneReleased = YES;
  self.scnView.playing = NO;
  self.scnView.delegate = nil;
  SCNScene *scene = self.scnView.scene;
  if (scene) {
    [scene.rootNode enumerateChildNodesUsingBlock:^(SCNNode *node, BOOL *stop) {
      for (SCNMaterial *m in node.geometry.materials) {
        m.diffuse.contents = nil; m.normal.contents = nil; m.emission.contents = nil;
      }
      node.geometry = nil;
      node.light = nil;
      node.camera = nil;
      node.constraints = nil;
    }];
    for (SCNNode *child in [scene.rootNode.childNodes copy]) [child removeFromParentNode];
  }
  self.scnView.pointOfView = nil;
  self.scnView.scene = nil;
  self.cameraNode = nil;
}

// NOTE: no viewDidDisappear teardown here. The inspection container detaches the inactive
// child when the mode switches, so releasing on disappear would destroy a scene the user
// is about to return to. The container owns the lifetime and calls this on close.
- (void)dealloc {
  [self releaseSceneResources];
}

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

// Datum for the observed-divided path: the ground elevation at the station (offset 0),
// else the mean of the OK samples inside the section. No template geometry is consulted.
- (double)stationElevationFt:(BOOL *)outHasElevation {
  NSArray *samples = [self.slice[@"samples"] isKindOfClass:[NSArray class]] ? self.slice[@"samples"] : @[];
  double sum = 0; int n = 0; BOOL any = NO; double center = NAN;
  double minOff = dnum(self.inspectionGeometry, @"sectionMinOffsetM", -60) * kFtPerM;
  double maxOff = dnum(self.inspectionGeometry, @"sectionMaxOffsetM", 60) * kFtPerM;
  for (id s in samples) {
    if (![s isKindOfClass:[NSDictionary class]]) continue;
    if (![dstr(s, @"status", @"") isEqualToString:@"OK"]) continue;
    id ev = s[@"elevationFt"]; if (disnull(ev)) continue;
    double e = [ev doubleValue], off = dnum(s, @"offsetFt", 0);
    any = YES;
    if (off == 0) center = e;
    if (off >= minOff - 1e-6 && off <= maxOff + 1e-6) { sum += e; n++; }
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
  // Observed divided corridor: an entirely separate, template-free path.
  if ([self isObservedDividedCorridor]) { [self buildObservedDividedCorridorScene]; return; }

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

#pragma mark - Observed divided corridor (Part 12C) — template-free

// OK ground samples inside the section, sorted by offset. CGPoint(x=offsetFt, y=elevFt).
- (NSArray<NSValue *> *)dividedGroundPointsFt {
  NSArray *samples = [self.slice[@"samples"] isKindOfClass:[NSArray class]] ? self.slice[@"samples"] : @[];
  double minOff = dnum(self.inspectionGeometry, @"sectionMinOffsetM", -60) * kFtPerM;
  double maxOff = dnum(self.inspectionGeometry, @"sectionMaxOffsetM", 60) * kFtPerM;
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];
  for (id s in samples) {
    if (![s isKindOfClass:[NSDictionary class]]) continue;
    if (![dstr(s, @"status", @"") isEqualToString:@"OK"]) continue;
    id ev = s[@"elevationFt"]; if (disnull(ev)) continue;
    double off = dnum(s, @"offsetFt", 0);
    if (off < minOff - 1e-6 || off > maxOff + 1e-6) continue;
    [pts addObject:[NSValue valueWithCGPoint:CGPointMake(off, [ev doubleValue])]];
  }
  [pts sortUsingComparator:^NSComparisonResult(NSValue *a, NSValue *b) {
    double ax = a.CGPointValue.x, bx = b.CGPointValue.x;
    return ax < bx ? NSOrderedAscending : (ax > bx ? NSOrderedDescending : NSOrderedSame);
  }];
  return pts;
}

// The truthful divided section. Everything here comes from the shared inspection model or
// the packaged terrain grid: one continuous ground profile across the section, a marker on
// each OBSERVED carriageway centerline, the geometry-derived midpoint, and the measured
// separation between the two. No deck, no lanes, no shoulders, no median block — the
// package does not contain pavement edges, so none are drawn.
- (void)buildObservedDividedCorridorScene {
  SCNNode *root = self.scnView.scene.rootNode;
  NSDictionary *dc = self.inspectionGeometry;
  double minOffFt = dnum(dc, @"sectionMinOffsetM", -60) * kFtPerM;
  double maxOffFt = dnum(dc, @"sectionMaxOffsetM", 60) * kFtPerM;
  self.centerXUnits = [self xUnits:(minOffFt + maxOffFt) / 2.0];
  self.contentHalfWidthUnits = [self xUnits:(maxOffFt - minOffFt) / 2.0];

  [self buildDividedGroundInto:root];

  double aOffFt = dnum(dc[@"memberA"], @"offsetM", 0) * kFtPerM;
  double bOffFt = dnum(dc[@"memberB"], @"offsetM", 0) * kFtPerM;
  UIColor *memberColor = [UIColor colorWithRed:0.55 green:0.80 blue:1.0 alpha:1.0];
  UIColor *midColor = [UIColor colorWithRed:1.0 green:0.82 blue:0.28 alpha:1.0];
  [self addDividedMarkerInto:root offsetFt:aOffFt color:memberColor heightUnits:3.4];
  [self addDividedMarkerInto:root offsetFt:bOffFt color:memberColor heightUnits:3.4];
  // The selected feature: the geometry-derived midpoint (offset 0 = the station).
  [self addDividedMarkerInto:root offsetFt:0 color:midColor heightUnits:4.6];

  [self addSeparationDimensionInto:root fromFt:aOffFt toFt:bOffFt];
}

// One continuous ground profile across the whole section (not per-shoulder), extruded.
- (void)buildDividedGroundInto:(SCNNode *)root {
  NSArray<NSValue *> *pts = [self dividedGroundPointsFt];
  if (pts.count < 2) return;             // no profile -> draw nothing (stated in the panel)
  UIBezierPath *path = [UIBezierPath bezierPath];
  double minY = 0;
  CGPoint first = pts.firstObject.CGPointValue, last = pts.lastObject.CGPointValue;
  [path moveToPoint:CGPointMake([self xUnits:first.x], [self yUnits:first.y])];
  for (NSValue *v in pts) {
    CGPoint p = v.CGPointValue;
    double y = [self yUnits:p.y];
    [path addLineToPoint:CGPointMake([self xUnits:p.x], y)];
    if (y < minY) minY = y;
  }
  double baseY = minY - 4.0;
  [path addLineToPoint:CGPointMake([self xUnits:last.x], baseY)];
  [path addLineToPoint:CGPointMake([self xUnits:first.x], baseY)];
  [path closePath];
  SCNShape *shape = [SCNShape shapeWithPath:path extrusionDepth:kDepth];
  shape.firstMaterial = [self matWithColor:[UIColor colorWithRed:0.36 green:0.42 blue:0.24 alpha:1]];
  SCNNode *n = [SCNNode nodeWithGeometry:shape];
  n.position = SCNVector3Make(0, 0, (float)(-kDepth / 2.0));
  [root addChildNode:n];
}

// Ground elevation (ft) at an offset, INTERPOLATED STRICTLY BETWEEN real OK samples.
//
// An offset outside the sampled range has no packaged terrain under it. Returning the first
// or last sample there would present the nearest known ground as though it were measured at
// that offset — a flat extrapolation that reads as fact. Such an offset is simply not found,
// and the caller must show nothing rather than a guess.
- (double)dividedGroundElevAtFt:(double)offsetFt found:(BOOL *)found {
  NSArray<NSValue *> *pts = [self dividedGroundPointsFt];
  if (found) *found = NO;
  if (pts.count < 2) return self.datumFt;
  CGPoint first = pts.firstObject.CGPointValue, last = pts.lastObject.CGPointValue;
  const double eps = 1e-6;
  if (offsetFt < first.x - eps || offsetFt > last.x + eps) return self.datumFt;   // outside real coverage
  CGPoint prev = first;
  for (NSValue *v in pts) {
    CGPoint p = v.CGPointValue;
    if (p.x >= offsetFt) {
      double span = p.x - prev.x;
      double t = span > 1e-9 ? (offsetFt - prev.x) / span : 0;
      if (found) *found = YES;
      return prev.y + (p.y - prev.y) * t;
    }
    prev = p;
  }
  if (found) *found = YES;   // exactly at the last sample
  return last.y;
}

// A vertical post pinning an observed centerline to the ground profile. Drawn ONLY where
// the package actually has terrain: without a real sample there is no honest elevation to
// pin it to, so the marker is omitted and the panel states the gap.
- (void)addDividedMarkerInto:(SCNNode *)root offsetFt:(double)offsetFt color:(UIColor *)color heightUnits:(double)h {
  BOOL found = NO;
  double elevFt = [self dividedGroundElevAtFt:offsetFt found:&found];
  if (!found) return;                        // no packaged ground here -> no marker
  double groundY = [self yUnits:elevFt];
  SCNBox *post = [SCNBox boxWithWidth:0.18 height:h length:0.18 chamferRadius:0];
  post.firstMaterial = [self matWithColor:color];
  post.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *n = [SCNNode nodeWithGeometry:post];
  n.position = SCNVector3Make((float)[self xUnits:offsetFt], (float)(groundY + h / 2.0), 0);
  [root addChildNode:n];
  SCNSphere *knob = [SCNSphere sphereWithRadius:0.22];
  knob.firstMaterial = [self matWithColor:color];
  knob.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *k = [SCNNode nodeWithGeometry:knob];
  k.position = SCNVector3Make((float)[self xUnits:offsetFt], (float)(groundY + h), 0);
  [root addChildNode:k];
}

// The measured separation drawn as a dimension bar between the two observed centerlines.
// It spans the "Median / separation area" — an INTERVAL, not a pavement surface, so it is
// drawn as a thin annotation line and never as a deck.
- (void)addSeparationDimensionInto:(SCNNode *)root fromFt:(double)aFt toFt:(double)bFt {
  double lo = MIN(aFt, bFt), hi = MAX(aFt, bFt);
  double wUnits = (hi - lo) * kUnitsPerFt;
  if (wUnits <= 1e-6) return;
  // Both ends need real ground; otherwise the bar would span between a measured point and
  // an extrapolated one. The measured separation is still stated in the panel and legend.
  BOOL fLo = NO, fHi = NO;
  double eLo = [self dividedGroundElevAtFt:lo found:&fLo], eHi = [self dividedGroundElevAtFt:hi found:&fHi];
  if (!fLo || !fHi) return;
  double y = MAX([self yUnits:eLo], [self yUnits:eHi]) + 4.2;
  SCNBox *bar = [SCNBox boxWithWidth:wUnits height:0.10 length:0.10 chamferRadius:0];
  bar.firstMaterial = [self matWithColor:[UIColor colorWithRed:1.0 green:0.45 blue:0.30 alpha:1.0]];
  bar.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *n = [SCNNode nodeWithGeometry:bar];
  n.position = SCNVector3Make((float)[self xUnits:(lo + hi) / 2.0], (float)y, 0);
  n.name = kSliceMedianSeparationLabel;
  [root addChildNode:n];
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

  // Orientation labels DEPEND on whether the upstation bearing is authoritative (PR #51
  // review). Geometry-derived orientation must never present a prominent, unconditional
  // "Looking upstation" / LT / RT that only a footer contradicts.
  BOOL orientAuth = [self.slice[@"orientationAuthoritative"] boolValue];
  UILabel *lt = [self pinnedLabel:(orientAuth ? @"LT" : @"Display left") size:16];
  UILabel *rt = [self pinnedLabel:(orientAuth ? @"RT" : @"Display right") size:16];
  UILabel *up = [self pinnedLabel:(orientAuth ? @"Looking upstation" : @"Looking along packaged centerline") size:13];

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

  // Prominent (not footer-only) warning when orientation is geometry-derived.
  if (!orientAuth) {
    UILabel *warn = [self pinnedLabel:@"Upstation and LT/RT are not verified." size:12];
    warn.textAlignment = NSTextAlignmentCenter;
    warn.textColor = [UIColor colorWithRed:1.0 green:0.80 blue:0.30 alpha:1.0];
    [NSLayoutConstraint activateConstraints:@[
      [warn.centerXAnchor constraintEqualToAnchor:g.centerXAnchor],
      [warn.topAnchor constraintEqualToAnchor:header.bottomAnchor constant:3],
      [warn.leadingAnchor constraintGreaterThanOrEqualToAnchor:g.leadingAnchor constant:8],
      [warn.trailingAnchor constraintLessThanOrEqualToAnchor:g.trailingAnchor constant:-8],
    ]];
  }

  // Always-visible stake legend (honest values; kept compact so the scene stays clean).
  self.legendLabel = [[UILabel alloc] init];
  self.legendLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.legendLabel.numberOfLines = 0;
  self.legendLabel.font = [UIFont monospacedDigitSystemFontOfSize:10 weight:UIFontWeightRegular];
  self.legendLabel.textColor = [UIColor colorWithWhite:0.92 alpha:1];
  self.legendLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
  self.legendLabel.text = [self isObservedDividedCorridor] ? [self dividedLegendText] : [self stakeLegendText];
  [self.view addSubview:self.legendLabel];

  // Provenance footer (honest labelling).
  UILabel *footer = [[UILabel alloc] init];
  footer.translatesAutoresizingMaskIntoConstraints = NO;
  footer.numberOfLines = 0;
  footer.font = [UIFont systemFontOfSize:10];
  footer.textColor = [UIColor colorWithWhite:0.78 alpha:1];
  footer.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
  NSString *snapNote = [prov[@"snappedToRoadContext"] boolValue]
      ? [NSString stringWithFormat:@"Snapped to %@", dstr(prov, @"roadContextSource", @"road context")]
      : @"Fallback orientation (not snapped to a road feature)";
  // Part 10: never imply LT/RT are authoritative Caltrans directions when the upstation
  // is only geometry-derived.
  NSString *orientNote = [self.slice[@"orientationAuthoritative"] boolValue]
      ? @"Upstation from the packaged bearing."
      : @"Orientation follows packaged centerline geometry; upstation is not verified.";
  if ([self isObservedDividedCorridor]) {
    // No roadway-layout line: there is no layout. Only what was observed, plus the limit.
    NSDictionary *dc = self.inspectionGeometry;
    footer.text = [NSString stringWithFormat:
                   @"Observed divided corridor: two carriageway centerlines (%@)  ·  Ground elevation: USGS 3DEP offline grid\n%@\n%@\n%@ — %@",
                   dstr(dc, @"pairingMethod", @"station-local pairing"), snapNote, orientNote,
                   kSliceMedianSeparationLabel, kSliceMedianSeparationDetail];
  } else {
    NSString *layoutSrc = dstr(prov, @"roadLayoutSource", @"DEFAULT");
    NSString *layoutLabel = [layoutSrc isEqualToString:@"ROAD_INVENTORY"] ? @"Road Inventory" : ([layoutSrc isEqualToString:@"FORM_FIELDS"] ? @"form/default assumptions" : @"default assumptions");
    NSString *defaultNote = [layoutSrc isEqualToString:@"DEFAULT"]
        ? @"\nDefault roadway assumptions — verify lane, shoulder, and median dimensions." : @"";
    footer.text = [NSString stringWithFormat:
                   @"Roadway layout: %@  ·  Ground elevation: USGS 3DEP offline grid\n%@\n%@\nRoadway surface is schematic unless pavement crown/superelevation data is available.%@",
                   layoutLabel, snapNote, orientNote, defaultNote];
  }
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

// Compact legend for the divided path: the two OBSERVED centerlines and their measured
// separation. The stake legend is template-relative ("beyond shoulder") and cannot be
// stated here, so it is not shown.
- (NSString *)dividedLegendText {
  NSDictionary *dc = self.inspectionGeometry;
  NSDictionary *ma = dc[@"memberA"], *mb = dc[@"memberB"];
  return [NSString stringWithFormat:@"  %@: %+.1f m   ·   %@: %+.1f m   ·   %@: %.1f m\n  %@  ",
          dstr(ma, @"label", @"Centerline A"), dnum(ma, @"offsetM", 0),
          dstr(mb, @"label", @"Centerline B"), dnum(mb, @"offsetM", 0),
          kSliceMedianSeparationLabel, dnum(dc, @"separationM", 0),
          kSliceMedianSeparationDetail];
}

// Technical values for the divided path. Split explicitly into what was OBSERVED and what
// is UNAVAILABLE, so no reader can mistake the separation interval for a measured median
// or infer a lane arrangement that the package does not contain.
- (NSString *)dividedTechnicalText {
  NSDictionary *dc = self.inspectionGeometry;
  NSDictionary *ma = dc[@"memberA"], *mb = dc[@"memberB"];
  double sep = dnum(dc, @"separationM", 0);
  NSMutableString *s = [NSMutableString string];
  [s appendString:@"OBSERVED DIVIDED CORRIDOR — technical\n\n"];
  [s appendFormat:@"Rendering mode: %@\n", dstr(dc, @"renderingMode", kSliceRenderingObservedDividedCorridor)];
  [s appendFormat:@"Corridor feature: %@\n", dstr(dc, @"featureId", @"—")];
  [s appendFormat:@"Cross-section bearing: %.0f°  (corridor axis %.0f°)\n\n",
   dnum(self.slice, @"crossSectionBearingDeg", 0), dnum(dc, @"axialTangent", 0)];

  [s appendString:@"OBSERVED (measured from packaged geometry):\n"];
  [s appendFormat:@"  %@: offset %+.2f m (%+.1f ft), %.2f m from station\n",
   dstr(ma, @"label", @"Centerline A"), dnum(ma, @"offsetM", 0), dnum(ma, @"offsetM", 0) * kFtPerM,
   dnum(ma, @"distanceFromStationM", 0)];
  [s appendFormat:@"  %@: offset %+.2f m (%+.1f ft), %.2f m from station\n",
   dstr(mb, @"label", @"Centerline B"), dnum(mb, @"offsetM", 0), dnum(mb, @"offsetM", 0) * kFtPerM,
   dnum(mb, @"distanceFromStationM", 0)];
  [s appendFormat:@"  %@: %.2f m (%.1f ft) centerline-to-centerline\n", kSliceMedianSeparationLabel, sep, sep * kFtPerM];
  [s appendFormat:@"  Corridor midpoint: offset 0.00 m (%@)\n", dstr(dc, @"orientationSource", @"geometry-derived")];
  [s appendFormat:@"  Pairing: %@ (%@)\n", dstr(dc, @"pairingMethod", @"station-local"), dstr(dc, @"pairingVersion", @"—")];
  [s appendFormat:@"  Section extent: %.1f … %.1f m about the midpoint\n\n",
   dnum(dc, @"sectionMinOffsetM", 0), dnum(dc, @"sectionMaxOffsetM", 0)];

  [s appendString:@"UNAVAILABLE (not present in this package — not drawn, not assumed):\n"];
  [s appendString:@"  Lane count · lane width · shoulder width · pavement edges · physical median width · surface type\n"];
  [s appendFormat:@"  %@\n\n", kSliceMedianSeparationDetail];

  [s appendString:@"Ground profile (USGS 3DEP offline grid):\n"];
  NSArray<NSValue *> *pts = [self dividedGroundPointsFt];
  [s appendFormat:@"  %lu OK samples across the section%@\n", (unsigned long)pts.count,
   pts.count < 2 ? @" — profile unavailable, nothing drawn" : @""];
  if (pts.count >= 2) {
    [s appendFormat:@"  Measured from %.1f to %.1f ft about the midpoint\n",
     pts.firstObject.CGPointValue.x, pts.lastObject.CGPointValue.x];
  }
  // Terrain is never extrapolated past the sampled range: say so where a marker is absent.
  BOOL fa = NO, fb = NO;
  [self dividedGroundElevAtFt:dnum(ma, @"offsetM", 0) * kFtPerM found:&fa];
  [self dividedGroundElevAtFt:dnum(mb, @"offsetM", 0) * kFtPerM found:&fb];
  if (!fa || !fb) {
    [s appendFormat:@"  %@ has no packaged ground at its offset — its marker is omitted rather than placed at an assumed elevation.\n",
     !fa ? dstr(ma, @"label", @"Centerline A") : dstr(mb, @"label", @"Centerline B")];
  }
  [s appendString:@"\nElevations sampled from the packaged terrain grid; missing samples are omitted (never interpolated beyond coverage).\n"];
  return s;
}

- (NSString *)technicalText {
  if ([self isObservedDividedCorridor]) return [self dividedTechnicalText];
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
