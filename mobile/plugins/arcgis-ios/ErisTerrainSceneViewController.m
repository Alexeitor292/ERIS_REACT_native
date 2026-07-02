#import "ErisTerrainSceneViewController.h"

#import <SceneKit/SceneKit.h>

#import "ArcGisSketchStore.h"

// Renders the ERIS 'eristerrain' offline terrain bundle as a SceneKit mesh.
//
// Reads the extracted bundle directory (manifest.json + elevation-grid.bin +
// optional hillshade.png + overlays.json), builds a height-field mesh from the
// float32 grid, drapes the hillshade as the diffuse texture, then places the live
// ERIS overlays draped on the mesh surface using the manifest's local transform:
//   * incident marker;
//   * uploaded incident geometry (GeoJSON geometry/Feature/FeatureCollection/
//     GeometryCollection and Esri x-y/points/paths/rings; Point, MultiPoint,
//     LineString, Polygon and their multi-equivalents), clipped to the package
//     bounds (out-of-bounds vertices are skipped — no invented coordinates);
//   * the terrain sample extent as a bounding rectangle (only when provided);
//   * the road-bearing line (only when a real bearing exists).
//
// The coordinate math (lon/lat -> grid col/row -> mesh XZ, Web Mercator coercion,
// bounds clipping) mirrors the unit-tested reference in src/arcgis/terrainOverlays.ts
// — keep the two in sync. Camera controls: orbit/pan/zoom/tilt (SCNView camera
// control) plus North and reset-to-incident. Everything is local — no network.
@interface ErisTerrainSceneViewController ()
@property(nonatomic, strong) SCNView *scnView;
@property(nonatomic, strong) SCNNode *cameraNode;
@property(nonatomic, strong) SCNNode *terrainNode;
@property(nonatomic, assign) float worldSize;       // mesh half-extent in scene units
@property(nonatomic, assign) NSInteger rows;
@property(nonatomic, assign) NSInteger cols;
@property(nonatomic, strong) NSData *gridData;       // retained float32 height grid (LE)
@property(nonatomic, assign) double minE;
@property(nonatomic, assign) double maxE;
@property(nonatomic, assign) double noData;
@property(nonatomic, assign) float vExag;            // vertical exaggeration (y = (e-minE)*vExag)
@property(nonatomic, assign) SCNVector3 focusTarget; // incident (or terrain centre) world pos
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

  self.gridData = gridData;                                    // retained for surface sampling
  self.noData = [self.terrainMeta[@"no_data_value"] doubleValue];
  self.minE = [self.terrainMeta[@"min_elevation_m"] doubleValue];
  self.maxE = [self.terrainMeta[@"max_elevation_m"] doubleValue];
  float relief = (float)MAX(1.0, self.maxE - self.minE);
  self.vExag = (self.worldSize * 0.35f) / relief;             // vertical exaggeration to read terrain

  SCNNode *terrain = [self buildTerrainNode];
  // Drape the local hillshade as the diffuse texture, when present.
  NSString *hsPath = [dir stringByAppendingPathComponent:@"hillshade.png"];
  if ([[NSFileManager defaultManager] fileExistsAtPath:hsPath]) {
    UIImage *hs = [UIImage imageWithContentsOfFile:hsPath];
    if (hs) terrain.geometry.firstMaterial.diffuse.contents = hs;
  }
  self.terrainNode = terrain;
  [self.scnView.scene.rootNode addChildNode:terrain];

  [self addLighting];
  [self computeFocusTargetFromParams:p];
  [self addOverlaysFromParams:p];
  [self setupCamera];
  [self updateStatusWithParams:p];
}

