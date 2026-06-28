#import "ErisTerrainSceneViewController.h"

#import <SceneKit/SceneKit.h>

#import "ArcGisSketchStore.h"

// Renders the ERIS 'eristerrain' offline terrain bundle as a SceneKit mesh.
//
// Reads the extracted bundle directory (manifest.json + elevation-grid.bin +
// optional hillshade.png + overlays.json), builds a height-field mesh from the
// float32 grid, drapes the hillshade as the diffuse texture, places the incident
// marker + overlays using the manifest's local transform, and provides
// orbit/pan/zoom/tilt (SCNView camera control) plus North + reset-to-incident.
// Everything is local — no network after download.
@interface ErisTerrainSceneViewController ()
@property(nonatomic, strong) SCNView *scnView;
@property(nonatomic, strong) SCNNode *cameraNode;
@property(nonatomic, strong) SCNNode *terrainNode;
@property(nonatomic, assign) float worldSize;       // mesh half-extent in scene units
@property(nonatomic, assign) NSInteger rows;
@property(nonatomic, assign) NSInteger cols;
@property(nonatomic, strong) NSDictionary *manifest;
@property(nonatomic, strong) NSDictionary *terrainMeta;
@property(nonatomic, strong) UILabel *statusLabel;
@end

@implementation ErisTerrainSceneViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"3D Terrain (offline)";
  self.worldSize = 100.0f;

  self.scnView = [[SCNView alloc] initWithFrame:self.view.bounds];
  self.scnView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.scnView.allowsCameraControl = YES;       // orbit / pan / zoom / tilt
  self.scnView.backgroundColor = [UIColor colorWithRed:0.05 green:0.07 blue:0.12 alpha:1.0];
  self.scnView.scene = [SCNScene scene];
  [self.view addSubview:self.scnView];

  // Status pill (version / source / offline).
  self.statusLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.statusLabel.numberOfLines = 2;
  self.statusLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
  self.statusLabel.textColor = [UIColor whiteColor];
  self.statusLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.55];
  self.statusLabel.layer.cornerRadius = 6;
  self.statusLabel.clipsToBounds = YES;
  [self.view addSubview:self.statusLabel];
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.statusLabel.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:10],
    [self.statusLabel.topAnchor constraintEqualToAnchor:g.topAnchor constant:10],
    [self.statusLabel.widthAnchor constraintLessThanOrEqualToAnchor:g.widthAnchor multiplier:0.62],
  ]];

  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Close" style:UIBarButtonItemStyleDone target:self action:@selector(onClose)];
  self.navigationItem.leftBarButtonItems = @[
    [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain target:self action:@selector(resetToIncident)],
    [[UIBarButtonItem alloc] initWithTitle:@"North" style:UIBarButtonItemStylePlain target:self action:@selector(resetNorth)],
  ];

  [self loadBundle];
}

- (void)onClose { [self dismissViewControllerAnimated:YES completion:nil]; }

- (NSDictionary *)params {
  NSString *raw = [ArcGisSketchStore offlineSceneParamsJson];
  if (raw.length == 0) return @{};
  id p = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  return [p isKindOfClass:[NSDictionary class]] ? p : @{};
}

- (void)loadBundle {
  NSDictionary *p = [self params];
  NSString *dir = [p[@"extractedDir"] isKindOfClass:[NSString class]] ? p[@"extractedDir"] : nil;
  dir = [dir stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  if (dir.length == 0) { [self showFatal:@"No extracted terrain bundle. Re-download the 3D area."]; return; }

  NSData *manData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"manifest.json"]];
  id man = manData ? [NSJSONSerialization JSONObjectWithData:manData options:0 error:nil] : nil;
  if (![man isKindOfClass:[NSDictionary class]]) { [self showFatal:@"Terrain manifest missing or invalid."]; return; }
  self.manifest = man;
  self.terrainMeta = [man[@"terrain"] isKindOfClass:[NSDictionary class]] ? man[@"terrain"] : nil;
  if (self.terrainMeta == nil) { [self showFatal:@"Terrain metadata missing."]; return; }

  self.rows = [self.terrainMeta[@"rows"] integerValue];
  self.cols = [self.terrainMeta[@"columns"] integerValue];
  NSString *gridFile = [self.terrainMeta[@"file"] isKindOfClass:[NSString class]] ? self.terrainMeta[@"file"] : @"elevation-grid.bin";
  NSData *gridData = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:gridFile]];
  if (self.rows < 2 || self.cols < 2 || gridData.length != (NSUInteger)(self.rows * self.cols * 4)) {
    [self showFatal:@"Terrain height grid is missing or the wrong size."]; return;
  }

  const float *heights = (const float *)gridData.bytes;  // little-endian float32 (iOS is LE)
  double noData = [self.terrainMeta[@"no_data_value"] doubleValue];
  double minE = [self.terrainMeta[@"min_elevation_m"] doubleValue];
  double maxE = [self.terrainMeta[@"max_elevation_m"] doubleValue];

  SCNNode *terrain = [self buildTerrainNodeWithHeights:heights noData:noData minE:minE maxE:maxE];
  // Drape the local hillshade as the diffuse texture, when present.
  NSString *hsPath = [dir stringByAppendingPathComponent:@"hillshade.png"];
  if ([[NSFileManager defaultManager] fileExistsAtPath:hsPath]) {
    UIImage *hs = [UIImage imageWithContentsOfFile:hsPath];
    if (hs) terrain.geometry.firstMaterial.diffuse.contents = hs;
  }
  self.terrainNode = terrain;
  [self.scnView.scene.rootNode addChildNode:terrain];

  [self addLighting];
  [self addOverlaysFromParams:p];
  [self setupCamera];
  [self updateStatusWithParams:p];
}

