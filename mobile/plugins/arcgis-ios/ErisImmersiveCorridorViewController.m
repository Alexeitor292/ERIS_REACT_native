#import "ErisImmersiveCorridorViewController.h"
#import <SceneKit/SceneKit.h>

// Immersive corridor scale + display. The corridor is a small north-up terrain patch;
// the CAMERA is oriented along the roadway to give the immersive along-road view (the
// mesh itself is not rotated, so the composited north-up aerial drape stays aligned).
static const double kCorridorWorldHalf = 100.0;   // scene half-extent for the larger patch dimension
static const double kCorridorVExag     = 1.5;     // modest display exaggeration (inspection readability)
static const double kCorridorPlaneHtM  = 9.0;     // cross-section plane height above the road

static NSString *const kCorRenderingObservedDividedCorridor = @"observed_divided_corridor";
static NSString *const kCorMedianSeparationLabel = @"Median / separation area";

static double CorNum(NSDictionary *d, NSString *k, double def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : def;
}
static NSString *CorStr(NSDictionary *d, NSString *k, NSString *def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v isKindOfClass:[NSString class]] ? v : def;
}

@interface ErisImmersiveCorridorViewController ()
@property(nonatomic, strong) NSDictionary *slice;
@property(nonatomic, strong) NSDictionary *corridor;
// The shared immutable divided-corridor model from the terrain controller. READ ONLY —
// this view renders it and never reprojects the station or re-derives the section.
@property(nonatomic, strong) NSDictionary *inspectionGeometry;
@property(nonatomic, assign) BOOL sceneReleased;
@property(nonatomic, strong) SCNView *scnView;
@property(nonatomic, strong) SCNNode *cameraNode;
@property(nonatomic, assign) NSInteger cols, rows;
@property(nonatomic, assign) double widthM, depthM, minElevM, supm;
@property(nonatomic, strong) NSArray<NSNumber *> *heights;
@property(nonatomic, assign) SCNVector3 focusCenter;      // the SNAPPED STATION on the surface (scene units)
@property(nonatomic, assign) double stationEastM, stationSouthM;   // station offset from the patch centre
@property(nonatomic, assign) double upstationDeg;
@property(nonatomic, assign) SCNMatrix4 defaultCamTransform;
@property(nonatomic, assign) SCNVector3 defaultCamTarget;
@end

@implementation ErisImmersiveCorridorViewController

- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor
           inspectionGeometry:(NSDictionary *)inspectionGeometry {
  if ((self = [super init])) {
    _slice = [slice isKindOfClass:[NSDictionary class]] ? slice : @{};
    _corridor = [corridor isKindOfClass:[NSDictionary class]] ? corridor : @{};
    _inspectionGeometry = [inspectionGeometry isKindOfClass:[NSDictionary class]] ? inspectionGeometry : nil;
  }
  return self;
}