// Build a height-field mesh. World X = east (col), Z = south (row), Y = elevation.
- (SCNNode *)buildTerrainNode {
  NSInteger rows = self.rows, cols = self.cols;
  const float *h = (const float *)self.gridData.bytes;  // little-endian float32 (iOS is LE)
  float ws = self.worldSize;                            // half-extent

  NSUInteger vcount = (NSUInteger)(rows * cols);
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  CGPoint *uvs = malloc(sizeof(CGPoint) * vcount);
  for (NSInteger r = 0; r < rows; r++) {
    for (NSInteger c = 0; c < cols; c++) {
      NSUInteger i = (NSUInteger)(r * cols + c);
      double e = (double)h[i];
      if (!isfinite(e) || e == self.noData) e = self.minE;        // no-data -> flat at min
      float x = ((float)c / (float)(cols - 1) - 0.5f) * (2.0f * ws);
      float z = ((float)r / (float)(rows - 1) - 0.5f) * (2.0f * ws);
      float y = (float)((e - self.minE)) * self.vExag;
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

#pragma mark - Coordinate mapping (mirrors src/arcgis/terrainOverlays.ts)

// lon/lat -> fractional grid (col,row) via the manifest local transform.
// Returns NO if the transform is degenerate.
- (BOOL)colRowForLat:(double)lat lon:(double)lon outCol:(double *)oc outRow:(double *)orow {
  NSDictionary *lt = self.terrainMeta[@"local_transform"];
  double originLon = [lt[@"origin_lon"] doubleValue], originLat = [lt[@"origin_lat"] doubleValue];
  double lonPerCol = [lt[@"lon_per_col"] doubleValue], latPerRow = [lt[@"lat_per_row"] doubleValue];
  if (lonPerCol == 0 || latPerRow == 0) return NO;
  *oc = (lon - originLon) / lonPerCol;
  *orow = (lat - originLat) / latPerRow;
  return YES;
}

// Whether a grid (col,row) is within the packaged grid (inclusive, small epsilon).
- (BOOL)inBoundsCol:(double)col row:(double)row {
  double eps = 1e-6;
  return col >= -eps && col <= (double)(self.cols - 1) + eps && row >= -eps && row <= (double)(self.rows - 1) + eps;
}

// Sampled mesh-surface elevation (scene units) at a fractional grid (col,row),
// bilinearly interpolated, with no-data treated as the min elevation. Matches the
// terrain mesh vertex Y exactly at integer (col,row).
- (double)elevAtRow:(NSInteger)r col:(NSInteger)c {
  const float *h = (const float *)self.gridData.bytes;
  double e = (double)h[r * self.cols + c];
  if (!isfinite(e) || e == self.noData) return self.minE;
  return e;
}

- (float)surfaceYAtCol:(double)col row:(double)row {
  if (self.gridData == nil) return 0;
  double cc = MIN(MAX(col, 0.0), (double)(self.cols - 1));
  double rr = MIN(MAX(row, 0.0), (double)(self.rows - 1));
  NSInteger c0 = (NSInteger)floor(cc), r0 = (NSInteger)floor(rr);
  NSInteger c1 = MIN(c0 + 1, self.cols - 1), r1 = MIN(r0 + 1, self.rows - 1);
  double fc = cc - c0, fr = rr - r0;
  double e00 = [self elevAtRow:r0 col:c0], e01 = [self elevAtRow:r0 col:c1];
  double e10 = [self elevAtRow:r1 col:c0], e11 = [self elevAtRow:r1 col:c1];
  double top = e00 + (e01 - e00) * fc, bot = e10 + (e11 - e10) * fc;
  double e = top + (bot - top) * fr;
  return (float)((e - self.minE) * self.vExag);
}

// grid (col,row) -> world XZ on the mesh; Y = sampled surface + lift.
- (SCNVector3)surfaceWorldForCol:(double)col row:(double)row lift:(float)lift {
  float ws = self.worldSize;
  float x = ((float)(col / (double)(self.cols - 1)) - 0.5f) * (2.0f * ws);
  float z = ((float)(row / (double)(self.rows - 1)) - 0.5f) * (2.0f * ws);
  float y = [self surfaceYAtCol:col row:row] + lift;
  return SCNVector3Make(x, y, z);
}

// lon/lat -> world position draped on the surface; returns NO if degenerate.
- (BOOL)surfaceWorldForLat:(double)lat lon:(double)lon lift:(float)lift out:(SCNVector3 *)out {
  double col, row;
  if (![self colRowForLat:lat lon:lon outCol:&col outRow:&row]) return NO;
  *out = [self surfaceWorldForCol:col row:row lift:lift];
  return YES;
}

#pragma mark - Overlays

- (void)computeFocusTargetFromParams:(NSDictionary *)p {
  // Default focus = terrain centre.
  double midCol = (double)(self.cols - 1) / 2.0, midRow = (double)(self.rows - 1) / 2.0;
  self.focusTarget = [self surfaceWorldForCol:midCol row:midRow lift:0];
  NSDictionary *incident = [p[@"incident"] isKindOfClass:[NSDictionary class]] ? p[@"incident"] : nil;
  if (incident) {
    double lat = [incident[@"lat"] doubleValue], lon = [incident[@"lon"] doubleValue];
    double col, row;
    if ([self colRowForLat:lat lon:lon outCol:&col outRow:&row] && [self inBoundsCol:col row:row]) {
      self.focusTarget = [self surfaceWorldForCol:col row:row lift:0];   // incident inside the package
    }
  }
}

- (void)addOverlaysFromParams:(NSDictionary *)p {
  // Incident marker (only when inside the packaged bounds).
  NSDictionary *incident = [p[@"incident"] isKindOfClass:[NSDictionary class]] ? p[@"incident"] : nil;
  BOOL incidentInBounds = NO;
  double incLat = 0, incLon = 0;
  if (incident) {
    incLat = [incident[@"lat"] doubleValue];
    incLon = [incident[@"lon"] doubleValue];
    double col, row;
    if ([self colRowForLat:incLat lon:incLon outCol:&col outRow:&row] && [self inBoundsCol:col row:row]) {
      incidentInBounds = YES;
      SCNVector3 pos = [self surfaceWorldForCol:col row:row lift:self.worldSize * 0.03f];
      SCNNode *pin = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:self.worldSize * 0.025f]];
      pin.geometry.firstMaterial.diffuse.contents = [UIColor colorWithRed:0.14 green:0.39 blue:0.92 alpha:1.0];
      pin.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
      pin.position = pos;
      [self.scnView.scene.rootNode addChildNode:pin];
    }
  }

  // Sample extent rectangle — only when provided.
  NSDictionary *ext = [p[@"sampleExtent"] isKindOfClass:[NSDictionary class]] ? p[@"sampleExtent"] : nil;
  if (ext) [self addSampleExtent:ext];

  // Uploaded incident geometry (GeoJSON / Esri JSON), draped + clipped to bounds.
  id geom = p[@"geometry"];
  if (geom && geom != [NSNull null]) [self addUploadedGeometry:geom];

  // Road-bearing line — only when a real bearing exists and the incident is in bounds.
  id bearing = p[@"roadBearingDeg"];
  if (incidentInBounds && [bearing isKindOfClass:[NSNumber class]]) {
    double rad = [bearing doubleValue] * M_PI / 180.0;
    SCNVector3 c;
    if ([self surfaceWorldForLat:incLat lon:incLon lift:self.worldSize * 0.02f out:&c]) {
      float len = self.worldSize * 0.4f;
      SCNVector3 a = SCNVector3Make(c.x - sinf(rad) * len, c.y, c.z + cosf(rad) * len);
      SCNVector3 b = SCNVector3Make(c.x + sinf(rad) * len, c.y, c.z - cosf(rad) * len);
      SCNNode *line = [self polylineFromPoints:@[[NSValue valueWithSCNVector3:a], [NSValue valueWithSCNVector3:b]]
                                         color:[UIColor colorWithRed:0.98 green:0.80 blue:0.13 alpha:1.0]
                                        closed:NO];
      if (line) [self.scnView.scene.rootNode addChildNode:line];
    }
  }
}

- (void)addSampleExtent:(NSDictionary *)ext {
  double minLat = [ext[@"minLat"] doubleValue], minLon = [ext[@"minLon"] doubleValue];
  double maxLat = [ext[@"maxLat"] doubleValue], maxLon = [ext[@"maxLon"] doubleValue];
  // Closed rectangle ring (matches sampleExtentRing in terrainOverlays.ts).
  double ring[5][2] = {
    {minLon, minLat}, {maxLon, minLat}, {maxLon, maxLat}, {minLon, maxLat}, {minLon, minLat}};
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];
  for (int i = 0; i < 5; i++) {
    double col, row;
    if (![self colRowForLat:ring[i][1] lon:ring[i][0] outCol:&col outRow:&row]) continue;
    if (![self inBoundsCol:col row:row]) continue;  // clip to packaged bounds
    [pts addObject:[NSValue valueWithSCNVector3:[self surfaceWorldForCol:col row:row lift:self.worldSize * 0.015f]]];
  }
  SCNNode *rect = [self polylineFromPoints:pts color:[UIColor colorWithRed:0.42 green:0.84 blue:0.96 alpha:1.0] closed:NO];
  if (rect) [self.scnView.scene.rootNode addChildNode:rect];
}

