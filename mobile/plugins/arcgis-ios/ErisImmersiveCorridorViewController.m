#import "ErisImmersiveCorridorViewController.h"
#import <SceneKit/SceneKit.h>

// Immersive corridor scale + display. The corridor is a small north-up terrain patch;
// the CAMERA is oriented along the roadway to give the immersive along-road view (the
// mesh itself is not rotated, so the composited north-up aerial drape stays aligned).
static const double kCorridorWorldHalf = 100.0;   // scene half-extent for the larger patch dimension
static const double kCorridorVExag     = 1.5;     // modest display exaggeration (inspection readability)
static const double kCorridorPlaneHtM  = 9.0;     // cross-section plane height above the road

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
@property(nonatomic, strong) SCNView *scnView;
@property(nonatomic, strong) SCNNode *cameraNode;
@property(nonatomic, assign) NSInteger cols, rows;
@property(nonatomic, assign) double widthM, depthM, minElevM, supm;
@property(nonatomic, strong) NSArray<NSNumber *> *heights;
@property(nonatomic, assign) SCNVector3 focusCenter;      // patch centre on the surface (scene units)
@property(nonatomic, assign) double upstationDeg;
@property(nonatomic, assign) SCNMatrix4 defaultCamTransform;
@property(nonatomic, assign) SCNVector3 defaultCamTarget;
@end

@implementation ErisImmersiveCorridorViewController

- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor {
  if ((self = [super init])) {
    _slice = [slice isKindOfClass:[NSDictionary class]] ? slice : @{};
    _corridor = [corridor isKindOfClass:[NSDictionary class]] ? corridor : @{};
  }
  return self;
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
    [self buildTerrainPatch];
    [self buildRoadOverlay];
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
  self.focusCenter = [self worldForEast:0 south:0 lift:0];
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

// The selected road drawn on the corridor surface (bright), so the relationship between
// the road, the terrain and the incident context is visible.
- (void)buildRoadOverlay {
  NSArray *road = [self.corridor[@"roadXsZs"] isKindOfClass:[NSArray class]] ? self.corridor[@"roadXsZs"] : @[];
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];
  for (NSArray *p in road) {
    if (![p isKindOfClass:[NSArray class]] || p.count < 2) continue;
    [pts addObject:[NSValue valueWithSCNVector3:[self worldForEast:[p[0] doubleValue] south:[p[1] doubleValue] lift:0.35]]];
  }
  SCNNode *line = [self lineNodeFromPoints:pts color:[UIColor colorWithRed:1.0 green:0.82 blue:0.28 alpha:1.0]];
  if (line) { line.renderingOrder = 20; [self.scnView.scene.rootNode addChildNode:line]; }
}

// The selected cross-section plane, standing in the environment: the slice line on the
// surface + a translucent vertical quad rising from it.
- (void)buildCrossSectionPlane {
  NSArray *sl = [self.corridor[@"sliceXsZs"] isKindOfClass:[NSArray class]] ? self.corridor[@"sliceXsZs"] : @[];
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
  NSDictionary *prov = [self.slice[@"provenance"] isKindOfClass:[NSDictionary class]] ? self.slice[@"provenance"] : @{};
  NSString *layoutSrc = CorStr(prov, @"roadLayoutSource", @"DEFAULT");
  BOOL orientationAuthoritative = [self.slice[@"orientationAuthoritative"] boolValue];
  BOOL hasImagery = [self.corridor[@"hasImagery"] boolValue];

  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  [lines addObject:hasImagery
      ? @"Offline aerial-terrain inspection — packaged imagery draped on the local terrain. Not street-level photography."
      : @"Offline terrain inspection (no packaged imagery here) — shaded relief. Not street-level photography."];
  [lines addObject:orientationAuthoritative
      ? @"Orientation from the packaged upstation bearing."
      : @"Orientation follows packaged centerline geometry; upstation is not verified."];
  if ([layoutSrc isEqualToString:@"DEFAULT"]) {
    [lines addObject:@"Default roadway assumptions — verify lane, shoulder, and median dimensions."];
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
  [NSLayoutConstraint activateConstraints:@[
    [banner.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [banner.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [banner.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-8],
  ]];
}

@end