- (BOOL)isObservedDividedCorridor {
  return self.inspectionGeometry != nil &&
         [CorStr(self.slice, @"renderingMode", @"") isEqualToString:kCorRenderingObservedDividedCorridor];
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];

  self.cols = (NSInteger)CorNum(self.corridor, @"cols", 0);
  self.rows = (NSInteger)CorNum(self.corridor, @"rows", 0);
  self.widthM = CorNum(self.corridor, @"widthM", 0);
  self.depthM = CorNum(self.corridor, @"depthM", 0);
  self.minElevM = CorNum(self.corridor, @"minElevM", 0);
  self.upstationDeg = CorNum(self.corridor, @"upstationDeg", 0);
  self.stationEastM = CorNum(self.corridor, @"stationEastM", 0);
  self.stationSouthM = CorNum(self.corridor, @"stationSouthM", 0);
  self.heights = [self.corridor[@"heights"] isKindOfClass:[NSArray class]] ? self.corridor[@"heights"] : @[];
  double maxDim = MAX(self.widthM, self.depthM); if (!(maxDim > 0)) maxDim = 1.0;
  self.supm = (2.0 * kCorridorWorldHalf) / maxDim;

  self.scnView = [[SCNView alloc] initWithFrame:self.view.bounds];
  self.scnView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.scnView.allowsCameraControl = YES;      // orbit / pan / zoom (bounded target)
  self.scnView.backgroundColor = [UIColor colorWithRed:0.06 green:0.09 blue:0.14 alpha:1.0];
  self.scnView.scene = [SCNScene scene];
  self.scnView.isAccessibilityElement = YES;
  self.scnView.accessibilityLabel = @"Immersive offline terrain corridor around the selected road";
  [self.view addSubview:self.scnView];

  BOOL built = (self.cols >= 2 && self.rows >= 2 && (NSInteger)self.heights.count == self.cols * self.rows);
  if (built) {
    @autoreleasepool {                       // free the decoded/composited drape promptly
      [self buildTerrainPatch];
    }
    [self buildRoadOverlay];
    if ([self isObservedDividedCorridor]) [self buildDividedCorridorOverlay];
    [self buildCrossSectionPlane];
  }
  [self addLighting];
  [self setupCamera];
  [self addWarningOverlays:built];
}

#pragma mark - Terrain patch

- (double)elevAtCol:(NSInteger)c row:(NSInteger)r {
  NSInteger cc = MAX(0, MIN(self.cols - 1, c)), rr = MAX(0, MIN(self.rows - 1, r));
  return [self.heights[rr * self.cols + cc] doubleValue];
}

// Bilinear corridor elevation (metres) at patch-local (eastM, southM) from centre.
- (double)elevAtEast:(double)eM south:(double)sM {
  double col = (eM / self.widthM + 0.5) * (self.cols - 1);
  double row = (sM / self.depthM + 0.5) * (self.rows - 1);
  col = MAX(0, MIN(self.cols - 1, col)); row = MAX(0, MIN(self.rows - 1, row));
  NSInteger c0 = (NSInteger)floor(col), r0 = (NSInteger)floor(row);
  NSInteger c1 = MIN(c0 + 1, self.cols - 1), r1 = MIN(r0 + 1, self.rows - 1);
  double fc = col - c0, fr = row - r0;
  double e00 = [self elevAtCol:c0 row:r0], e01 = [self elevAtCol:c1 row:r0];
  double e10 = [self elevAtCol:c0 row:r1], e11 = [self elevAtCol:c1 row:r1];
  double top = e00 + (e01 - e00) * fc, bot = e10 + (e11 - e10) * fc;
  return top + (bot - top) * fr;
}

- (float)sceneYForElev:(double)elevM { return (float)((elevM - self.minElevM) * self.supm * kCorridorVExag); }

// Patch-local (eastM, southM) -> corridor scene position on the surface + lift.
- (SCNVector3)worldForEast:(double)eM south:(double)sM lift:(double)liftM {
  float x = (float)(eM * self.supm);
  float z = (float)(sM * self.supm);
  float y = [self sceneYForElev:[self elevAtEast:eM south:sM]] + (float)(liftM * self.supm);
  return SCNVector3Make(x, y, z);
}