// Render normalized overlay primitives draped on the surface. Out-of-bounds
// vertices are skipped (no invented coordinates).
- (void)addUploadedGeometry:(id)geom {
  NSArray<NSDictionary *> *prims = [self primitivesFromGeometry:geom];
  UIColor *lineColor = [UIColor colorWithRed:0.30 green:0.93 blue:0.55 alpha:1.0];
  for (NSDictionary *prim in prims) {
    NSString *kind = prim[@"kind"];
    NSArray *coords = prim[@"coords"];
    NSMutableArray<NSValue *> *pts = [NSMutableArray array];
    for (NSArray *c in coords) {
      double lon = [c[0] doubleValue], lat = [c[1] doubleValue];
      double col, row;
      if (![self colRowForLat:lat lon:lon outCol:&col outRow:&row]) continue;
      if (![self inBoundsCol:col row:row]) continue;   // skip out-of-bounds vertex
      [pts addObject:[NSValue valueWithSCNVector3:[self surfaceWorldForCol:col row:row lift:self.worldSize * 0.02f]]];
    }
    if ([kind isEqualToString:@"point"]) {
      for (NSValue *v in pts) {
        SCNNode *dot = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:self.worldSize * 0.018f]];
        dot.geometry.firstMaterial.diffuse.contents = lineColor;
        dot.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
        dot.position = [v SCNVector3Value];
        [self.scnView.scene.rootNode addChildNode:dot];
      }
    } else if ([kind isEqualToString:@"line"]) {
      SCNNode *ln = [self polylineFromPoints:pts color:lineColor closed:NO];
      if (ln) [self.scnView.scene.rootNode addChildNode:ln];
    } else if ([kind isEqualToString:@"polygon"]) {
      SCNNode *poly = [self polylineFromPoints:pts color:lineColor closed:YES];
      if (poly) [self.scnView.scene.rootNode addChildNode:poly];
    }
  }
}