// Build a height-field mesh. World X = east (col), Z = south (row), Y = elevation.
- (SCNNode *)buildTerrainNodeWithHeights:(const float *)h noData:(double)noData minE:(double)minE maxE:(double)maxE {
  NSInteger rows = self.rows, cols = self.cols;
  float ws = self.worldSize;                 // half-extent
  float relief = (float)MAX(1.0, maxE - minE);
  float vExag = (ws * 0.35f) / relief;       // vertical exaggeration to read terrain

  NSUInteger vcount = (NSUInteger)(rows * cols);
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  CGPoint *uvs = malloc(sizeof(CGPoint) * vcount);
  for (NSInteger r = 0; r < rows; r++) {
    for (NSInteger c = 0; c < cols; c++) {
      NSUInteger i = (NSUInteger)(r * cols + c);
      double e = (double)h[i];
      if (!isfinite(e) || e == noData) e = minE;        // no-data -> flat at min
      float x = ((float)c / (float)(cols - 1) - 0.5f) * (2.0f * ws);
      float z = ((float)r / (float)(rows - 1) - 0.5f) * (2.0f * ws);
      float y = (float)((e - minE)) * vExag;
      verts[i] = SCNVector3Make(x, y, z);
      uvs[i] = CGPointMake((float)c / (float)(cols - 1), (float)r / (float)(rows - 1));
    }
  }
  // Two triangles per quad.
  NSUInteger quadCount = (NSUInteger)((rows - 1) * (cols - 1));
  NSUInteger icount = quadCount * 6;
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
  SCNGeometrySource *uvSrc = [SCNGeometrySource geometrySourceWithData:[NSData dataWithBytes:uvs length:sizeof(CGPoint) * vcount]
                                                              semantic:SCNGeometrySourceSemanticTexcoord
                                                           vectorCount:vcount
                                                       floatComponents:YES
                                                   componentsPerVector:2
                                                     bytesPerComponent:sizeof(float)
                                                            dataOffset:0
                                                            dataStride:sizeof(CGPoint)];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * icount]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:icount / 3
                                                        bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[vSrc, uvSrc] elements:@[el]];
  SCNMaterial *mat = [SCNMaterial material];
  mat.diffuse.contents = [UIColor colorWithRed:0.45 green:0.42 blue:0.36 alpha:1.0];
  mat.doubleSided = YES;
  geo.firstMaterial = mat;
  free(verts); free(uvs); free(idx);
  return [SCNNode nodeWithGeometry:geo];
}

// Place a node at a grid (col,row) on the terrain surface.
- (SCNVector3)worldForCol:(double)col row:(double)row y:(float)y {
  float ws = self.worldSize;
  float x = ((float)(col / (double)(self.cols - 1)) - 0.5f) * (2.0f * ws);
  float z = ((float)(row / (double)(self.rows - 1)) - 0.5f) * (2.0f * ws);
  return SCNVector3Make(x, y, z);
}

- (SCNVector3)worldForLat:(double)lat lon:(double)lon {
  NSDictionary *lt = self.terrainMeta[@"local_transform"];
  double originLon = [lt[@"origin_lon"] doubleValue], originLat = [lt[@"origin_lat"] doubleValue];
  double lonPerCol = [lt[@"lon_per_col"] doubleValue], latPerRow = [lt[@"lat_per_row"] doubleValue];
  double col = lonPerCol != 0 ? (lon - originLon) / lonPerCol : 0;
  double row = latPerRow != 0 ? (lat - originLat) / latPerRow : 0;
  return [self worldForCol:col row:row y:self.worldSize * 0.55f];
}