- (void)buildTerrainPatch {
  NSInteger cols = self.cols, rows = self.rows;
  double halfW = self.widthM / 2.0, halfD = self.depthM / 2.0;
  NSUInteger vcount = (NSUInteger)(rows * cols);
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  CGPoint *uvs = malloc(sizeof(CGPoint) * vcount);   // convenience initializer packs float2 correctly
  for (NSInteger r = 0; r < rows; r++) {
    for (NSInteger c = 0; c < cols; c++) {
      NSUInteger i = (NSUInteger)(r * cols + c);
      double eM = -halfW + self.widthM * ((double)c / (cols - 1));
      double sM = -halfD + self.depthM * ((double)r / (rows - 1));
      double e = [self elevAtCol:c row:r];
      verts[i] = SCNVector3Make((float)(eM * self.supm), [self sceneYForElev:e], (float)(sM * self.supm));
      uvs[i] = CGPointMake((double)c / (cols - 1), (double)r / (rows - 1));  // north-up drape (v=0 at north)
    }
  }
  NSUInteger quadCount = (NSUInteger)((rows - 1) * (cols - 1)), icount = quadCount * 6;
  int *idx = malloc(sizeof(int) * icount);
  NSUInteger k = 0;
  for (NSInteger r = 0; r < rows - 1; r++) {
    for (NSInteger c = 0; c < cols - 1; c++) {
      int tl = (int)(r * cols + c), tr = tl + 1, bl = (int)((r + 1) * cols + c), br = bl + 1;
      idx[k++] = tl; idx[k++] = bl; idx[k++] = tr;
      idx[k++] = tr; idx[k++] = bl; idx[k++] = br;
    }
  }
  SCNGeometrySource *vSrc = [SCNGeometrySource geometrySourceWithVertices:verts count:vcount];
  SCNGeometrySource *uvSrc = [SCNGeometrySource geometrySourceWithTextureCoordinates:uvs count:vcount];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * icount]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:icount / 3 bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[vSrc, uvSrc] elements:@[el]];
  SCNMaterial *mat = [SCNMaterial material];
  id img = self.corridor[@"image"];
  if ([img isKindOfClass:[UIImage class]]) {
    mat.diffuse.contents = img;                 // composited packaged aerial drape (offline)
  } else {
    mat.diffuse.contents = [UIColor colorWithRed:0.34 green:0.40 blue:0.30 alpha:1.0];  // shaded relief fallback
  }
  mat.diffuse.wrapS = SCNWrapModeClamp; mat.diffuse.wrapT = SCNWrapModeClamp;   // 1:1 drape, never tile
  mat.doubleSided = YES;
  geo.firstMaterial = mat;
  free(verts); free(uvs); free(idx);
  SCNNode *node = [SCNNode nodeWithGeometry:geo];
  [self.scnView.scene.rootNode addChildNode:node];
  // Focus = the SNAPPED STATION (not the patch centre), so the camera + orbit target sit
  // on the actual selected point even when the patch is clipped at an AOI edge.
  self.focusCenter = [self worldForEast:self.stationEastM south:self.stationSouthM lift:0];
}

#pragma mark - Overlays

- (SCNNode *)lineNodeFromPoints:(NSArray<NSValue *> *)pts color:(UIColor *)color {
  NSUInteger n = pts.count;
  if (n < 2) return nil;
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * n);
  for (NSUInteger i = 0; i < n; i++) verts[i] = [pts[i] SCNVector3Value];
  int *idx = malloc(sizeof(int) * (n - 1) * 2);
  NSUInteger k = 0;
  for (NSUInteger i = 0; i + 1 < n; i++) { idx[k++] = (int)i; idx[k++] = (int)(i + 1); }
  SCNGeometrySource *src = [SCNGeometrySource geometrySourceWithVertices:verts count:n];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * (n - 1) * 2]
                                                        primitiveType:SCNGeometryPrimitiveTypeLine
                                                       primitiveCount:(n - 1) bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[src] elements:@[el]];
  geo.firstMaterial.diffuse.contents = color;
  geo.firstMaterial.lightingModelName = SCNLightingModelConstant;
  free(verts); free(idx);
  return [SCNNode nodeWithGeometry:geo];
}