#pragma mark - Geometry normalization (mirrors normalizeOverlayGeometry in terrainOverlays.ts)

static NSArray *erisAsArray(id v) {
  return [v isKindOfClass:[NSArray class]] ? (NSArray *)v : @[];
}

// Coerce a raw [x,y] coordinate to @[@(lon),@(lat)], converting Web Mercator when
// the values are clearly projected (|x|>180 or |y|>90). Returns nil if not numeric.
- (NSArray *)lonLat:(id)c {
  NSArray *a = [c isKindOfClass:[NSArray class]] ? c : nil;
  if (a.count < 2 || ![a[0] isKindOfClass:[NSNumber class]] || ![a[1] isKindOfClass:[NSNumber class]]) return nil;
  double x = [a[0] doubleValue], y = [a[1] doubleValue];
  if (!isfinite(x) || !isfinite(y)) return nil;
  if (fabs(x) > 180.0 || fabs(y) > 90.0) {
    double lon = (x / 20037508.34) * 180.0;
    double lat = (y / 20037508.34) * 180.0;
    lat = (180.0 / M_PI) * (2.0 * atan(exp(lat * M_PI / 180.0)) - M_PI / 2.0);
    return @[@(lon), @(lat)];
  }
  return @[@(x), @(y)];
}

- (NSArray *)lonLatList:(id)arr {
  NSMutableArray *out = [NSMutableArray array];
  for (id c in erisAsArray(arr)) {
    NSArray *ll = [self lonLat:c];
    if (ll) [out addObject:ll];
  }
  return out;
}