- (void)addOverlaysFromParams:(NSDictionary *)p {
  NSDictionary *incident = [p[@"incident"] isKindOfClass:[NSDictionary class]] ? p[@"incident"] : nil;
  if (incident) {
    SCNVector3 pos = [self worldForLat:[incident[@"lat"] doubleValue] lon:[incident[@"lon"] doubleValue]];
    SCNNode *pin = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:self.worldSize * 0.025f]];
    pin.geometry.firstMaterial.diffuse.contents = [UIColor colorWithRed:0.14 green:0.39 blue:0.92 alpha:1.0];
    pin.position = pos;
    [self.scnView.scene.rootNode addChildNode:pin];
  }
  // Road bearing line — only when a real bearing exists.
  id bearing = p[@"roadBearingDeg"];
  if (incident && [bearing isKindOfClass:[NSNumber class]]) {
    double rad = [bearing doubleValue] * M_PI / 180.0;
    SCNVector3 c = [self worldForLat:[incident[@"lat"] doubleValue] lon:[incident[@"lon"] doubleValue]];
    float len = self.worldSize * 0.4f;
    SCNVector3 a = SCNVector3Make(c.x - sinf(rad) * len, c.y, c.z + cosf(rad) * len);
    SCNVector3 b = SCNVector3Make(c.x + sinf(rad) * len, c.y, c.z - cosf(rad) * len);
    [self.scnView.scene.rootNode addChildNode:[self lineFrom:a to:b color:[UIColor colorWithRed:0.98 green:0.80 blue:0.13 alpha:1.0]]];
  }
}

- (SCNNode *)lineFrom:(SCNVector3)a to:(SCNVector3)b color:(UIColor *)color {
  SCNVector3 verts[2] = {a, b};
  int idx[2] = {0, 1};
  SCNGeometrySource *src = [SCNGeometrySource geometrySourceWithVertices:verts count:2];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(idx)]
                                                        primitiveType:SCNGeometryPrimitiveTypeLine
                                                       primitiveCount:1 bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[src] elements:@[el]];
  geo.firstMaterial.diffuse.contents = color;
  return [SCNNode nodeWithGeometry:geo];
}

- (void)addLighting {
  SCNNode *sun = [SCNNode node];
  sun.light = [SCNLight light];
  sun.light.type = SCNLightTypeDirectional;
  sun.eulerAngles = SCNVector3Make(-M_PI / 3, M_PI / 4, 0);
  [self.scnView.scene.rootNode addChildNode:sun];
  SCNNode *amb = [SCNNode node];
  amb.light = [SCNLight light];
  amb.light.type = SCNLightTypeAmbient;
  amb.light.intensity = 400;
  [self.scnView.scene.rootNode addChildNode:amb];
}

- (void)setupCamera {
  self.cameraNode = [SCNNode node];
  self.cameraNode.camera = [SCNCamera camera];
  self.cameraNode.camera.zFar = self.worldSize * 20;
  [self.scnView.scene.rootNode addChildNode:self.cameraNode];
  self.scnView.pointOfView = self.cameraNode;
  [self resetToIncident];
}

// Oblique reset framed on the terrain centre (north up, tilted ~60 deg).
- (void)resetToIncident {
  float ws = self.worldSize;
  self.cameraNode.position = SCNVector3Make(0, ws * 1.4f, ws * 1.9f);
  self.cameraNode.eulerAngles = SCNVector3Make(-M_PI / 3.2, 0, 0);
}

- (void)resetNorth {
  // Keep position/pitch, clear any orbit yaw the user applied.
  SCNVector3 e = self.cameraNode.eulerAngles;
  self.cameraNode.eulerAngles = SCNVector3Make(e.x, 0, 0);
}

- (void)updateStatusWithParams:(NSDictionary *)p {
  NSString *version = [p[@"packageVersion"] isKindOfClass:[NSString class]] ? p[@"packageVersion"] : @"—";
  NSDictionary *elev = [self.manifest[@"elevation"] isKindOfClass:[NSDictionary class]] ? self.manifest[@"elevation"] : @{};
  NSString *src = [elev[@"dataset"] isKindOfClass:[NSString class]] ? elev[@"dataset"] : @"USGS 3DEP";
  self.statusLabel.text = [NSString stringWithFormat:@"  Offline terrain · v%@\n  %@  ", version, src];
}

- (void)showFatal:(NSString *)message {
  UILabel *l = [[UILabel alloc] initWithFrame:CGRectZero];
  l.translatesAutoresizingMaskIntoConstraints = NO;
  l.numberOfLines = 0; l.textAlignment = NSTextAlignmentCenter; l.textColor = [UIColor whiteColor];
  l.font = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
  l.text = message;
  [self.view addSubview:l];
  [NSLayoutConstraint activateConstraints:@[
    [l.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [l.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    [l.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:32],
    [l.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-32],
  ]];
}

@end