// The selected road drawn on the corridor surface (bright). Each CLIPPED PART is drawn
// independently — disconnected sections are never joined by a false chord.
- (void)buildRoadOverlay {
  NSArray *parts = [self.corridor[@"roadPartsXsZs"] isKindOfClass:[NSArray class]] ? self.corridor[@"roadPartsXsZs"] : @[];
  UIColor *color = [UIColor colorWithRed:1.0 green:0.82 blue:0.28 alpha:1.0];
  for (NSArray *part in parts) {
    if (![part isKindOfClass:[NSArray class]]) continue;
    NSMutableArray<NSValue *> *pts = [NSMutableArray array];
    for (NSArray *p in part) {
      if (![p isKindOfClass:[NSArray class]] || p.count < 2) continue;
      [pts addObject:[NSValue valueWithSCNVector3:[self worldForEast:[p[0] doubleValue] south:[p[1] doubleValue] lift:0.35]]];
    }
    SCNNode *line = [self lineNodeFromPoints:pts color:color];
    if (line) { line.renderingOrder = 20; [self.scnView.scene.rootNode addChildNode:line]; }
  }
}

// Small upright marker (post + knob) pinning an observed point on the surface.
- (SCNNode *)markerAtEast:(double)eM south:(double)sM color:(UIColor *)color heightM:(double)hM {
  SCNVector3 base = [self worldForEast:eM south:sM lift:0.1];
  float h = (float)(hM * self.supm * kCorridorVExag);
  float r = (float)MAX(0.35 * self.supm, 0.25);
  SCNNode *group = [SCNNode node];
  SCNCylinder *post = [SCNCylinder cylinderWithRadius:r * 0.35 height:h];
  post.firstMaterial.diffuse.contents = color;
  post.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *postNode = [SCNNode nodeWithGeometry:post];
  postNode.position = SCNVector3Make(base.x, base.y + h / 2.0f, base.z);
  [group addChildNode:postNode];
  SCNSphere *knob = [SCNSphere sphereWithRadius:r];
  knob.firstMaterial.diffuse.contents = color;
  knob.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *knobNode = [SCNNode nodeWithGeometry:knob];
  knobNode.position = SCNVector3Make(base.x, base.y + h, base.z);
  [group addChildNode:knobNode];
  group.renderingOrder = 22;
  return group;
}

// Part 12D — the OBSERVED divided corridor in the environment. The selected corridor
// midpoint is already drawn bright yellow by buildRoadOverlay; here we add the two real
// carriageway centerlines that produced it (blue, clearly secondary references), a station
// marker on each, and the measured separation between them.
//
// Everything drawn is measured. The span between the two centerlines is annotated as the
// "Median / separation area" — never as pavement, lanes, or a physical median width, none
// of which the package contains.
- (void)buildDividedCorridorOverlay {
  NSDictionary *dc = self.inspectionGeometry;
  UIColor *memberColor = [UIColor colorWithRed:0.55 green:0.80 blue:1.0 alpha:0.95];   // observed reference
  UIColor *stationColor = [UIColor colorWithRed:1.0 green:0.45 blue:0.30 alpha:1.0];

  for (NSInteger side = 0; side < 2; side++) {
    NSString *partsKey = side == 0 ? @"memberAPartsXsZs" : @"memberBPartsXsZs";
    NSArray *parts = [self.corridor[partsKey] isKindOfClass:[NSArray class]] ? self.corridor[partsKey] : @[];
    for (NSArray *part in parts) {
      if (![part isKindOfClass:[NSArray class]]) continue;
      NSMutableArray<NSValue *> *pts = [NSMutableArray array];
      for (NSArray *p in part) {
        if (![p isKindOfClass:[NSArray class]] || p.count < 2) continue;
        [pts addObject:[NSValue valueWithSCNVector3:[self worldForEast:[p[0] doubleValue]
                                                                 south:[p[1] doubleValue]
                                                                  lift:0.28]]];
      }
      SCNNode *line = [self lineNodeFromPoints:pts color:memberColor];
      if (line) { line.renderingOrder = 19; [self.scnView.scene.rootNode addChildNode:line]; }
    }
    NSArray *st = side == 0 ? self.corridor[@"memberAStationXZ"] : self.corridor[@"memberBStationXZ"];
    if ([st isKindOfClass:[NSArray class]] && st.count >= 2) {
      SCNNode *m = [self markerAtEast:[st[0] doubleValue] south:[st[1] doubleValue] color:stationColor heightM:4.0];
      NSDictionary *mem = side == 0 ? dc[@"memberA"] : dc[@"memberB"];
      m.name = CorStr(mem, @"label", side == 0 ? @"Carriageway A" : @"Carriageway B");
      [self.scnView.scene.rootNode addChildNode:m];
    }
  }

  // The measured separation, drawn between the two observed station points.
  NSArray *a = self.corridor[@"memberAStationXZ"], *b = self.corridor[@"memberBStationXZ"];
  if ([a isKindOfClass:[NSArray class]] && a.count >= 2 && [b isKindOfClass:[NSArray class]] && b.count >= 2) {
    NSArray<NSValue *> *span = @[
      [NSValue valueWithSCNVector3:[self worldForEast:[a[0] doubleValue] south:[a[1] doubleValue] lift:4.2]],
      [NSValue valueWithSCNVector3:[self worldForEast:[b[0] doubleValue] south:[b[1] doubleValue] lift:4.2]],
    ];
    SCNNode *dim = [self lineNodeFromPoints:span color:stationColor];
    if (dim) { dim.renderingOrder = 23; [self.scnView.scene.rootNode addChildNode:dim]; }
  }
}