- (NSArray<NSDictionary *> *)primitivesFromGeometry:(id)g {
  NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
  if (![g isKindOfClass:[NSDictionary class]]) return out;
  NSDictionary *d = g;
  NSString *type = [d[@"type"] isKindOfClass:[NSString class]] ? d[@"type"] : nil;

  if ([type isEqualToString:@"FeatureCollection"]) {
    for (id f in erisAsArray(d[@"features"])) [out addObjectsFromArray:[self primitivesFromGeometry:f]];
    return out;
  }
  if ([type isEqualToString:@"Feature"]) return [self primitivesFromGeometry:d[@"geometry"]];
  if ([type isEqualToString:@"GeometryCollection"]) {
    for (id gg in erisAsArray(d[@"geometries"])) [out addObjectsFromArray:[self primitivesFromGeometry:gg]];
    return out;
  }
  if (type) {
    id coords = d[@"coordinates"];
    if ([type isEqualToString:@"Point"]) {
      NSArray *pt = [self lonLat:coords];
      if (pt) [out addObject:@{@"kind": @"point", @"coords": @[pt]}];
    } else if ([type isEqualToString:@"MultiPoint"]) {
      for (id c in erisAsArray(coords)) {
        NSArray *pt = [self lonLat:c];
        if (pt) [out addObject:@{@"kind": @"point", @"coords": @[pt]}];
      }
    } else if ([type isEqualToString:@"LineString"]) {
      NSArray *l = [self lonLatList:coords];
      if (l.count) [out addObject:@{@"kind": @"line", @"coords": l}];
    } else if ([type isEqualToString:@"MultiLineString"]) {
      for (id ln in erisAsArray(coords)) {
        NSArray *l = [self lonLatList:ln];
        if (l.count) [out addObject:@{@"kind": @"line", @"coords": l}];
      }
    } else if ([type isEqualToString:@"Polygon"]) {
      for (id ring in erisAsArray(coords)) {
        NSArray *r = [self lonLatList:ring];
        if (r.count) [out addObject:@{@"kind": @"polygon", @"coords": r}];
      }
    } else if ([type isEqualToString:@"MultiPolygon"]) {
      for (id poly in erisAsArray(coords))
        for (id ring in erisAsArray(poly)) {
          NSArray *r = [self lonLatList:ring];
          if (r.count) [out addObject:@{@"kind": @"polygon", @"coords": r}];
        }
    }
    return out;
  }

  // Esri JSON geometry.
  if ([d[@"x"] isKindOfClass:[NSNumber class]] && [d[@"y"] isKindOfClass:[NSNumber class]]) {
    NSArray *pt = [self lonLat:@[d[@"x"], d[@"y"]]];
    if (pt) [out addObject:@{@"kind": @"point", @"coords": @[pt]}];
  } else if ([d[@"points"] isKindOfClass:[NSArray class]]) {
    for (id c in d[@"points"]) {
      NSArray *pt = [self lonLat:c];
      if (pt) [out addObject:@{@"kind": @"point", @"coords": @[pt]}];
    }
  } else if ([d[@"paths"] isKindOfClass:[NSArray class]]) {
    for (id path in d[@"paths"]) {
      NSArray *l = [self lonLatList:path];
      if (l.count) [out addObject:@{@"kind": @"line", @"coords": l}];
    }
  } else if ([d[@"rings"] isKindOfClass:[NSArray class]]) {
    for (id ring in d[@"rings"]) {
      NSArray *r = [self lonLatList:ring];
      if (r.count) [out addObject:@{@"kind": @"polygon", @"coords": r}];
    }
  }
  return out;
}