// The selected cross-section plane, standing in the environment: the slice line on the
// surface + a translucent vertical quad rising from it.
// The section plane is drawn once per CONTIGUOUS VALID RUN of the slice line. A run ends at
// every sample the packaged terrain does not cover, so neither the translucent quad nor the
// ground-contact line ever spans a gap — a continuous surface there would imply measured
// ground across terrain this package does not contain.
- (void)buildCrossSectionPlane {
  NSArray *runs = [self.corridor[@"sliceXsZsRuns"] isKindOfClass:[NSArray class]] ? self.corridor[@"sliceXsZsRuns"] : nil;
  if (runs) {
    for (id r in runs) {
      if ([r isKindOfClass:[NSArray class]] && [(NSArray *)r count] >= 2) [self buildCrossSectionPlaneRun:(NSArray *)r];
    }
    return;
  }
  // Legacy / non-divided packages carry no validity mask: one continuous run.
  NSArray *sl = [self.corridor[@"sliceXsZs"] isKindOfClass:[NSArray class]] ? self.corridor[@"sliceXsZs"] : @[];
  if (sl.count >= 2) [self buildCrossSectionPlaneRun:sl];
}

- (void)buildCrossSectionPlaneRun:(NSArray *)sl {
  if (sl.count < 2) return;
  UIColor *cyan = [UIColor colorWithRed:0.30 green:0.85 blue:0.98 alpha:1.0];
  NSMutableArray<NSValue *> *base = [NSMutableArray array];
  NSUInteger n = sl.count;
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * n * 2);
  for (NSUInteger i = 0; i < n; i++) {
    NSArray *p = sl[i];
    double eM = [p[0] doubleValue], sM = [p[1] doubleValue];
    SCNVector3 g = [self worldForEast:eM south:sM lift:0.2];
    SCNVector3 top = SCNVector3Make(g.x, g.y + (float)(kCorridorPlaneHtM * self.supm * kCorridorVExag), g.z);
    verts[i * 2] = g; verts[i * 2 + 1] = top;
    [base addObject:[NSValue valueWithSCNVector3:g]];
  }
  int *idx = malloc(sizeof(int) * (n - 1) * 6);
  NSUInteger k = 0;
  for (NSUInteger i = 0; i + 1 < n; i++) {
    int b0 = (int)(i * 2), t0 = b0 + 1, b1 = (int)((i + 1) * 2), t1 = b1 + 1;
    idx[k++] = b0; idx[k++] = t0; idx[k++] = b1;
    idx[k++] = b1; idx[k++] = t0; idx[k++] = t1;
  }
  SCNGeometrySource *src = [SCNGeometrySource geometrySourceWithVertices:verts count:n * 2];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * (n - 1) * 6]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:(n - 1) * 2 bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[src] elements:@[el]];
  SCNMaterial *mat = [SCNMaterial material];
  mat.diffuse.contents = cyan; mat.lightingModelName = SCNLightingModelConstant;
  mat.doubleSided = YES; mat.transparency = 0.34;
  geo.firstMaterial = mat;
  free(verts); free(idx);
  SCNNode *plane = [SCNNode nodeWithGeometry:geo];
  plane.renderingOrder = 15;
  [self.scnView.scene.rootNode addChildNode:plane];
  SCNNode *line = [self lineNodeFromPoints:base color:cyan];
  if (line) { line.renderingOrder = 21; [self.scnView.scene.rootNode addChildNode:line]; }
}