- (SCNNode *)polylineFromPoints:(NSArray<NSValue *> *)pts color:(UIColor *)color closed:(BOOL)closed {
  NSUInteger n = pts.count;
  if (n < 2) return nil;
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * n);
  for (NSUInteger i = 0; i < n; i++) verts[i] = [pts[i] SCNVector3Value];
  NSUInteger segs = (closed && n >= 3) ? n : n - 1;
  int *idx = malloc(sizeof(int) * segs * 2);
  NSUInteger k = 0;
  for (NSUInteger i = 0; i < segs; i++) {
    idx[k++] = (int)i;
    idx[k++] = (int)((i + 1) % n);
  }
  SCNGeometrySource *src = [SCNGeometrySource geometrySourceWithVertices:verts count:n];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * segs * 2]
                                                        primitiveType:SCNGeometryPrimitiveTypeLine
                                                       primitiveCount:segs
                                                        bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[src] elements:@[el]];
  geo.firstMaterial.diffuse.contents = color;
  geo.firstMaterial.lightingModelName = SCNLightingModelConstant;  // overlays read at any light
  free(verts); free(idx);
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

#pragma mark - Camera

- (void)setupCamera {
  self.cameraNode = [SCNNode node];
  self.cameraNode.camera = [SCNCamera camera];
  self.cameraNode.camera.zFar = self.worldSize * 20;
  [self.scnView.scene.rootNode addChildNode:self.cameraNode];
  self.scnView.pointOfView = self.cameraNode;
  [self resetToIncident];
}

// Frame the incident (or terrain centre when the incident is unavailable/out of
// bounds): place the camera south of and above the focus target, oriented to look
// at it, and pin the built-in orbit controller's target to the focus so orbit /
// pan / zoom revolve around the incident (a stable SceneKit look-at target rather
// than only hand-set Euler angles).
- (void)resetToIncident {
  SCNVector3 t = self.focusTarget;
  float ws = self.worldSize;
  float height = ws * 1.2f;     // metres above the target
  float radius = ws * 1.9f;     // ground distance south of the target
  self.cameraNode.position = SCNVector3Make(t.x, t.y + height, t.z + radius);
  // Look-at the focus: pure pitch (north-up, no yaw) since the offset is in the Z-Y plane.
  self.cameraNode.eulerAngles = SCNVector3Make(-atan2f(height, radius), 0, 0);
  // Stable orbit/look pivot for the built-in camera controller.
  self.scnView.defaultCameraController.target = t;
}

// Restore north-up yaw while PRESERVING the current incident framing (target,
// height and ground radius / zoom): re-place the camera due-south of the focus at
// the same elevation and horizontal radius, with yaw = 0.
- (void)resetNorth {
  SCNVector3 t = self.focusTarget;
  SCNVector3 cam = self.cameraNode.position;
  float dx = cam.x - t.x, dy = cam.y - t.y, dz = cam.z - t.z;
  float horiz = sqrtf(dx * dx + dz * dz);
  if (horiz < 1e-3f) horiz = self.worldSize * 1.9f;   // top-down fallback
  self.cameraNode.position = SCNVector3Make(t.x, t.y + dy, t.z + horiz);
  self.cameraNode.eulerAngles = SCNVector3Make(-atan2f(dy, horiz), 0, 0);
  self.scnView.defaultCameraController.target = t;
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