- (void)addLighting {
  SCNNode *sun = [SCNNode node];
  sun.light = [SCNLight light]; sun.light.type = SCNLightTypeDirectional;
  sun.light.color = [UIColor colorWithWhite:0.95 alpha:1];
  sun.eulerAngles = SCNVector3Make(-M_PI / 3.2, M_PI / 5, 0);
  [self.scnView.scene.rootNode addChildNode:sun];
  SCNNode *amb = [SCNNode node];
  amb.light = [SCNLight light]; amb.light.type = SCNLightTypeAmbient; amb.light.intensity = 520;
  [self.scnView.scene.rootNode addChildNode:amb];
}

#pragma mark - Camera (perspective, low oblique, looking along the road)

- (void)setupCamera {
  self.cameraNode = [SCNNode node];
  self.cameraNode.camera = [SCNCamera camera];       // PERSPECTIVE (usesOrthographicProjection stays NO)
  self.cameraNode.camera.zFar = kCorridorWorldHalf * 40;
  self.cameraNode.camera.fieldOfView = 55;
  [self.scnView.scene.rootNode addChildNode:self.cameraNode];
  self.scnView.pointOfView = self.cameraNode;
  [self resetCameraFraming];
  self.defaultCamTransform = self.cameraNode.transform;
  self.defaultCamTarget = self.focusCenter;
}

- (void)resetCameraFraming {
  SCNVector3 c = self.focusCenter;
  double rad = self.upstationDeg * M_PI / 180.0;
  double ux = sin(rad), uz = -cos(rad);               // upstation direction in local XZ
  double backM = 60.0, sideM = 14.0, upM = 30.0;
  float back = (float)(backM * self.supm), side = (float)(sideM * self.supm), up = (float)(upM * self.supm);
  SCNVector3 camPos = SCNVector3Make(c.x - (float)ux * back - (float)uz * side, c.y + up, c.z - (float)uz * back + (float)ux * side);
  self.cameraNode.position = camPos;
  // Orient to look at the focus (along the road): eulerAngles from the look direction.
  float dx = c.x - camPos.x, dy = c.y - camPos.y, dz = c.z - camPos.z;
  float len = sqrtf(dx * dx + dy * dy + dz * dz); if (len < 1e-5f) len = 1e-5f;
  float vx = dx / len, vy = dy / len, vz = dz / len;
  self.cameraNode.eulerAngles = SCNVector3Make(asinf(MAX(-1.f, MIN(1.f, vy))), atan2f(-vx, -vz), 0);
  self.scnView.defaultCameraController.target = c;     // bounded orbit pivot
}

#pragma mark - Warnings (Part 10) + honest limitations

- (void)addWarningOverlays:(BOOL)built {
  BOOL orientationAuthoritative = [self.slice[@"orientationAuthoritative"] boolValue];
  BOOL hasImagery = [self.corridor[@"hasImagery"] boolValue];

  // SCENE-SPECIFIC facts only. Roadway-layout provenance and its limitations live in the
  // container's single compact provenance bar — this block must not restate them.
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  [lines addObject:hasImagery
      ? @"Offline aerial-terrain inspection — packaged imagery draped on the local terrain. Not street-level photography."
      : @"Offline terrain inspection (no packaged imagery here) — shaded relief. Not street-level photography."];
  if (!orientationAuthoritative) {
    [lines addObject:@"Orientation follows packaged centerline geometry; upstation is not verified."];
  }
  if ([self.corridor[@"sliceTruncated"] boolValue]) {
    [lines addObject:@"Section truncated by the package boundary — only the in-bounds portion is shown."];
  }
  if (!built) [lines addObject:@"Corridor terrain unavailable for this location."];

  UILabel *banner = [[UILabel alloc] init];
  banner.translatesAutoresizingMaskIntoConstraints = NO;
  banner.numberOfLines = 0;
  banner.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
  banner.textColor = [UIColor colorWithWhite:0.95 alpha:1];
  banner.backgroundColor = [UIColor colorWithWhite:0 alpha:0.55];
  banner.text = [NSString stringWithFormat:@"  %@  ", [lines componentsJoinedByString:@"\n  "]];
  [self.view addSubview:banner];
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  // Top — the container's compact provenance bar owns the bottom edge.
  [NSLayoutConstraint activateConstraints:@[
    [banner.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [banner.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [banner.topAnchor constraintEqualToAnchor:g.topAnchor constant:8],
  ]];

  if ([self isObservedDividedCorridor]) [self addSeparationAnnotation];
}

// The measured separation, stated in words beside the drawn dimension line. This is the
// ONLY quantity the package supports between the carriageways — so it is labelled as the
// separation area with the pavement-edge limitation attached, never as a median width or
// a lane arrangement.
- (void)addSeparationAnnotation {
  NSDictionary *dc = self.inspectionGeometry;
  double sep = CorNum(dc, @"separationM", 0);
  NSString *text = [NSString stringWithFormat:
      @"%@: %.1f m between observed carriageway centerlines\nPavement edges and physical median width are unavailable.",
      kCorMedianSeparationLabel, sep];

  UILabel *l = [[UILabel alloc] init];
  l.translatesAutoresizingMaskIntoConstraints = NO;
  l.numberOfLines = 0;
  l.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
  l.textColor = [UIColor colorWithRed:1.0 green:0.80 blue:0.62 alpha:1.0];
  l.backgroundColor = [UIColor colorWithWhite:0 alpha:0.62];
  l.text = [NSString stringWithFormat:@"  %@  ", text];
  l.isAccessibilityElement = YES;
  l.accessibilityLabel = [NSString stringWithFormat:
      @"%@. %.1f metres between the two observed carriageway centerlines. Pavement edges and physical median width are unavailable.",
      kCorMedianSeparationLabel, sep];
  [self.view addSubview:l];
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [l.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [l.trailingAnchor constraintLessThanOrEqualToAnchor:g.trailingAnchor constant:-8],
    [l.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-64],
  ]];

  NSDictionary *ma = dc[@"memberA"], *mb = dc[@"memberB"];
  self.scnView.accessibilityLabel = [NSString stringWithFormat:
      @"Immersive offline terrain corridor. Observed divided highway corridor: the selected yellow line is the geometry-derived corridor midpoint between %@ and %@, drawn as blue reference centerlines. Measured separation %.1f metres.",
      CorStr(ma, @"label", @"carriageway A"), CorStr(mb, @"label", @"carriageway B"), sep];
}

#pragma mark - Deterministic teardown (Part 12F)

// Drop the decoded drape, geometry and camera as soon as the inspection closes rather than
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
    }];
    for (SCNNode *child in [scene.rootNode.childNodes copy]) [child removeFromParentNode];
  }
  self.scnView.pointOfView = nil;
  self.scnView.scene = nil;
  self.cameraNode = nil;
  self.heights = nil;                     // packaged elevation array (can be megabytes)
  self.corridor = @{};                    // drops the composited corridor UIImage
}

- (void)dealloc {
  [self releaseSceneResources];
}

@end
