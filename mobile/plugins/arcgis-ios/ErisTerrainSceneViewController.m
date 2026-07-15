#import "ErisTerrainSceneViewController.h"

#import <SceneKit/SceneKit.h>

#import "ArcGisSketchStore.h"
// The tap path now presents the Immersive/Technical inspection container (Part 9), never
// the road-slice cutaway directly — no immediate uncoordinated modal in onSceneTap.
#import "ErisInspectionViewController.h"

// Packed two-float texture coordinate for the SceneKit texcoord source. MUST NOT
// use CGPoint: CGPoint holds two CGFloat (double, 16 bytes) on 64-bit iOS, but the
// texcoord source declares floatComponents:YES / bytesPerComponent:sizeof(float),
// so SceneKit would read partial double bytes as floats -> corrupt UVs (diagonal
// stripe artifact). This struct is exactly two float32 (8 bytes), matching the
// declared component layout and stride.
typedef struct {
  float u;
  float v;
} ErisTerrainTexCoord;

#pragma mark - Layers sheet

// Polished native sheet for the terrain viewer's layer control. Sections:
//   Base surface (Terrain Relief / Satellite / Hybrid — last two disabled when
//   imagery was not packaged), Operational overlays (Roads, Incident/Geometry,
//   Package Boundary, Overview), Appearance (terrain relief intensity). Reports
//   changes via an onChange block. Never triggers a network request.
// Vertical-exaggeration slider policy (mirrors terrainScale.ts).
static const CGFloat kErisVertExagMin = 0.5f;
static const CGFloat kErisVertExagMax = 3.0f;
static const CGFloat kErisVertExagStep = 0.1f;

static CGFloat ErisSnapExag(CGFloat v) {
  if (!isfinite(v)) return 1.0f;
  CGFloat c = MAX(kErisVertExagMin, MIN(kErisVertExagMax, v));
  return roundf(c / kErisVertExagStep) * kErisVertExagStep;
}

// Human label for an exaggeration value (matches exaggerationLabel in terrainScale.ts).
static NSString *ErisExagLabel(CGFloat value) {
  CGFloat x = ErisSnapExag(value);
  NSString *tag = x <= 0.6f ? @"Flattened"
                : x < 1.0f  ? @"Reduced relief"
                : x == 1.0f ? @"True scale"
                : x <= 1.5f ? @"Field relief"
                : x <= 2.0f ? @"Enhanced relief"
                            : @"High relief";
  return [NSString stringWithFormat:@"%.1f× %@", x, tag];  // e.g. "1.0x True scale"
}

@interface ErisLayersSheetVC : UITableViewController
@property(nonatomic, assign) NSInteger baseSurface;   // 0 terrain, 1 satellite, 2 hybrid
@property(nonatomic, assign) BOOL imageryAvailable;
@property(nonatomic, assign) BOOL roadsAvailable, overviewAvailable;
@property(nonatomic, assign) BOOL showRoads, showOverlays, showBoundary, showOverview;
@property(nonatomic, assign) CGFloat reliefIntensity;         // hillshade blend (NOT vertical exaggeration)
@property(nonatomic, assign) CGFloat verticalExaggeration;    // display-only 0.5..3.0
@property(nonatomic, weak) UILabel *exagValueLabel;           // live value text (no row reload while dragging)
// Road Display control (0 Highways, 1 Highways+secondary, 2 All roads). Highway
// options are disabled when no primary roads are packaged (legacy/unclassified).
@property(nonatomic, assign) NSInteger roadDisplayMode;
@property(nonatomic, assign) BOOL primaryRoadsAvailable, secondaryRoadsAvailable;
@property(nonatomic, copy) void (^onChange)(ErisLayersSheetVC *sheet);
@end

@implementation ErisLayersSheetVC

- (instancetype)init { return [super initWithStyle:UITableViewStyleInsetGrouped]; }

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = @"Layers";
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(done)];
}

- (void)done { [self dismissViewControllerAnimated:YES completion:nil]; }
- (void)notify { if (self.onChange) self.onChange(self); }

// 4 sections when roads are packaged (adds "Road display"); 3 otherwise.
- (NSInteger)numberOfSectionsInTableView:(UITableView *)t { return self.roadsAvailable ? 4 : 3; }

- (NSInteger)tableView:(UITableView *)t numberOfRowsInSection:(NSInteger)s {
  // 0 base(3), 1 overlays(4), 2 appearance(2), 3 road display(3: Highways / +secondary / All)
  return s == 0 ? 3 : (s == 1 ? 4 : (s == 2 ? 2 : 3));
}

- (NSString *)tableView:(UITableView *)t titleForHeaderInSection:(NSInteger)s {
  return s == 0 ? @"Base surface" : (s == 1 ? @"Operational overlays" : (s == 2 ? @"Appearance" : @"Road display"));
}

- (NSString *)tableView:(UITableView *)t titleForFooterInSection:(NSInteger)s {
  if (s == 3 && !self.primaryRoadsAvailable) {
    return @"This package has no highway/primary roads. Showing all packaged roads (unclassified).";
  }
  if (s == 3) return @"Cross Section selects roads from the classes shown here.";
  return nil;
}

- (UITableViewCell *)tableView:(UITableView *)t cellForRowAtIndexPath:(NSIndexPath *)ip {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  if (ip.section == 0) {
    NSArray *titles = @[@"Terrain Relief", @"Satellite / Aerial Imagery", @"Hybrid: Satellite + Terrain Relief"];
    cell.textLabel.text = titles[ip.row];
    BOOL enabled = (ip.row == 0) || self.imageryAvailable;
    cell.textLabel.enabled = enabled;
    cell.userInteractionEnabled = enabled;
    cell.accessoryType = (self.baseSurface == ip.row) ? UITableViewCellAccessoryCheckmark : UITableViewCellAccessoryNone;
    if (!enabled) cell.detailTextLabel.text = @"Not packaged";
    cell.accessibilityLabel = [NSString stringWithFormat:@"%@%@", titles[ip.row],
                               enabled ? (self.baseSurface == ip.row ? @", selected" : @"") : @", unavailable"];
  } else if (ip.section == 1) {
    NSArray *titles = @[@"Road Context", @"Incident / Submitted Geometry", @"Package Boundary", @"Overview Map"];
    cell.textLabel.text = titles[ip.row];
    UISwitch *sw = [[UISwitch alloc] init];
    sw.tag = ip.row;
    BOOL enabled = YES, on = NO;
    if (ip.row == 0) { on = self.showRoads; enabled = self.roadsAvailable; }
    else if (ip.row == 1) { on = self.showOverlays; }
    else if (ip.row == 2) { on = self.showBoundary; }
    else { on = self.showOverview; enabled = self.overviewAvailable; }
    sw.on = on; sw.enabled = enabled;
    if (!enabled) cell.textLabel.enabled = NO;
    [sw addTarget:self action:@selector(onSwitch:) forControlEvents:UIControlEventValueChanged];
    sw.accessibilityLabel = titles[ip.row];
    cell.accessoryView = sw;
  } else if (ip.section == 2 && ip.row == 0) {
    // Vertical exaggeration — a DISPLAY setting; it does not change the packaged data.
    cell.textLabel.text = @"Vertical exaggeration";
    cell.detailTextLabel.text = ErisExagLabel(self.verticalExaggeration);
    cell.detailTextLabel.textColor = [UIColor secondaryLabelColor];
    self.exagValueLabel = cell.detailTextLabel;
    UISlider *sl = [[UISlider alloc] initWithFrame:CGRectMake(0, 0, 150, 30)];
    sl.minimumValue = (float)kErisVertExagMin; sl.maximumValue = (float)kErisVertExagMax;
    sl.value = (float)self.verticalExaggeration;
    sl.accessibilityLabel = @"Vertical exaggeration (display only)";
    sl.accessibilityValue = ErisExagLabel(self.verticalExaggeration);
    [sl addTarget:self action:@selector(onExagSlider:) forControlEvents:UIControlEventValueChanged];
    cell.accessoryView = sl;
  } else if (ip.section == 2) {
    cell.textLabel.text = @"Hillshade intensity";
    UISlider *sl = [[UISlider alloc] initWithFrame:CGRectMake(0, 0, 150, 30)];
    sl.minimumValue = 0.2f; sl.maximumValue = 1.0f; sl.value = (float)self.reliefIntensity;
    sl.accessibilityLabel = @"Hillshade intensity";
    [sl addTarget:self action:@selector(onHillshadeSlider:) forControlEvents:UIControlEventValueChanged];
    cell.accessoryView = sl;
  } else {
    // Road display: Highways / Highways + secondary / All roads. Highway options are
    // disabled when no primary roads are packaged so legacy packages can only pick All.
    NSArray *titles = @[@"Highways", @"Highways + secondary", @"All roads"];
    NSArray *hints = @[@"Primary roads only", @"Primary and secondary roads", @"Every packaged road"];
    cell.textLabel.text = titles[ip.row];
    cell.detailTextLabel.text = hints[ip.row];
    cell.detailTextLabel.textColor = [UIColor secondaryLabelColor];
    BOOL enabled = (ip.row == 2)
        || (ip.row == 0 && self.primaryRoadsAvailable)
        || (ip.row == 1 && (self.primaryRoadsAvailable || self.secondaryRoadsAvailable));
    cell.textLabel.enabled = enabled;
    cell.userInteractionEnabled = enabled;
    cell.accessoryType = (self.roadDisplayMode == ip.row) ? UITableViewCellAccessoryCheckmark : UITableViewCellAccessoryNone;
    cell.accessibilityLabel = [NSString stringWithFormat:@"%@%@", titles[ip.row],
                               self.roadDisplayMode == ip.row ? @", selected" : (enabled ? @"" : @", unavailable")];
  }
  return cell;
}

- (void)tableView:(UITableView *)t didSelectRowAtIndexPath:(NSIndexPath *)ip {
  if (ip.section == 3) {
    BOOL enabled = (ip.row == 2)
        || (ip.row == 0 && self.primaryRoadsAvailable)
        || (ip.row == 1 && (self.primaryRoadsAvailable || self.secondaryRoadsAvailable));
    if (!enabled) return;
    self.roadDisplayMode = ip.row;
    [t reloadSections:[NSIndexSet indexSetWithIndex:3] withRowAnimation:UITableViewRowAnimationNone];
    [self notify];
    return;
  }
  if (ip.section != 0) return;
  if (ip.row != 0 && !self.imageryAvailable) return;   // never select an unavailable surface
  self.baseSurface = ip.row;
  [t reloadSections:[NSIndexSet indexSetWithIndex:0] withRowAnimation:UITableViewRowAnimationNone];
  [self notify];
}

- (void)onSwitch:(UISwitch *)sw {
  switch (sw.tag) {
    case 0: self.showRoads = sw.on; break;
    case 1: self.showOverlays = sw.on; break;
    case 2: self.showBoundary = sw.on; break;
    default: self.showOverview = sw.on; break;
  }
  [self notify];
}

- (void)onHillshadeSlider:(UISlider *)sl { self.reliefIntensity = sl.value; [self notify]; }

// Snap the slider to 0.1 increments; update the live value label + accessibility
// value WITHOUT reloading the row (which would interrupt the in-progress drag).
- (void)onExagSlider:(UISlider *)sl {
  CGFloat snapped = ErisSnapExag(sl.value);
  sl.value = (float)snapped;
  self.verticalExaggeration = snapped;
  NSString *label = ErisExagLabel(snapped);
  self.exagValueLabel.text = label;
  sl.accessibilityValue = label;
  [self notify];
}

@end

// Renders the ERIS 'eristerrain' offline terrain bundle as a SceneKit mesh.
//
// Reads the extracted bundle directory (manifest.json + elevation-grid.bin +
// optional hillshade.png + overlays.json), builds a height-field mesh from the
// float32 grid, drapes the hillshade as the diffuse texture, then places the live
// ERIS overlays draped on the mesh surface using the manifest's local transform:
//   * incident marker;
//   * uploaded incident geometry (GeoJSON geometry/Feature/FeatureCollection/
//     GeometryCollection and Esri x-y/points/paths/rings; Point, MultiPoint,
//     LineString, Polygon and their multi-equivalents): LINES are truly clipped to the
//     package bounds (Liang-Barsky, separate parts); point/polygon vertices outside the
//     bounds are dropped — never invented coordinates;
//   * the terrain sample extent as a bounding rectangle (only when provided);
//   * the road-bearing line (only when a real bearing exists).
//
// The coordinate math (lon/lat -> grid col/row -> mesh XZ, Web Mercator coercion,
// bounds clipping) mirrors the unit-tested reference in src/arcgis/terrainOverlays.ts
// — keep the two in sync. Camera controls: orbit/pan/zoom/tilt (SCNView camera
// control) plus North and reset-to-incident.
//
// Offline CONTEXT LAYERS (packaged inside the bundle, read from local files only):
//   * a Layers control (base surface Terrain/Satellite/Hybrid — the latter two
//     enabled only when imagery.png was packaged; overlay toggles; relief intensity);
//   * packaged roads.geojson draped on the surface;
//   * a north-up 2D overview.png inset (lower-right);
//   * a Package Details sheet (sources/provenance) from the status pill.
// Everything is LOCAL — the terrain view controller makes NO network request.
// Corrupt/absent optional assets degrade that one layer; the base terrain stays up.
//
// VERTICAL EXAGGERATION (display only): the mesh + draped layers are built at
// PHYSICAL true scale (scene-units-per-metre from the package footprint; 1.0x =
// true scale) and Y-scaled together by exagNode for the 0.5x..3.0x control. This
// NEVER mutates gridData (the read-only source-derived elevation grid) or any
// packaged file — it only changes SceneKit geometry/transforms in memory.
// --- Cross Section pure helpers (mirror roadCrossSectionSlice.ts) ------------
static const double kXsMPerDegLat = 111320.0;
static const double kXsFtPerM = 3.280839895;

static double XsNum(NSDictionary *d, NSString *k, double def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : def;
}
static NSString *XsStr(NSDictionary *d, NSString *k, NSString *def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v isKindOfClass:[NSString class]] ? v : def;
}
static double XsNorm360(double deg) {
  double r = fmod(deg, 360.0);
  return r < 0 ? r + 360.0 : r;
}
// Cross-section axis bearing (LT->RT) = upstation + 90 (RT is to the right).
static double XsCrossBearing(double upstationDeg) { return XsNorm360(upstationDeg + 90.0); }
// Orient a segment tangent to the upstation hint hemisphere (within 90deg), else keep.
static double XsResolveUpstation(double tangentDeg, double hintDeg) {
  double t = XsNorm360(tangentDeg);
  if (!isfinite(hintDeg)) return t;
  double h = XsNorm360(hintDeg);
  double diff = fabs(fmod(t - h + 540.0, 360.0) - 180.0);
  return diff <= 90.0 ? t : XsNorm360(t + 180.0);
}
// Signed outside-shoulder edge offset (ft): LT negative, RT positive.
static double XsShoulderEdgeFt(NSDictionary *road, BOOL lt) {
  double mh = MAX(0, XsNum(road, @"median_width_ft", 0)) / 2.0;
  if (lt) {
    return -(mh + XsNum(road, @"lt_inside_shoulder_ft", 0)
             + XsNum(road, @"lt_lane_count", 1) * XsNum(road, @"lt_lane_width_ft", 12)
             + XsNum(road, @"lt_outside_shoulder_ft", 0));
  }
  return mh + XsNum(road, @"rt_inside_shoulder_ft", 0)
         + XsNum(road, @"rt_lane_count", 1) * XsNum(road, @"rt_lane_width_ft", 12)
         + XsNum(road, @"rt_outside_shoulder_ft", 0);
}

// --- Physical drape lifts (METRES above the mesh surface) --------------------
// Every draped overlay sits a few CENTIMETRES-to-DECIMETRES above the terrain mesh
// — enough to defeat z-fighting, and NOTHING like the tens of metres that the old
// worldSize-percentage lifts produced. On a ~3 km AOI, `worldSize * 0.018` put the
// road overlay ~27 m ABOVE the imagery; perspective parallax then made correctly
// located centrelines look horizontally displaced on the iPhone. These are true
// physical heights, converted to scene units via sceneUnitsPerMeter, and are each
// independently adjustable. Ordered so higher-priority overlays sit slightly above
// lower ones (selected road above roads above imagery) and never z-fight.
static const double kErisImageryDrapeLiftM    = 0.05;  // aerial imagery drape
static const double kErisRoadDrapeLiftM       = 0.30;  // packaged road centrelines
static const double kErisSubmittedGeomLiftM   = 0.35;  // uploaded incident line/polygon + sample extent
static const double kErisBoundaryLiftM        = 0.40;  // package boundary ring
static const double kErisSelectedRoadLiftM    = 0.55;  // highlighted selected road (Cross Section)
static const double kErisSliceIndicatorLiftM  = 0.65;  // cross-section slice indicator line
// Submitted point-of-interest marker radius (metre-derived + physically bounded —
// never a worldSize-percentage sphere implying tens of metres of ground footprint).
static const double kErisSubmittedPointRadiusM = 3.0;
// Incident marker: a small ground RING at the exact coordinate (8-12 m diameter — NOT
// the old 75 m sphere) plus a billboarded pin. Metre-derived + physically bounded.
static const double kErisIncidentRingDiameterM = 10.0;
static const double kErisIncidentPinLiftM       = 9.0;   // billboard pin height above the ring

// Draped-overlay layers, each with its own metre-derived lift (drapeLiftForLayer:).
typedef NS_ENUM(NSInteger, ErisDrapeLayer) {
  ErisDrapeImagery = 0,
  ErisDrapeRoad,
  ErisDrapeSubmitted,
  ErisDrapeBoundary,
  ErisDrapeSelectedRoad,
  ErisDrapeSliceIndicator,
};

// --- Road classification (mirrors the ERIS-trusted road_class from PR #50) ----
// The class is the ERIS-GENERATED road_class field ("primary"/"secondary"/"local");
// a legacy package with no road_class is honestly "unclassified" (never a silent
// highway). Provider attributes (NAME/MTFCC/RTTYP) are DISPLAY metadata only and
// never drive classification. Kept in lockstep with roadClass.ts (parity-tested).
static NSString *ErisRoadClassLabel(NSString *rc) {
  if ([rc isEqualToString:@"primary"]) return @"Primary road / highway";
  if ([rc isEqualToString:@"secondary"]) return @"Secondary road";
  if ([rc isEqualToString:@"local"]) return @"Local road";
  return @"Unclassified road";
}
// Selection/dedupe priority: primary > secondary > local > unclassified.
static NSInteger ErisRoadClassPriority(NSString *rc) {
  if ([rc isEqualToString:@"primary"]) return 3;
  if ([rc isEqualToString:@"secondary"]) return 2;
  if ([rc isEqualToString:@"local"]) return 1;
  return 0;
}

// Class-aware render style: hierarchy uses WIDTH + OPACITY (metres) in addition to
// colour, so a highway reads as a highway even in greyscale / to colour-blind users.
// Higher classes are wider, more opaque, lifted slightly higher, drawn last (on top).
typedef struct {
  double widthM;                 // ribbon width in METRES (physical, not worldSize %)
  CGFloat r, g, b;               // tasteful production palette (NOT the diagnostic's garish colours)
  CGFloat opacity;
  double liftM;                  // metre lift above the mesh (all < 1 m; highways slightly above locals)
  NSInteger order;              // SceneKit renderingOrder (higher = drawn on top)
} ErisRoadStyle;

static ErisRoadStyle ErisRoadStyleForClass(NSString *rc) {
  if ([rc isEqualToString:@"primary"])   return (ErisRoadStyle){9.0, 1.00, 0.80, 0.28, 1.00, 0.36, 40};
  if ([rc isEqualToString:@"secondary"]) return (ErisRoadStyle){5.0, 1.00, 0.62, 0.28, 0.92, 0.33, 30};
  if ([rc isEqualToString:@"local"])     return (ErisRoadStyle){2.5, 0.74, 0.80, 0.88, 0.68, 0.30, 20};
  return (ErisRoadStyle){3.5, 0.98, 0.82, 0.36, 0.85, 0.31, 25};  // unclassified / legacy (legacy yellow)
}

// Road Display filter (which classes are visible + selectable).
typedef NS_ENUM(NSInteger, ErisRoadDisplayMode) {
  ErisRoadDisplayHighways = 0,        // primary only
  ErisRoadDisplayHighwaysSecondary,   // primary + secondary
  ErisRoadDisplayAll,                 // all classes (incl. local + unclassified)
};

// Per-class snap tolerance (metres). Highways get a generous tolerance appropriate for
// divided carriageways + generalized TIGER geometry; locals a tight one. A closer local
// must NEVER out-rank an eligible highway (highway-first). Named + parity-tested.
static const double kErisSnapMaxPrimaryM   = 90.0;
static const double kErisSnapMaxSecondaryM = 65.0;
static const double kErisSnapMaxLocalM     = 45.0;   // local + unclassified + bearing fallback
static const NSInteger kErisMaxCandidates  = 3;      // bounded set gathered at complex interchanges

static double ErisSnapMaxMetersForClass(NSString *rc) {
  if ([rc isEqualToString:@"primary"]) return kErisSnapMaxPrimaryM;
  if ([rc isEqualToString:@"secondary"]) return kErisSnapMaxSecondaryM;
  return kErisSnapMaxLocalM;  // local / unclassified
}

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
// --- physical scale (true-scale baseline derived from the package footprint) ---
@property(nonatomic, assign) double sceneUnitsPerMeter; // horizontal AND (at 1.0x) vertical
@property(nonatomic, assign) double halfWidthUnits;     // mesh half-extent on X (east/west)
@property(nonatomic, assign) double halfDepthUnits;     // mesh half-extent on Z (north/south)
@property(nonatomic, assign) double terrainWidthM;      // physical footprint width (m)
@property(nonatomic, assign) double terrainHeightM;     // physical footprint height (m)
@property(nonatomic, assign) CGFloat verticalExaggeration; // display-only multiplier (0.5..3.0)
@property(nonatomic, strong) SCNNode *exagNode;         // Y-scaled container for terrain + draped layers
@property(nonatomic, strong) NSMutableArray<SCNNode *> *markerNodes; // spheres counter-scaled to stay round
@property(nonatomic, assign) SCNVector3 focusTarget; // incident (or terrain centre) TRUE-scale world pos
@property(nonatomic, strong) NSDictionary *manifest;
@property(nonatomic, strong) NSDictionary *terrainMeta;
@property(nonatomic, strong) UILabel *statusLabel;
// --- context layers (roads / imagery / overview) ---
@property(nonatomic, copy) NSString *extractedDir;
@property(nonatomic, strong) NSDictionary *contextLayers;    // manifest.context_layers
@property(nonatomic, strong) UIImage *hillshadeImage;        // hillshade.png (relief), if present
@property(nonatomic, strong) UIImage *imageryImage;          // imagery.png (aerial, legacy single-image), if present + valid
// Tiled high-definition aerial imagery: one JPEG per geographic tile, each mapped
// onto its own terrain patch. imageryTiled == YES when every declared tile loaded.
@property(nonatomic, assign) BOOL imageryTiled;
@property(nonatomic, strong) NSArray<NSDictionary *> *imageryTileMetas; // {image,bounds,file}
@property(nonatomic, strong) SCNNode *imageryTilesNode;      // per-tile imagery DRAPE patches (overlay above the mesh)
@property(nonatomic, assign) NSInteger imageryPatchCount;    // built patches (diagnostics)
@property(nonatomic, copy) NSString *imageryTilesStatus;     // "overlay drape (N patches)" | "disabled: <reason>"
// AOI geographic bounds (from local_transform/bounds) — used to slice the whole-AOI
// hillshade per tile in Hybrid, and shared by the true-scale math.
@property(nonatomic, assign) double aoiMinLon, aoiMinLat, aoiMaxLon, aoiMaxLat;
@property(nonatomic, strong) SCNNode *overlaysNode;          // incident / geometry / sample-extent / bearing
@property(nonatomic, strong) SCNNode *roadsNode;             // packaged roads.geojson
@property(nonatomic, strong) SCNNode *boundaryNode;          // package boundary ring
@property(nonatomic, strong) UIImageView *overviewView;      // north-up 2D inset (lower-right)
@property(nonatomic, assign) NSInteger baseSurface;          // 0 terrain, 1 satellite, 2 hybrid
@property(nonatomic, assign) BOOL showRoads;
@property(nonatomic, assign) BOOL showOverlays;
@property(nonatomic, assign) BOOL showBoundary;
@property(nonatomic, assign) BOOL showOverview;
@property(nonatomic, assign) CGFloat reliefIntensity;        // hillshade blend in hybrid (0..1)
// --- Cross Section tool (tap a road -> perpendicular roadway/terrain slice) ---
@property(nonatomic, assign) BOOL crossSectionMode;
@property(nonatomic, strong) UILabel *crossSectionBanner;
@property(nonatomic, strong) UIBarButtonItem *crossSectionItem;
@property(nonatomic, strong) SCNNode *sliceLineNode;          // translucent slice plane on the terrain
@property(nonatomic, strong) SCNNode *selectedRoadNode;      // highlighted candidate before Inspect (Part 6)
@property(nonatomic, strong) NSArray<NSDictionary *> *roadSnapFeatures; // {kind, coords, roadClass, name, ...}
@property(nonatomic, strong) NSDictionary *roadCrossSectionCtx; // packaged road_cross_section.json (or nil)
@property(nonatomic, assign) double upstationHintDeg;         // roadBearingDeg param hint (NAN if none)
// --- class-aware road rendering + Road Display filter (Part 4) ---
@property(nonatomic, strong) NSMutableDictionary<NSString *, SCNNode *> *roadClassNodes; // road_class -> container
@property(nonatomic, strong) NSSet<NSString *> *packagedRoadClasses;    // classes actually drawn
@property(nonatomic, assign) BOOL primaryRoadsPackaged;
@property(nonatomic, assign) BOOL secondaryRoadsPackaged;
@property(nonatomic, assign) ErisRoadDisplayMode roadDisplayMode;
// --- highway-first candidate selection + confirmation (Part 5/6) ---
@property(nonatomic, assign) ErisRoadDisplayMode selectionMode;  // Highway vs All Roads (mirrors display intent)
@property(nonatomic, strong) NSArray<NSDictionary *> *pendingCandidates;  // bounded candidate set awaiting confirm
@property(nonatomic, assign) NSInteger pendingCandidateIndex;
@property(nonatomic, assign) double pendingSelLat, pendingSelLon;
@property(nonatomic, strong) UIView *candidateCardView;          // bottom confirmation card
// --- map->inspection camera transition (Part 7) + cancellation (PR #51 review) ---
@property(nonatomic, assign) SCNMatrix4 savedCameraTransform;    // restored when inspection closes
@property(nonatomic, assign) SCNVector3 savedCameraTarget;
@property(nonatomic, assign) BOOL hasSavedCamera;
@property(nonatomic, strong) SCNNode *inspectionFocusNode;       // transient look-at target during the flight
@property(nonatomic, assign) BOOL transitionInProgress;
@property(nonatomic, assign) NSInteger transitionToken;          // monotonic; stale completions are ignored
@property(nonatomic, assign) BOOL didPresentInspection;          // gate the return-camera restore
@property(nonatomic, assign) BOOL inspectionConfirmed;           // keep highlight through inspection
@end

@implementation ErisTerrainSceneViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"3D Terrain (offline)";
  self.worldSize = 100.0f;
  // Default field experience: Terrain relief + Roads + Overview + incident marker.
  self.baseSurface = 0;         // terrain relief (satellite/hybrid enabled only when imagery packaged)
  self.showRoads = YES;
  self.showOverlays = YES;      // incident + submitted geometry
  self.showBoundary = NO;
  self.showOverview = YES;
  self.reliefIntensity = 0.85f;         // hillshade blend (NOT vertical exaggeration)
  self.verticalExaggeration = 1.0f;     // display-only; 1.0x = physical true scale
  self.markerNodes = [NSMutableArray array];
  self.upstationHintDeg = NAN;

  self.scnView = [[SCNView alloc] initWithFrame:self.view.bounds];
  self.scnView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.scnView.allowsCameraControl = YES;       // orbit / pan / zoom / tilt
  self.scnView.backgroundColor = [UIColor colorWithRed:0.05 green:0.07 blue:0.12 alpha:1.0];
  self.scnView.scene = [SCNScene scene];
  [self.view addSubview:self.scnView];
  // Single-tap picks a road when the Cross Section tool is active (coexists with the
  // camera-control pan/pinch gestures). Inactive at all other times.
  UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(onSceneTap:)];
  [self.scnView addGestureRecognizer:tap];

  // Status pill (version / source / offline).
  self.statusLabel = [[UILabel alloc] initWithFrame:CGRectZero];
  self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
  self.statusLabel.numberOfLines = 2;
  self.statusLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
  self.statusLabel.textColor = [UIColor whiteColor];
  self.statusLabel.backgroundColor = [UIColor colorWithWhite:0 alpha:0.55];
  self.statusLabel.layer.cornerRadius = 6;
  self.statusLabel.clipsToBounds = YES;
  self.statusLabel.userInteractionEnabled = YES;
  self.statusLabel.isAccessibilityElement = YES;
  self.statusLabel.accessibilityHint = @"Shows offline package details";
  [self.statusLabel addGestureRecognizer:
      [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(onShowDetails)]];
  [self.view addSubview:self.statusLabel];
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.statusLabel.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:10],
    [self.statusLabel.topAnchor constraintEqualToAnchor:g.topAnchor constant:10],
    [self.statusLabel.widthAnchor constraintLessThanOrEqualToAnchor:g.widthAnchor multiplier:0.62],
  ]];

  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Close" style:UIBarButtonItemStyleDone target:self action:@selector(onClose)];
  UIBarButtonItem *layers = [[UIBarButtonItem alloc] initWithTitle:@"Layers" style:UIBarButtonItemStylePlain
                                                            target:self action:@selector(onLayers)];
  layers.accessibilityLabel = @"Layers";
  self.crossSectionItem = [[UIBarButtonItem alloc] initWithTitle:@"Cross Section" style:UIBarButtonItemStylePlain
                                                          target:self action:@selector(onCrossSection)];
  self.crossSectionItem.accessibilityLabel = @"Cross Section";
  self.navigationItem.leftBarButtonItems = @[
    layers,
    [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain target:self action:@selector(resetToIncident)],
    [[UIBarButtonItem alloc] initWithTitle:@"North" style:UIBarButtonItemStylePlain target:self action:@selector(resetNorth)],
    self.crossSectionItem,
  ];

  [self loadBundle];
}

- (void)onClose {
  [self cancelInspectionTransition];   // Close during a camera flight must not present later
  [self dismissViewControllerAnimated:YES completion:nil];
}

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

  // gridData is the loaded raw float32 SOURCE-DERIVED elevation grid (metres). It is
  // read-only for the lifetime of the view — the vertical-exaggeration control is a
  // pure DISPLAY transform and NEVER mutates it or any packaged file.
  self.gridData = gridData;
  self.noData = [self.terrainMeta[@"no_data_value"] doubleValue];
  self.minE = [self.terrainMeta[@"min_elevation_m"] doubleValue];
  self.maxE = [self.terrainMeta[@"max_elevation_m"] doubleValue];
  [self computePhysicalScale];   // true-scale scene-units/metre + aspect-correct half-extents

  self.extractedDir = dir;

  // exagNode Y-scales the terrain + ALL draped layers together for vertical
  // exaggeration (a DISPLAY transform only). Lights + camera stay on rootNode so
  // they are never scaled. Everything under exagNode is built at TRUE scale (1.0x).
  self.exagNode = [SCNNode node];
  [self.scnView.scene.rootNode addChildNode:self.exagNode];

  SCNNode *terrain = [self buildTerrainNode];
  self.terrainNode = terrain;
  [self.exagNode addChildNode:terrain];

  // Container nodes so each overlay layer can be toggled independently.
  self.overlaysNode = [SCNNode node];
  self.roadsNode = [SCNNode node];
  self.boundaryNode = [SCNNode node];
  [self.exagNode addChildNode:self.overlaysNode];
  [self.exagNode addChildNode:self.roadsNode];
  [self.exagNode addChildNode:self.boundaryNode];

  [self loadContextTextures:dir];   // hillshade + optional aerial imagery (local files only)
  [self buildImageryTilesNode];     // per-tile terrain patches for tiled imagery (drape)
  [self applyBaseSurface];          // set the terrain material from the current base surface

  [self addLighting];
  [self computeFocusTargetFromParams:p];
  [self addOverlaysFromParams:p];   // incident / geometry / sample-extent / bearing -> overlaysNode
  [self buildRoadsLayer];           // packaged roads.geojson -> roadsNode
  [self loadCrossSectionContext:p]; // road_cross_section.json + snap features (offline)
  [self buildBoundaryLayer];        // package boundary ring -> boundaryNode
  [self buildOverviewInset];        // north-up 2D inset (lower-right)
  [self applyLayerVisibility];
  [self applyVerticalExaggeration]; // exagNode.scale + marker counter-scales (no camera move here)
  [self setupCamera];
  [self updateStatusWithParams:p];
}

// True-scale baseline from the package footprint (NOT a magic visual constant).
// Prefers terrain.local_transform; falls back to bounds; fails safe on degenerate
// metadata. Mirrors physicalFootprintMeters/sceneScale in src/arcgis/terrainScale.ts.
- (void)computePhysicalScale {
  double minLat = 0, minLon = 0, maxLat = 0, maxLon = 0;
  BOOL ok = NO;
  NSDictionary *lt = [self.terrainMeta[@"local_transform"] isKindOfClass:[NSDictionary class]] ? self.terrainMeta[@"local_transform"] : nil;
  if (lt) {
    double originLon = [lt[@"origin_lon"] doubleValue], originLat = [lt[@"origin_lat"] doubleValue];
    double lonPerCol = [lt[@"lon_per_col"] doubleValue], latPerRow = [lt[@"lat_per_row"] doubleValue];
    if (isfinite(originLon) && isfinite(originLat) && lonPerCol > 0 && latPerRow < 0 && self.cols > 1 && self.rows > 1) {
      minLon = originLon; maxLon = originLon + lonPerCol * (self.cols - 1);
      maxLat = originLat; minLat = originLat + latPerRow * (self.rows - 1);
      ok = YES;
    }
  }
  if (!ok) {
    NSDictionary *b = [self.terrainMeta[@"bounds"] isKindOfClass:[NSDictionary class]] ? self.terrainMeta[@"bounds"] : nil;
    if (b) {
      minLat = [b[@"min_lat"] doubleValue]; minLon = [b[@"min_lon"] doubleValue];
      maxLat = [b[@"max_lat"] doubleValue]; maxLon = [b[@"max_lon"] doubleValue];
      ok = (maxLat > minLat && maxLon > minLon);
    }
  }
  // Remember the AOI bounds (used to slice the whole-AOI hillshade per imagery tile).
  self.aoiMinLon = minLon; self.aoiMinLat = minLat; self.aoiMaxLon = maxLon; self.aoiMaxLat = maxLat;
  double widthM = 0, heightM = 0;
  if (ok) {
    double midLat = (minLat + maxLat) / 2.0;
    double cosLat = cos(midLat * M_PI / 180.0); if (fabs(cosLat) < 1e-6) cosLat = 1e-6;
    widthM = (maxLon - minLon) * 111320.0 * fabs(cosLat);
    heightM = (maxLat - minLat) * 111320.0;
  }
  if (!(widthM > 0) || !(heightM > 0)) { widthM = heightM = 1000.0; }  // degenerate -> safe square
  self.terrainWidthM = widthM;
  self.terrainHeightM = heightM;
  // The larger horizontal dimension fills 2*worldSize scene units; the smaller keeps
  // the true aspect ratio (never forced square). This factor is also the 1.0x
  // vertical scale, so a metre up looks like a metre across.
  double maxDim = MAX(widthM, heightM);
  self.sceneUnitsPerMeter = (2.0 * self.worldSize) / maxDim;
  self.halfWidthUnits = widthM * self.sceneUnitsPerMeter / 2.0;
  self.halfDepthUnits = heightM * self.sceneUnitsPerMeter / 2.0;
}

#pragma mark - Physical scale conversions (metres -> scene units)

// Canonical metre -> scene-unit conversion for any PHYSICAL height or size. Use this
// (never a worldSize percentage) whenever a quantity represents real metres, so a
// value looks the same physical size on a 1 km AOI and a 5 km AOI. sceneUnitsPerMeter
// is the true-scale baseline from the package footprint (computePhysicalScale).
- (float)sceneUnitsForMeters:(double)meters {
  return (float)(meters * self.sceneUnitsPerMeter);
}

// Metre lift for a draped overlay layer (source of truth for drapeLiftForLayer:).
- (double)drapeLiftMetersForLayer:(ErisDrapeLayer)layer {
  switch (layer) {
    case ErisDrapeImagery:        return kErisImageryDrapeLiftM;
    case ErisDrapeRoad:           return kErisRoadDrapeLiftM;
    case ErisDrapeSubmitted:      return kErisSubmittedGeomLiftM;
    case ErisDrapeBoundary:       return kErisBoundaryLiftM;
    case ErisDrapeSelectedRoad:   return kErisSelectedRoadLiftM;
    case ErisDrapeSliceIndicator: return kErisSliceIndicatorLiftM;
  }
  return kErisRoadDrapeLiftM;
}

// Scene-unit drape lift for a layer — the ONLY way draped overlays get their height.
// Metre-derived, so the overlay hugs the imagery (~decimetres up) at any AOI size.
- (float)drapeLiftForLayer:(ErisDrapeLayer)layer {
  return [self sceneUnitsForMeters:[self drapeLiftMetersForLayer:layer]];
}

// Apply the display-only vertical exaggeration: Y-scale the container, and
// counter-scale marker spheres so they track the scaled surface but stay round.
// Updates the orbit target's height WITHOUT moving/re-orienting the camera.
- (void)applyVerticalExaggeration {
  CGFloat e = ErisSnapExag(self.verticalExaggeration);
  self.verticalExaggeration = e;
  self.exagNode.scale = SCNVector3Make(1.0f, (float)e, 1.0f);
  float inv = e > 0 ? (float)(1.0 / e) : 1.0f;
  for (SCNNode *m in self.markerNodes) m.scale = SCNVector3Make(1.0f, inv, 1.0f);
  if (self.cameraNode != nil) {
    // Keep camera position/orientation/zoom; only move the orbit pivot in Y.
    self.scnView.defaultCameraController.target = [self scaledFocusTarget];
  }
}

// Load local textures (hillshade + optional aerial imagery) and the manifest's
// context_layers. NEVER touches the network — reads only the extracted files.
- (void)loadContextTextures:(NSString *)dir {
  self.contextLayers = [self.manifest[@"context_layers"] isKindOfClass:[NSDictionary class]]
                           ? self.manifest[@"context_layers"] : @{};
  NSString *hsPath = [dir stringByAppendingPathComponent:@"hillshade.png"];
  if ([[NSFileManager defaultManager] fileExistsAtPath:hsPath]) {
    self.hillshadeImage = [UIImage imageWithContentsOfFile:hsPath];
  }
  // Aerial imagery: TILED (one JPEG per geographic tile) is preferred; a legacy
  // single imagery.png is the backward-compatible fallback. Used ONLY when the
  // manifest declared it available AND the file(s) load as valid images (a corrupt
  // image just disables imagery — the terrain still renders).
  NSDictionary *imgLayer = [self.contextLayers[@"imagery"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"imagery"] : nil;
  if ([self layerAvailable:@"imagery"]) {
    if ([imgLayer[@"format"] isEqual:@"tiled"] && [imgLayer[@"tiles"] isKindOfClass:[NSArray class]]) {
      [self loadTiledImagery:imgLayer dir:dir];
    } else {
      NSString *imgPath = [dir stringByAppendingPathComponent:@"imagery.png"];
      if ([[NSFileManager defaultManager] fileExistsAtPath:imgPath]) {
        self.imageryImage = [UIImage imageWithContentsOfFile:imgPath];
      }
    }
  }
  if (![self imageryUsable] && self.baseSurface != 0) {
    self.baseSurface = 0;  // no usable imagery -> force terrain relief
  }
}

// Load every declared imagery tile as a UIImage + its geographic bounds. imageryTiled
// is set ONLY when ALL tiles load — a partial set would leave holes, so we fall back
// to terrain relief rather than render an incomplete surface.
- (void)loadTiledImagery:(NSDictionary *)imgLayer dir:(NSString *)dir {
  NSArray *tiles = imgLayer[@"tiles"];
  NSMutableArray<NSDictionary *> *metas = [NSMutableArray array];
  for (id t in tiles) {
    if (![t isKindOfClass:[NSDictionary class]]) continue;
    NSString *file = [t[@"file"] isKindOfClass:[NSString class]] ? t[@"file"] : nil;
    NSDictionary *b = [t[@"bounds"] isKindOfClass:[NSDictionary class]] ? t[@"bounds"] : nil;
    if (file.length == 0 || b == nil) { metas = nil; break; }
    NSString *path = [dir stringByAppendingPathComponent:file];
    UIImage *img = [[NSFileManager defaultManager] fileExistsAtPath:path] ? [UIImage imageWithContentsOfFile:path] : nil;
    if (img == nil) { metas = nil; break; }   // any missing/corrupt tile -> disable tiled imagery
    [metas addObject:@{@"image": img, @"bounds": b, @"file": file}];
  }
  if (metas != nil && metas.count > 0) {
    self.imageryTileMetas = metas;
    self.imageryTiled = YES;
  }
}

// Whether a named context layer is declared available in the manifest. Tiled imagery
// declares a `tiles` array instead of a single `file`.
- (BOOL)layerAvailable:(NSString *)name {
  NSDictionary *layer = [self.contextLayers[name] isKindOfClass:[NSDictionary class]] ? self.contextLayers[name] : nil;
  if (layer == nil || ![layer[@"available"] boolValue]) return NO;
  if ([name isEqualToString:@"imagery"] && [layer[@"format"] isEqual:@"tiled"]) {
    id tiles = layer[@"tiles"];
    return [tiles isKindOfClass:[NSArray class]] && [tiles count] > 0;
  }
  id file = layer[@"file"];
  return [file isKindOfClass:[NSString class]] && [file length] > 0;
}

// Usable when a legacy single image loaded, OR all tiled imagery tiles loaded.
- (BOOL)imageryUsable { return self.imageryImage != nil || (self.imageryTiled && self.imageryTileMetas.count > 0); }

// Build a TRUE-SCALE height-field mesh (1.0x). World X = east (col), Z = south
// (row), Y = elevation. X/Z use the physical footprint half-extents (aspect-correct,
// NOT forced square); Y = (elevation - minElevation) * sceneUnitsPerMeter. Vertical
// exaggeration is applied later as a container Y-scale (exagNode), never baked here.
- (SCNNode *)buildTerrainNode {
  NSInteger rows = self.rows, cols = self.cols;
  const float *h = (const float *)self.gridData.bytes;  // little-endian float32 (iOS is LE); READ-ONLY
  float halfX = (float)self.halfWidthUnits;
  float halfZ = (float)self.halfDepthUnits;
  double supm = self.sceneUnitsPerMeter;

  NSUInteger vcount = (NSUInteger)(rows * cols);
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  ErisTerrainTexCoord *uvs = malloc(sizeof(ErisTerrainTexCoord) * vcount);  // packed 2x float32
  for (NSInteger r = 0; r < rows; r++) {
    for (NSInteger c = 0; c < cols; c++) {
      NSUInteger i = (NSUInteger)(r * cols + c);
      double e = (double)h[i];
      if (!isfinite(e) || e == self.noData) e = self.minE;        // no-data -> flat at min
      float x = ((float)c / (float)(cols - 1) - 0.5f) * (2.0f * halfX);
      float z = ((float)r / (float)(rows - 1) - 0.5f) * (2.0f * halfZ);
      float y = (float)((e - self.minE) * supm);                  // true scale (exag via exagNode)
      verts[i] = SCNVector3Make(x, y, z);
      // u = c/(cols-1), v = r/(rows-1) — aligns the aerial/hillshade texture to the mesh.
      uvs[i] = (ErisTerrainTexCoord){.u = (float)c / (float)(cols - 1), .v = (float)r / (float)(rows - 1)};
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
  SCNGeometrySource *uvSrc = [SCNGeometrySource geometrySourceWithData:[NSData dataWithBytes:uvs length:sizeof(ErisTerrainTexCoord) * vcount]
                                                              semantic:SCNGeometrySourceSemanticTexcoord
                                                           vectorCount:vcount
                                                       floatComponents:YES
                                                   componentsPerVector:2
                                                     bytesPerComponent:sizeof(float)
                                                            dataOffset:0
                                                            dataStride:sizeof(ErisTerrainTexCoord)];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * icount]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:icount / 3
                                                        bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[vSrc, uvSrc] elements:@[el]];
  SCNMaterial *mat = [SCNMaterial material];
  mat.diffuse.contents = [UIColor colorWithRed:0.45 green:0.42 blue:0.36 alpha:1.0];
  // Clamp in both directions — the texture maps 1:1 onto the mesh; never tile/repeat.
  mat.diffuse.wrapS = SCNWrapModeClamp;
  mat.diffuse.wrapT = SCNWrapModeClamp;
  mat.multiply.wrapS = SCNWrapModeClamp;
  mat.multiply.wrapT = SCNWrapModeClamp;
  mat.doubleSided = YES;
  geo.firstMaterial = mat;
  free(verts); free(uvs); free(idx);
  return [SCNNode nodeWithGeometry:geo];
}

#pragma mark - Tiled aerial imagery (per-tile terrain patches)

// Build one draped terrain patch per imagery tile so each tile texture maps ONLY
// onto its correct geographic terrain area (no seams, no bleeding, no wrong-tile
// mapping). Patches are children of exagNode (so vertical exaggeration scales them
// with the terrain) and share the exact same surface sampling as the base mesh +
// overlays, so tile edges coincide with neighbours (seamless) and everything stays
// aligned. Hidden until Satellite/Hybrid selects tiled imagery.
- (void)buildImageryTilesNode {
  if (!self.imageryTiled || self.imageryTileMetas.count == 0) return;
  // RUNTIME SAFETY: validate the tile bounds (valid order + no overlap/gap surprises)
  // BEFORE building. A bad plan disables tiled imagery entirely and falls back to
  // single-image / terrain relief — never a broken partial tiled surface.
  NSString *why = [self validateTileBounds];
  if (why != nil) { [self disableTiledImagery:why]; return; }

  SCNNode *node = [SCNNode node];
  NSInteger built = 0;
  for (NSDictionary *meta in self.imageryTileMetas) {
    SCNNode *patch = [self buildImageryPatch:meta];
    if (patch == nil) { [self disableTiledImagery:@"a tile patch could not be built"]; return; }
    [node addChildNode:patch];
    built++;
  }
  // Every declared tile MUST have produced exactly one patch.
  if (built != (NSInteger)self.imageryTileMetas.count) {
    [self disableTiledImagery:@"patch count != tile count"];
    return;
  }
  self.imageryTilesNode = node;
  self.imageryTilesNode.hidden = YES;   // shown by applyBaseSurface when tiled imagery is active
  self.imageryPatchCount = built;
  self.imageryTilesStatus = [NSString stringWithFormat:@"overlay drape on base terrain (%ld patches)", (long)built];
  [self.exagNode addChildNode:self.imageryTilesNode];   // under exagNode -> scales with exaggeration
}

// Disable tiled imagery at runtime and fall back to single-image (if packaged) or
// terrain relief. Never leave a partial/broken tiled surface.
- (void)disableTiledImagery:(NSString *)reason {
  self.imageryTiled = NO;
  self.imageryTileMetas = nil;
  self.imageryTilesNode = nil;
  self.imageryPatchCount = 0;
  self.imageryTilesStatus = [NSString stringWithFormat:@"disabled: %@ (fell back to %@)",
                             reason, self.imageryImage ? @"single-image imagery" : @"terrain relief"];
  if (![self imageryUsable] && self.baseSurface != 0) self.baseSurface = 0;  // force relief if nothing usable
}

// nil if the tile bounds are valid + non-overlapping; else a short reason. Shared
// edges are allowed (abutting tiles); only interior overlap is rejected.
- (NSString *)validateTileBounds {
  NSMutableArray<NSArray<NSNumber *> *> *rects = [NSMutableArray array];
  for (NSDictionary *meta in self.imageryTileMetas) {
    NSDictionary *b = meta[@"bounds"];
    if (![b isKindOfClass:[NSDictionary class]]) return @"missing tile bounds";
    double mnLon = [b[@"min_lon"] doubleValue], mxLon = [b[@"max_lon"] doubleValue];
    double mnLat = [b[@"min_lat"] doubleValue], mxLat = [b[@"max_lat"] doubleValue];
    if (!(mxLon > mnLon) || !(mxLat > mnLat)) return @"invalid tile bounds (min >= max)";
    [rects addObject:@[@(mnLon), @(mxLon), @(mnLat), @(mxLat)]];
  }
  double eps = 1e-7;
  for (NSUInteger i = 0; i < rects.count; i++) {
    for (NSUInteger j = i + 1; j < rects.count; j++) {
      double ox = MIN([rects[i][1] doubleValue], [rects[j][1] doubleValue]) - MAX([rects[i][0] doubleValue], [rects[j][0] doubleValue]);
      double oy = MIN([rects[i][3] doubleValue], [rects[j][3] doubleValue]) - MAX([rects[i][2] doubleValue], [rects[j][2] doubleValue]);
      if (ox > eps && oy > eps) return @"overlapping tile bounds";
    }
  }
  return nil;
}

// Tiny lift so imagery patches drape ABOVE the base terrain surface (avoids z-fighting)
// without visibly floating. Metre-derived (~5 cm); exagNode scales it with the terrain.
- (float)imageryDrapeLift { return [self drapeLiftForLayer:ErisDrapeImagery]; }

// A height-field patch covering ONE tile's geographic bounds. Vertices are sampled
// from the SAME grid mapping used by the base mesh + overlays (surfaceWorldForCol),
// so adjacent patches share identical edge positions (seamless). UV 0..1 maps the
// tile image across the patch (clamp — never tile/repeat). For Hybrid, the whole-AOI
// hillshade is sliced to this tile via the material multiply layer's contentsTransform.
- (SCNNode *)buildImageryPatch:(NSDictionary *)meta {
  UIImage *img = meta[@"image"];
  NSDictionary *b = meta[@"bounds"];
  if (![img isKindOfClass:[UIImage class]] || ![b isKindOfClass:[NSDictionary class]]) return nil;
  double tMinLon = [b[@"min_lon"] doubleValue], tMaxLon = [b[@"max_lon"] doubleValue];
  double tMinLat = [b[@"min_lat"] doubleValue], tMaxLat = [b[@"max_lat"] doubleValue];
  if (!(tMaxLon > tMinLon) || !(tMaxLat > tMinLat)) return nil;

  // Tile bounds -> fractional grid (col,row) range (row 0 = north edge).
  double c0, r0, c1, r1;
  if (![self colRowForLat:tMaxLat lon:tMinLon outCol:&c0 outRow:&r0]) return nil;  // NW corner
  if (![self colRowForLat:tMinLat lon:tMaxLon outCol:&c1 outRow:&r1]) return nil;  // SE corner
  // Clamp into the grid so a tile that slightly overhangs still samples valid cells.
  c0 = MIN(MAX(c0, 0.0), (double)(self.cols - 1)); c1 = MIN(MAX(c1, 0.0), (double)(self.cols - 1));
  r0 = MIN(MAX(r0, 0.0), (double)(self.rows - 1)); r1 = MIN(MAX(r1, 0.0), (double)(self.rows - 1));
  if (!(c1 > c0) || !(r1 > r0)) return nil;

  // Tessellate at ~grid density within the tile (so the patch shape matches the base
  // mesh), capped for safety.
  const NSInteger kMaxPatchDim = 64;
  NSInteger nCols = (NSInteger)ceil(c1 - c0) + 1; nCols = MAX(2, MIN(kMaxPatchDim, nCols));
  NSInteger nRows = (NSInteger)ceil(r1 - r0) + 1; nRows = MAX(2, MIN(kMaxPatchDim, nRows));

  NSUInteger vcount = (NSUInteger)(nRows * nCols);
  float lift = [self imageryDrapeLift];   // drape slightly ABOVE the base mesh (no z-fight, no replacement)
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  ErisTerrainTexCoord *uvs = malloc(sizeof(ErisTerrainTexCoord) * vcount);  // packed 2x float32 (no UV regression)
  for (NSInteger i = 0; i < nRows; i++) {
    for (NSInteger j = 0; j < nCols; j++) {
      double fu = (double)j / (double)(nCols - 1);
      double fv = (double)i / (double)(nRows - 1);   // v=0 at r0 (north edge) — matches the north-up export
      double col = c0 + fu * (c1 - c0);
      double row = r0 + fv * (r1 - r0);
      NSUInteger k = (NSUInteger)(i * nCols + j);
      verts[k] = [self surfaceWorldForCol:col row:row lift:lift];   // base-mesh surface + drape lift (true scale)
      uvs[k] = (ErisTerrainTexCoord){.u = (float)fu, .v = (float)fv};
    }
  }
  NSUInteger quadCount = (NSUInteger)((nRows - 1) * (nCols - 1));
  NSUInteger icount = quadCount * 6;
  int *idx = malloc(sizeof(int) * icount);
  NSUInteger m = 0;
  for (NSInteger i = 0; i < nRows - 1; i++) {
    for (NSInteger j = 0; j < nCols - 1; j++) {
      int tl = (int)(i * nCols + j), tr = tl + 1, bl = (int)((i + 1) * nCols + j), br = bl + 1;
      idx[m++] = tl; idx[m++] = bl; idx[m++] = tr;
      idx[m++] = tr; idx[m++] = bl; idx[m++] = br;
    }
  }

  SCNGeometrySource *vSrc = [SCNGeometrySource geometrySourceWithVertices:verts count:vcount];
  SCNGeometrySource *uvSrc = [SCNGeometrySource geometrySourceWithData:[NSData dataWithBytes:uvs length:sizeof(ErisTerrainTexCoord) * vcount]
                                                              semantic:SCNGeometrySourceSemanticTexcoord
                                                           vectorCount:vcount
                                                       floatComponents:YES
                                                   componentsPerVector:2
                                                     bytesPerComponent:sizeof(float)
                                                            dataOffset:0
                                                            dataStride:sizeof(ErisTerrainTexCoord)];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * icount]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:icount / 3
                                                        bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[vSrc, uvSrc] elements:@[el]];

  SCNMaterial *mat = [SCNMaterial material];
  mat.diffuse.contents = img;
  mat.diffuse.wrapS = SCNWrapModeClamp;   // one tile image, one patch — never tile/repeat
  mat.diffuse.wrapT = SCNWrapModeClamp;
  // Hybrid: slice the whole-AOI hillshade to this tile's sub-rectangle so relief lines
  // up with the imagery. intensity is toggled by applyBaseSurface (0 = satellite).
  if (self.hillshadeImage != nil) {
    double du = self.aoiMaxLon - self.aoiMinLon, dv = self.aoiMaxLat - self.aoiMinLat;
    if (du > 0 && dv > 0) {
      float uLo = (float)((tMinLon - self.aoiMinLon) / du);
      float uHi = (float)((tMaxLon - self.aoiMinLon) / du);
      float vLo = (float)((self.aoiMaxLat - tMaxLat) / dv);   // v: row 0 = north
      float vHi = (float)((self.aoiMaxLat - tMinLat) / dv);
      SCNMatrix4 tx = SCNMatrix4MakeScale(uHi - uLo, vHi - vLo, 1.0f);
      tx.m41 = uLo; tx.m42 = vLo;   // sampledUV = localUV * scale + offset
      mat.multiply.contents = self.hillshadeImage;
      mat.multiply.contentsTransform = tx;
      mat.multiply.wrapS = SCNWrapModeClamp;
      mat.multiply.wrapT = SCNWrapModeClamp;
      mat.multiply.intensity = 0.0;   // off until Hybrid
    }
  }
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
  return (float)((e - self.minE) * self.sceneUnitsPerMeter);   // TRUE scale (exag applied by exagNode)
}

// grid (col,row) -> TRUE-scale world XZ on the mesh (aspect-correct); Y = sampled
// surface + lift. All draped content shares this true-scale space and is Y-scaled
// together by exagNode, so it stays aligned at any vertical exaggeration.
- (SCNVector3)surfaceWorldForCol:(double)col row:(double)row lift:(float)lift {
  float halfX = (float)self.halfWidthUnits;
  float halfZ = (float)self.halfDepthUnits;
  float x = ((float)(col / (double)(self.cols - 1)) - 0.5f) * (2.0f * halfX);
  float z = ((float)(row / (double)(self.rows - 1)) - 0.5f) * (2.0f * halfZ);
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
      [self addIncidentMarkerAtCol:col row:row];
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
    if ([self surfaceWorldForLat:incLat lon:incLon lift:[self drapeLiftForLayer:ErisDrapeRoad] out:&c]) {
      // Length is a VISUAL framing proportion (a synthetic direction indicator has no
      // "true" physical length) — legitimately worldSize-relative, not a metre measure.
      float len = self.worldSize * 0.4f;
      SCNVector3 a = SCNVector3Make(c.x - sinf(rad) * len, c.y, c.z + cosf(rad) * len);
      SCNVector3 b = SCNVector3Make(c.x + sinf(rad) * len, c.y, c.z - cosf(rad) * len);
      SCNNode *line = [self polylineFromPoints:@[[NSValue valueWithSCNVector3:a], [NSValue valueWithSCNVector3:b]]
                                         color:[UIColor colorWithRed:0.98 green:0.80 blue:0.13 alpha:1.0]
                                        closed:NO];
      if (line) [self.overlaysNode addChildNode:line];
    }
  }
}

// Restrained incident-location marker (Part 2): a metre-scaled ground RING at the
// EXACT incident coordinate (kErisIncidentRingDiameterM ~ 10 m — never a 75 m sphere),
// a small centre dot for close range, and a billboarded pin above it that always faces
// the camera. All metre-derived + counter-scaled so they stay round under vertical
// exaggeration; the thin ring does not obscure the road beneath it.
- (void)addIncidentMarkerAtCol:(double)col row:(double)row {
  UIColor *incidentColor = [UIColor colorWithRed:0.16 green:0.45 blue:0.95 alpha:1.0];
  SCNVector3 ground = [self surfaceWorldForCol:col row:row lift:[self drapeLiftForLayer:ErisDrapeSubmitted]];
  double dia = kErisIncidentRingDiameterM;

  // Ground ring (torus lies flat in the XZ plane): outer diameter ~= dia.
  SCNTorus *torus = [SCNTorus torusWithRingRadius:[self sceneUnitsForMeters:dia * 0.42]
                                       pipeRadius:[self sceneUnitsForMeters:dia * 0.08]];
  torus.firstMaterial.diffuse.contents = incidentColor;
  torus.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNNode *ring = [SCNNode nodeWithGeometry:torus];
  ring.position = ground;
  ring.name = @"Incident location";
  [self.overlaysNode addChildNode:ring];
  [self.markerNodes addObject:ring];   // counter-scaled -> stays a flat round ring under exaggeration

  // Small centre dot (metre-derived, bounded) for close-range readability.
  SCNNode *dot = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:[self sceneUnitsForMeters:dia * 0.12]]];
  dot.geometry.firstMaterial.diffuse.contents = incidentColor;
  dot.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
  dot.position = ground;
  [self.overlaysNode addChildNode:dot];
  [self.markerNodes addObject:dot];

  // Billboarded pin head above the ring: always faces the camera (bounded, readable at
  // overview + close range) WITHOUT implying a large ground footprint.
  SCNNode *pin = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:[self sceneUnitsForMeters:dia * 0.22]]];
  pin.geometry.firstMaterial.diffuse.contents = incidentColor;
  pin.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
  SCNBillboardConstraint *bb = [SCNBillboardConstraint billboardConstraint];
  bb.freeAxes = SCNBillboardAxisAll;
  pin.constraints = @[bb];
  pin.position = SCNVector3Make(ground.x, ground.y + [self sceneUnitsForMeters:kErisIncidentPinLiftM], ground.z);
  pin.name = @"Incident location";
  [self.overlaysNode addChildNode:pin];
  [self.markerNodes addObject:pin];

  // Accessible identification of the marker (VoiceOver reads the scene status pill).
  self.scnView.accessibilityLabel = @"Offline 3D terrain with incident location marker";
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
    [pts addObject:[NSValue valueWithSCNVector3:[self surfaceWorldForCol:col row:row lift:[self drapeLiftForLayer:ErisDrapeSubmitted]]]];
  }
  SCNNode *rect = [self polylineFromPoints:pts color:[UIColor colorWithRed:0.42 green:0.84 blue:0.96 alpha:1.0] closed:NO];
  if (rect) [self.overlaysNode addChildNode:rect];
}

// Render normalized overlay primitives draped on the surface. LINES are TRULY CLIPPED to
// the terrain-grid bounds (Liang-Barsky, separate parts — a segment crossing the terrain
// with both endpoints outside is retained). POINTS outside the bounds are dropped, and
// POLYGON outlines drop out-of-bounds vertices. Never invents coordinates.
- (void)addUploadedGeometry:(id)geom {
  NSArray<NSDictionary *> *prims = [self primitivesFromGeometry:geom];
  UIColor *lineColor = [UIColor colorWithRed:0.30 green:0.93 blue:0.55 alpha:1.0];
  for (NSDictionary *prim in prims) {
    NSString *kind = prim[@"kind"];
    NSArray *coords = prim[@"coords"];
    if ([kind isEqualToString:@"line"]) {
      for (NSArray *part in [self clipLineCoordsToTerrainBounds:coords]) {   // real clip -> parts
        NSMutableArray<NSValue *> *pts = [NSMutableArray array];
        for (NSArray *c in part) {
          SCNVector3 w;
          if ([self surfaceWorldForLat:[c[1] doubleValue] lon:[c[0] doubleValue]
                                  lift:[self drapeLiftForLayer:ErisDrapeSubmitted] out:&w]) {
            [pts addObject:[NSValue valueWithSCNVector3:w]];
          }
        }
        SCNNode *ln = [self polylineFromPoints:pts color:lineColor closed:NO];
        if (ln) [self.overlaysNode addChildNode:ln];
      }
      continue;
    }
    // Points + polygon outlines: keep in-bounds vertices, drop out-of-bounds (no invention).
    NSMutableArray<NSValue *> *pts = [NSMutableArray array];
    for (NSArray *c in coords) {
      double lon = [c[0] doubleValue], lat = [c[1] doubleValue];
      double col, row;
      if (![self colRowForLat:lat lon:lon outCol:&col outRow:&row]) continue;
      if (![self inBoundsCol:col row:row]) continue;
      [pts addObject:[NSValue valueWithSCNVector3:[self surfaceWorldForCol:col row:row lift:[self drapeLiftForLayer:ErisDrapeSubmitted]]]];
    }
    if ([kind isEqualToString:@"point"]) {
      for (NSValue *v in pts) {
        // Metre-derived, physically bounded dot — never a worldSize-percentage sphere.
        SCNNode *dot = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:[self sceneUnitsForMeters:kErisSubmittedPointRadiusM]]];
        dot.geometry.firstMaterial.diffuse.contents = lineColor;
        dot.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
        dot.position = [v SCNVector3Value];
        [self.overlaysNode addChildNode:dot];
        [self.markerNodes addObject:dot];   // counter-scaled to stay round under exaggeration
      }
    } else if ([kind isEqualToString:@"polygon"]) {
      SCNNode *poly = [self polylineFromPoints:pts color:lineColor closed:YES];
      if (poly) [self.overlaysNode addChildNode:poly];
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

// focusTarget is stored at TRUE scale; the rendered surface is Y-scaled by exagNode,
// so the camera/orbit pivot must use the scaled height.
- (SCNVector3)scaledFocusTarget {
  SCNVector3 t = self.focusTarget;
  return SCNVector3Make(t.x, t.y * (float)self.verticalExaggeration, t.z);
}

// Frame the incident (or terrain centre when the incident is unavailable/out of
// bounds): place the camera south of and above the focus target, oriented to look
// at it, and pin the built-in orbit controller's target to the focus so orbit /
// pan / zoom revolve around the incident (a stable SceneKit look-at target rather
// than only hand-set Euler angles).
- (void)resetToIncident {
  SCNVector3 t = [self scaledFocusTarget];
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
  SCNVector3 t = [self scaledFocusTarget];
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
  // Distinguish hillshade relief from real aerial imagery — never claim imagery
  // when the package only has hillshade.
  NSMutableArray<NSString *> *tags = [NSMutableArray arrayWithObject:src];
  // Truthful: never "Roads" when the package only holds a derived road-bearing line.
  if ([self layerAvailable:@"roads"]) [tags addObject:[self describeRoadContext]];
  if ([self imageryUsable]) [tags addObject:self.imageryTiled ? @"Aerial imagery (HD tiled)" : @"Aerial imagery"];
  else if (self.hillshadeImage) [tags addObject:@"Hillshade relief"];
  self.statusLabel.text = [NSString stringWithFormat:@"  Offline terrain · v%@\n  %@  ",
                           version, [tags componentsJoinedByString:@" · "]];
  self.statusLabel.accessibilityLabel =
      [NSString stringWithFormat:@"Offline terrain version %@, %@", version, [tags componentsJoinedByString:@", "]];
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

#pragma mark - Base surface (terrain / satellite / hybrid) + layer visibility

// Set the base surface (terrain relief / satellite / hybrid). All textures are
// local; imagery is used ONLY when packaged + valid. TILED imagery renders as
// per-tile terrain patches (imageryTilesNode); legacy single-image imagery renders
// as the terrain mesh diffuse. Hybrid blends aerial imagery with hillshade relief.
- (void)applyBaseSurface {
  BOOL wantImagery = (self.baseSurface != 0) && [self imageryUsable];
  // Tiled imagery is a DRAPE OVERLAY, never a replacement. It is used only when every
  // tile patch actually built (buildImageryTilesNode disables tiled + falls back
  // otherwise), so a holey/broken tiled surface is never shown.
  BOOL allPatchesBuilt = self.imageryTiled && self.imageryTilesNode != nil
      && self.imageryTilesNode.childNodes.count == self.imageryTileMetas.count
      && self.imageryTileMetas.count > 0;
  BOOL useTiles = wantImagery && allPatchesBuilt;

  // REGRESSION FIX: the authoritative base terrain mesh is ALWAYS visible. Tiled
  // imagery patches are draped slightly ABOVE it (tiny lift, see buildImageryPatch) —
  // never hidden/replaced. This preserves true-scale relief + vertical exaggeration
  // (the mesh geometry is authoritative) and prevents a broken tiled surface from
  // ever becoming the terrain the user sees.
  self.terrainNode.hidden = NO;
  self.imageryTilesNode.hidden = !useTiles;

  SCNMaterial *mat = self.terrainNode.geometry.firstMaterial;
  if (mat == nil) return;
  mat.multiply.contents = nil;
  mat.multiply.intensity = 1.0;
  UIImage *diffuse = nil;
  if (useTiles) {                                                    // tiled Satellite/Hybrid (drape)
    // Base mesh shows hillshade relief UNDER the imagery drape (seen only at grazing
    // angles / behind any gap); the tile patches carry the aerial imagery on top.
    diffuse = self.hillshadeImage;
    [self applyTiledImageryHybrid:(self.baseSurface == 2)];
  } else if (self.baseSurface == 1 && self.imageryImage != nil) {    // satellite (legacy single image)
    diffuse = self.imageryImage;
  } else if (self.baseSurface == 2 && self.imageryImage != nil) {    // hybrid: imagery x hillshade
    diffuse = self.imageryImage;
    if (self.hillshadeImage != nil) {
      mat.multiply.contents = self.hillshadeImage;
      mat.multiply.intensity = MAX(0.0, MIN(1.0, self.reliefIntensity));
    }
  } else {                                                           // terrain relief (default)
    diffuse = self.hillshadeImage;
  }
  mat.diffuse.contents = diffuse != nil ? (id)diffuse : (id)[UIColor colorWithRed:0.45 green:0.42 blue:0.36 alpha:1.0];
  // Always clamp (both directions) on every (re)assignment — the aerial/hillshade
  // texture maps 1:1 onto the mesh UVs; never tile/repeat.
  mat.diffuse.wrapS = SCNWrapModeClamp;
  mat.diffuse.wrapT = SCNWrapModeClamp;
  mat.multiply.wrapS = SCNWrapModeClamp;
  mat.multiply.wrapT = SCNWrapModeClamp;
}

// Toggle the per-tile hillshade multiply for tiled imagery: Hybrid blends the
// (per-tile sliced) hillshade at reliefIntensity; Satellite shows imagery alone.
- (void)applyTiledImageryHybrid:(BOOL)hybrid {
  float intensity = hybrid ? (float)MAX(0.0, MIN(1.0, self.reliefIntensity)) : 0.0f;
  for (SCNNode *patch in self.imageryTilesNode.childNodes) {
    SCNMaterial *mat = patch.geometry.firstMaterial;
    if (mat.multiply.contents != nil) mat.multiply.intensity = intensity;
  }
}

- (void)applyLayerVisibility {
  self.roadsNode.hidden = !self.showRoads;
  self.overlaysNode.hidden = !self.showOverlays;
  self.boundaryNode.hidden = !self.showBoundary;
  self.overviewView.hidden = !self.showOverview;
}

#pragma mark - Packaged roads / boundary / overview inset

// A draped road RIBBON: the in-bounds centreline widened to `widthMeters`
// (perpendicular, in the ground plane, metre-derived) and sampled onto the terrain
// surface, so road CLASS reads by WIDTH + OPACITY, not colour alone (Part 4). The
// width offset is computed per vertex from the local tangent. Returns nil if fewer
// than two usable vertices survive.
- (SCNNode *)roadRibbonNodeFromCoords:(NSArray *)coords widthMeters:(double)widthM lift:(float)lift
                                color:(UIColor *)color opacity:(CGFloat)opacity {
  NSUInteger n = coords.count;
  if (n < 2) return nil;
  double halfW = MAX(0.1, widthM / 2.0);
  NSMutableArray<NSValue *> *left = [NSMutableArray array], *right = [NSMutableArray array];
  for (NSUInteger i = 0; i < n; i++) {
    NSArray *c = coords[i];
    double lon = [c[0] doubleValue], lat = [c[1] doubleValue];
    NSArray *cp = coords[i == 0 ? 0 : i - 1], *cn = coords[i + 1 < n ? i + 1 : n - 1];
    double cosLat = cos(lat * M_PI / 180.0); if (fabs(cosLat) < 1e-9) cosLat = 1e-9;
    double dE = ([cn[0] doubleValue] - [cp[0] doubleValue]) * kXsMPerDegLat * cosLat;
    double dN = ([cn[1] doubleValue] - [cp[1] doubleValue]) * kXsMPerDegLat;
    double len = hypot(dE, dN); if (len < 1e-9) { dE = 1; dN = 0; len = 1; }
    // Right normal = tangent rotated -90deg: (dN, -dE)/len (in E/N metres).
    double pE = dN / len, pN = -dE / len;
    double dLat = (pN * halfW) / kXsMPerDegLat, dLon = (pE * halfW) / (kXsMPerDegLat * cosLat);
    SCNVector3 wR, wL;
    if (![self surfaceWorldForLat:lat + dLat lon:lon + dLon lift:lift out:&wR]) continue;
    if (![self surfaceWorldForLat:lat - dLat lon:lon - dLon lift:lift out:&wL]) continue;
    [right addObject:[NSValue valueWithSCNVector3:wR]];
    [left addObject:[NSValue valueWithSCNVector3:wL]];
  }
  NSUInteger m = left.count;
  if (m < 2) return nil;
  NSUInteger vcount = m * 2;
  SCNVector3 *verts = malloc(sizeof(SCNVector3) * vcount);
  for (NSUInteger i = 0; i < m; i++) { verts[i * 2] = [left[i] SCNVector3Value]; verts[i * 2 + 1] = [right[i] SCNVector3Value]; }
  NSUInteger icount = (m - 1) * 6;
  int *idx = malloc(sizeof(int) * icount);
  NSUInteger k = 0;
  for (NSUInteger i = 0; i + 1 < m; i++) {
    int l0 = (int)(i * 2), r0 = l0 + 1, l1 = (int)((i + 1) * 2), r1 = l1 + 1;
    idx[k++] = l0; idx[k++] = r0; idx[k++] = l1;
    idx[k++] = l1; idx[k++] = r0; idx[k++] = r1;
  }
  SCNGeometrySource *src = [SCNGeometrySource geometrySourceWithVertices:verts count:vcount];
  SCNGeometryElement *el = [SCNGeometryElement geometryElementWithData:[NSData dataWithBytes:idx length:sizeof(int) * icount]
                                                        primitiveType:SCNGeometryPrimitiveTypeTriangles
                                                       primitiveCount:icount / 3 bytesPerIndex:sizeof(int)];
  SCNGeometry *geo = [SCNGeometry geometryWithSources:@[src] elements:@[el]];
  SCNMaterial *mat = [SCNMaterial material];
  mat.diffuse.contents = color;
  mat.lightingModelName = SCNLightingModelConstant;   // reads at any light / grazing angle
  mat.doubleSided = YES;
  mat.transparency = opacity;
  geo.firstMaterial = mat;
  free(verts); free(idx);
  return [SCNNode nodeWithGeometry:geo];
}

// Container node for one road class (created lazily under roadsNode so the Road
// Display filter can show/hide/dim whole classes independently).
- (SCNNode *)roadContainerForClass:(NSString *)rc {
  if (self.roadClassNodes == nil) self.roadClassNodes = [NSMutableDictionary dictionary];
  SCNNode *node = self.roadClassNodes[rc];
  if (node == nil) { node = [SCNNode node]; self.roadClassNodes[rc] = node; [self.roadsNode addChildNode:node]; }
  return node;
}

// Drape packaged roads.geojson onto the mesh as CLASS-AWARE ribbons (Part 4). Each
// feature is styled by its ERIS road_class (width/opacity/colour, highways drawn on
// top); a legacy feature with no road_class renders as the neutral "unclassified"
// legacy style. Each line is TRULY CLIPPED to the terrain-grid bounds (Liang-Barsky) into
// separate parts — a segment crossing the grid with both endpoints outside is retained;
// disconnected parts are never joined. A class is recorded as packaged ONLY when a clipped
// part actually renders (never from the manifest alone). Defensive: a corrupt/absent file
// yields no roads.
- (void)buildRoadsLayer {
  if (![self layerAvailable:@"roads"]) return;
  NSData *data = [NSData dataWithContentsOfFile:[self.extractedDir stringByAppendingPathComponent:@"roads.geojson"]];
  id gj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![gj isKindOfClass:[NSDictionary class]]) return;
  self.roadClassNodes = [NSMutableDictionary dictionary];
  NSMutableSet<NSString *> *packaged = [NSMutableSet set];
  for (id feat in erisAsArray(((NSDictionary *)gj)[@"features"])) {
    if (![feat isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *props = [((NSDictionary *)feat)[@"properties"] isKindOfClass:[NSDictionary class]] ? ((NSDictionary *)feat)[@"properties"] : @{};
    NSString *rc = XsStr(props, @"road_class", @"");
    if (rc.length == 0) rc = @"unclassified";        // legacy: no ERIS road_class -> unclassified
    ErisRoadStyle st = ErisRoadStyleForClass(rc);
    UIColor *color = [UIColor colorWithRed:st.r green:st.g blue:st.b alpha:1.0];
    float lift = [self sceneUnitsForMeters:st.liftM];
    for (NSDictionary *prim in [self primitivesFromGeometry:((NSDictionary *)feat)[@"geometry"]]) {
      if (![prim[@"kind"] isEqualToString:@"line"]) continue;
      // REAL clip to the terrain bounds -> separate parts, each rendered as its own ribbon.
      for (NSArray *part in [self clipLineCoordsToTerrainBounds:prim[@"coords"]]) {
        SCNNode *ribbon = [self roadRibbonNodeFromCoords:part widthMeters:st.widthM lift:lift color:color opacity:st.opacity];
        if (ribbon == nil) continue;
        ribbon.renderingOrder = st.order;                  // higher class drawn on top
        [[self roadContainerForClass:rc] addChildNode:ribbon];
        [packaged addObject:rc];                           // class rendered from an actual clipped part
      }
    }
  }
  self.packagedRoadClasses = packaged;
  self.primaryRoadsPackaged = [packaged containsObject:@"primary"];
  self.secondaryRoadsPackaged = [packaged containsObject:@"secondary"];
  // Default Road Display: Highways when primary roads are packaged, else All roads
  // (so legacy/unclassified packages still show their roads with a clear label).
  self.roadDisplayMode = self.primaryRoadsPackaged ? ErisRoadDisplayHighways : ErisRoadDisplayAll;
  self.selectionMode = self.roadDisplayMode;
  [self applyRoadDisplayFilter];
}

// Whether a road class is visible under the current Road Display mode.
- (BOOL)roadClassVisibleForDisplay:(NSString *)rc {
  NSInteger prio = ErisRoadClassPriority(rc);
  switch (self.roadDisplayMode) {
    case ErisRoadDisplayHighways:          return prio >= 3;                    // primary only
    case ErisRoadDisplayHighwaysSecondary: return prio >= 2;                    // primary + secondary
    case ErisRoadDisplayAll:               return YES;                          // all incl. local/unclassified
  }
  return YES;
}

// Whether a class is SELECTABLE for the Cross Section (Highway vs All Roads).
- (BOOL)roadClassSelectable:(NSString *)rc {
  NSInteger prio = ErisRoadClassPriority(rc);
  switch (self.selectionMode) {
    case ErisRoadDisplayHighways:          return prio >= 3;
    case ErisRoadDisplayHighwaysSecondary: return prio >= 2;
    case ErisRoadDisplayAll:               return YES;
  }
  return YES;
}

// Show/hide road-class containers per the Road Display mode. In Cross Section mode,
// non-selectable classes are DIMMED (not hidden) so the user still sees context but
// selectable roads are emphasised (Part 4).
- (void)applyRoadDisplayFilter {
  for (NSString *rc in self.roadClassNodes) {
    SCNNode *node = self.roadClassNodes[rc];
    BOOL visible = [self roadClassVisibleForDisplay:rc];
    node.hidden = !visible;
    CGFloat op = 1.0;
    if (visible && self.crossSectionMode && ![self roadClassSelectable:rc]) op = 0.35;  // dim non-selectable
    node.opacity = op;
  }
}

// Package boundary = the terrain grid's four corners, draped + closed.
- (void)buildBoundaryLayer {
  double corners[4][2] = {
    {0, 0}, {(double)(self.cols - 1), 0}, {(double)(self.cols - 1), (double)(self.rows - 1)}, {0, (double)(self.rows - 1)}};
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];
  for (int i = 0; i < 4; i++) {
    [pts addObject:[NSValue valueWithSCNVector3:[self surfaceWorldForCol:corners[i][0] row:corners[i][1] lift:[self drapeLiftForLayer:ErisDrapeBoundary]]]];
  }
  SCNNode *ring = [self polylineFromPoints:pts color:[UIColor colorWithRed:0.55 green:0.75 blue:0.95 alpha:0.9] closed:YES];
  if (ring) [self.boundaryNode addChildNode:ring];
}

// North-up 2D overview inset (lower-right). Server-rendered overview.png with a
// centre indicator. Fully offline; readable on dark backgrounds; "Overview" label.
- (void)buildOverviewInset {
  if (![self layerAvailable:@"overview"]) return;
  NSString *path = [self.extractedDir stringByAppendingPathComponent:@"overview.png"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return;
  UIImage *img = [UIImage imageWithContentsOfFile:path];
  if (img == nil) return;
  UIImageView *iv = [[UIImageView alloc] initWithImage:img];
  iv.translatesAutoresizingMaskIntoConstraints = NO;
  iv.contentMode = UIViewContentModeScaleAspectFit;
  iv.backgroundColor = [UIColor colorWithWhite:0 alpha:0.6];
  iv.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.5].CGColor;
  iv.layer.borderWidth = 1.0; iv.layer.cornerRadius = 6.0; iv.clipsToBounds = YES;
  iv.isAccessibilityElement = YES; iv.accessibilityLabel = @"Overview";
  [self.view addSubview:iv];
  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [iv.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-10],
    [iv.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor constant:-10],
    [iv.widthAnchor constraintEqualToConstant:124],
    [iv.heightAnchor constraintEqualToConstant:124],
  ]];
  self.overviewView = iv;
}

#pragma mark - Layers + Package Details

- (void)onLayers {
  ErisLayersSheetVC *sheet = [[ErisLayersSheetVC alloc] init];
  sheet.baseSurface = self.baseSurface;
  sheet.imageryAvailable = [self imageryUsable];
  sheet.roadsAvailable = [self layerAvailable:@"roads"];
  sheet.overviewAvailable = (self.overviewView != nil);
  sheet.showRoads = self.showRoads;
  sheet.showOverlays = self.showOverlays;
  sheet.showBoundary = self.showBoundary;
  sheet.showOverview = self.showOverview;
  sheet.reliefIntensity = self.reliefIntensity;
  sheet.verticalExaggeration = self.verticalExaggeration;
  sheet.roadDisplayMode = self.roadDisplayMode;
  sheet.primaryRoadsAvailable = self.primaryRoadsPackaged;
  sheet.secondaryRoadsAvailable = self.secondaryRoadsPackaged;
  __weak typeof(self) weakSelf = self;
  sheet.onChange = ^(ErisLayersSheetVC *s) {
    typeof(self) me = weakSelf;
    if (me == nil) return;
    me.baseSurface = s.baseSurface;
    me.showRoads = s.showRoads;
    me.showOverlays = s.showOverlays;
    me.showBoundary = s.showBoundary;
    me.showOverview = s.showOverview;
    me.reliefIntensity = s.reliefIntensity;
    me.verticalExaggeration = s.verticalExaggeration;
    me.roadDisplayMode = s.roadDisplayMode;
    me.selectionMode = s.roadDisplayMode;   // keep Cross Section selection aligned with display
    [me applyBaseSurface];         // hillshade intensity (hybrid multiply) may have changed
    [me applyLayerVisibility];
    [me applyRoadDisplayFilter];   // class visibility/dimming per Road Display mode
    [me applyVerticalExaggeration]; // display-only Y-scale; never touches gridData/files
  };
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:sheet];
  nav.modalPresentationStyle = UIModalPresentationFormSheet;
  [self presentViewController:nav animated:YES completion:nil];
}

- (void)dismissPresented { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)onShowDetails {
  UIViewController *vc = [[UIViewController alloc] init];
  vc.title = @"Package Details";
  vc.view.backgroundColor = [UIColor systemBackgroundColor];
  vc.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(dismissPresented)];
  UITextView *tv = [[UITextView alloc] initWithFrame:CGRectZero];
  tv.translatesAutoresizingMaskIntoConstraints = NO;
  tv.editable = NO;
  tv.font = [UIFont systemFontOfSize:14];
  tv.backgroundColor = [UIColor clearColor];
  tv.text = [self packageDetailsText];
  [vc.view addSubview:tv];
  UILayoutGuide *guide = vc.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [tv.topAnchor constraintEqualToAnchor:guide.topAnchor constant:12],
    [tv.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor constant:16],
    [tv.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor constant:-16],
    [tv.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor constant:-12],
  ]];
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  nav.modalPresentationStyle = UIModalPresentationFormSheet;
  [self presentViewController:nav animated:YES completion:nil];
}

// Truthful road-context description (mirrors describeRoadContext in offlineScene.ts).
// Never claims "roads"/"routes"/"street network" for a bearing-only package.
- (NSString *)describeRoadContext {
  NSDictionary *roads = [self.contextLayers[@"roads"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"roads"] : nil;
  if (roads == nil || ![roads[@"available"] boolValue]) return @"No road context packaged";
  NSArray *kinds = [roads[@"road_kinds"] isKindOfClass:[NSArray class]] ? roads[@"road_kinds"] : @[];
  if ([kinds containsObject:@"road_centerline"]) return @"Feature service road network";
  if ([kinds containsObject:@"road_inventory"]) return @"Road inventory geometry";
  if ([kinds containsObject:@"road_bearing"]) return @"Road bearing context";
  return @"Road context packaged";
}

- (NSString *)layerSourceLabel:(NSString *)name {
  NSDictionary *layer = [self.contextLayers[name] isKindOfClass:[NSDictionary class]] ? self.contextLayers[name] : nil;
  NSDictionary *src = [layer[@"source"] isKindOfClass:[NSDictionary class]] ? layer[@"source"] : nil;
  id a = src[@"attribution"] ?: (src[@"dataset"] ?: src[@"provider"]);
  return [a isKindOfClass:[NSString class]] ? a : nil;
}

- (NSString *)packageDetailsText {
  NSDictionary *p = [self params];
  NSDictionary *elev = [self.manifest[@"elevation"] isKindOfClass:[NSDictionary class]] ? self.manifest[@"elevation"] : @{};
  NSDictionary *area = [self.manifest[@"area"] isKindOfClass:[NSDictionary class]] ? self.manifest[@"area"] : @{};
  NSMutableString *s = [NSMutableString string];
  // Data vs display distinction (truthful): the packaged grid is the validated
  // source-derived elevation dataset in metres; exaggeration is display-only.
  [s appendString:@"Elevation data: USGS 3DEP source-derived elevation grid, stored in metres\n"];
  [s appendFormat:@"Display vertical exaggeration: %@\n", ErisExagLabel(self.verticalExaggeration)];
  [s appendString:@"Display settings do not modify the packaged elevation data\n\n"];
  [s appendFormat:@"Elevation source: %@ · %@\n", elev[@"source"] ?: @"USGS_3DEP", elev[@"dataset"] ?: @"USGS 3DEP"];
  if ([self imageryUsable]) {
    NSDictionary *img = [self.contextLayers[@"imagery"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"imagery"] : @{};
    // Report the ACTUAL source (never claim ArcGIS-map equivalence), the packaging
    // mode (tiled vs legacy single-image), tile count, effective resolution, and the
    // local storage size — and state that imagery is packaged locally (no network).
    [s appendFormat:@"Aerial imagery source: %@\n", [self layerSourceLabel:@"imagery"] ?: @"packaged imagery"];
    if (self.imageryTiled) {
      [s appendFormat:@"Imagery mode: tiled (%lu tiles)\n", (unsigned long)self.imageryTileMetas.count];
      id eff = img[@"effective_meters_per_pixel"];
      if ([eff respondsToSelector:@selector(doubleValue)] && [eff doubleValue] > 0) {
        [s appendFormat:@"Effective imagery resolution: %.2f m/pixel\n", [eff doubleValue]];
      }
      double mb = [img[@"bytes"] respondsToSelector:@selector(doubleValue)] ? [img[@"bytes"] doubleValue] / (1024.0 * 1024.0) : 0;
      if (mb > 0) [s appendFormat:@"Imagery storage: %.1f MB (packaged locally)\n", mb];
    } else {
      [s appendString:@"Imagery mode: single-image (legacy)\n"];
    }
    [s appendString:@"Aerial imagery is packaged in the offline area — no network is used in this viewer.\n"];
  } else {
    [s appendString:self.hillshadeImage ? @"Surface texture: USGS 3DEP hillshade relief (no aerial imagery)\n"
                                        : @"Surface texture: none (elevation mesh only)\n"];
  }
  // Imagery render diagnostics (regression triage): tiled imagery is a DRAPE OVERLAY —
  // the base terrain mesh is never hidden/replaced.
  if (self.imageryTiled) {
    [s appendFormat:@"Imagery render: %@\n", self.imageryTilesStatus ?: @"tiled overlay"];
    [s appendFormat:@"Imagery patches built: %ld of %lu tiles\n", (long)self.imageryPatchCount, (unsigned long)self.imageryTileMetas.count];
    [s appendString:@"Base terrain mesh hidden: no (imagery drapes above it)\n"];
  } else if (self.imageryTilesStatus.length > 0) {
    [s appendFormat:@"Imagery render: %@\n", self.imageryTilesStatus];   // e.g. tiled disabled -> fell back
  }
  // Truthful road context + packaged feature count (never overstates "roads").
  if ([self layerAvailable:@"roads"]) {
    NSDictionary *roads = [self.contextLayers[@"roads"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"roads"] : @{};
    NSInteger count = [roads[@"feature_count"] respondsToSelector:@selector(integerValue)] ? [roads[@"feature_count"] integerValue] : 0;
    NSString *srcLabel = [self layerSourceLabel:@"roads"];
    [s appendFormat:@"Road context: %@ (%ld feature%@)%@\n", [self describeRoadContext], (long)count,
                    count == 1 ? @"" : @"s", srcLabel ? [@" · " stringByAppendingString:srcLabel] : @""];
  } else {
    [s appendFormat:@"Road context: unavailable (%@)\n", [self roadsUnavailableReason] ?: @"no_road_context"];
  }
  // Cross Section usability (TRUTHFUL — never implies the tool works when it cannot).
  {
    NSDictionary *rxsLayer = [self.contextLayers[@"road_cross_section"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"road_cross_section"] : @{};
    NSDictionary *roads = [self.contextLayers[@"roads"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"roads"] : @{};
    NSArray *kinds = [roads[@"road_kinds"] isKindOfClass:[NSArray class]] ? roads[@"road_kinds"] : @[];
    NSString *layoutSrc = [self crossSectionLayoutSource];
    NSString *layoutLabel = [rxsLayer[@"layout_source_label"] isKindOfClass:[NSString class]] ? rxsLayer[@"layout_source_label"]
        : ([layoutSrc isEqualToString:@"ROAD_INVENTORY"] ? @"ERIS Road Inventory"
           : ([layoutSrc isEqualToString:@"FORM_FIELDS"] ? @"Submission/form fields" : @"Default roadway assumptions"));
    [s appendFormat:@"Cross-section layout: %@ (%@)\n", [self crossSectionContextAvailable] ? @"packaged" : @"default assumptions", layoutLabel];
    [s appendFormat:@"Snap geometry: %@%@\n", [self crossSectionSnapAvailable] ? @"available" : @"unavailable",
        (self.roadSnapFeatures.count && kinds.count) ? [NSString stringWithFormat:@" (%lu feature%@ · %@)",
            (unsigned long)self.roadSnapFeatures.count, self.roadSnapFeatures.count == 1 ? @"" : @"s", [kinds componentsJoinedByString:@", "]] : @""];
    [s appendFormat:@"Upstation bearing: %@\n", [self crossSectionOrientationAvailable] ? @"available" : @"unavailable"];
    [s appendFormat:@"Cross Section usable: %@\n", [self crossSectionFullyUsable] ? @"yes" : @"no"];
  }
  [s appendFormat:@"Package version: %@\n", [p[@"packageVersion"] isKindOfClass:[NSString class]] ? p[@"packageVersion"] : @"—"];
  if ([self.manifest[@"generated_at"] isKindOfClass:[NSString class]]) [s appendFormat:@"Created: %@\n", self.manifest[@"generated_at"]];
  if ([area[@"radius_m"] respondsToSelector:@selector(doubleValue)]) {
    [s appendFormat:@"Area radius: %.0f m\n", [area[@"radius_m"] doubleValue]];
  }
  [s appendString:@"Offline-ready: yes (no network required)\n"];
  // Unavailable optional layers + why.
  NSMutableArray<NSString *> *unavailable = [NSMutableArray array];
  for (NSString *name in @[@"imagery", @"roads", @"overview"]) {
    if (![self layerAvailable:name]) {
      NSDictionary *layer = [self.contextLayers[name] isKindOfClass:[NSDictionary class]] ? self.contextLayers[name] : nil;
      NSString *reason = [layer[@"reason"] isKindOfClass:[NSString class]] ? layer[@"reason"] : @"unavailable";
      [unavailable addObject:[NSString stringWithFormat:@"%@ (%@)", name, reason]];
    }
  }
  if (unavailable.count) [s appendFormat:@"Unavailable layers: %@\n", [unavailable componentsJoinedByString:@", "]];
  // Combined attribution.
  NSMutableArray<NSString *> *attr = [NSMutableArray array];
  for (NSString *name in @[@"imagery", @"roads"]) {
    NSString *a = [self layerSourceLabel:name];
    if (a && ![attr containsObject:a]) [attr addObject:a];
  }
  if (attr.count) [s appendFormat:@"\nAttribution: %@", [attr componentsJoinedByString:@"; "]];
  return s;
}

#pragma mark - Cross Section tool (tap a road -> perpendicular roadway/terrain slice)

// Load the packaged offline road cross-section context + road snap features + the
// upstation bearing hint. All local files — no network.
- (void)loadCrossSectionContext:(NSDictionary *)p {
  id bearing = p[@"roadBearingDeg"];
  self.upstationHintDeg = [bearing respondsToSelector:@selector(doubleValue)] ? [bearing doubleValue] : NAN;
  NSString *path = [self.extractedDir stringByAppendingPathComponent:@"road_cross_section.json"];
  if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
    NSData *d = [NSData dataWithContentsOfFile:path];
    id j = d ? [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] : nil;
    if ([j isKindOfClass:[NSDictionary class]]) self.roadCrossSectionCtx = j;
  }
  double bdeg = XsNum(self.roadCrossSectionCtx, @"upstation_bearing_deg", NAN);
  if (isfinite(bdeg)) self.upstationHintDeg = bdeg;   // packaged upstation direction preferred
  self.roadSnapFeatures = [self parseRoadSnapFeatures];
}

// Build a snap primitive that retains the road-context kind AND the full road
// metadata (Part 3). roadClass is the ERIS-GENERATED road_class; a legacy package
// with no road_class degrades honestly to "unclassified" (never a silent highway).
// Provider NAME/BASENAME/MTFCC/RTTYP/source_layer_id are DISPLAY metadata only and
// never drive classification or selection.
- (NSDictionary *)snapFeatureForProps:(NSDictionary *)props kind:(NSString *)kind coords:(NSArray *)coords {
  NSString *rc = XsStr(props, @"road_class", @"");
  if (rc.length == 0) rc = @"unclassified";
  NSString *rcLabel = XsStr(props, @"road_class_label", @"");
  if (rcLabel.length == 0) rcLabel = ErisRoadClassLabel(rc);
  NSMutableDictionary *f = [@{
    @"kind": kind.length ? kind : @"road",
    @"coords": coords,
    @"roadClass": rc,
    @"roadClassLabel": rcLabel,
  } mutableCopy];
  NSString *name = XsStr(props, @"NAME", @"");         if (name.length) f[@"name"] = name;
  NSString *basename = XsStr(props, @"BASENAME", @""); if (basename.length) f[@"basename"] = basename;
  NSString *mtfcc = XsStr(props, @"MTFCC", @"");       if (mtfcc.length) f[@"mtfcc"] = mtfcc;
  NSString *rttyp = XsStr(props, @"RTTYP", @"");       if (rttyp.length) f[@"rttyp"] = rttyp;
  id sli = props[@"source_layer_id"];
  if ([sli isKindOfClass:[NSNumber class]]) f[@"sourceLayerId"] = sli;
  return f;
}

// roads.geojson -> snap features {kind, coords, roadClass, roadClassLabel, name, ...},
// richest-first (inventory/centerline before the derived bearing line). Uses the SAME
// geometry parser as buildRoadsLayer (primitivesFromGeometry), so every line-like
// geometry the renderer DRAWS is also eligible for snapping — LineString,
// MultiLineString, Polygon rings, and Esri paths/rings — not just bare LineString.
// Every primitive retains the full road metadata so highway-first selection (Part 5)
// and the confirmation card (Part 6) can classify + label it.
- (NSArray<NSDictionary *> *)parseRoadSnapFeatures {
  NSMutableArray *rich = [NSMutableArray array];
  NSMutableArray *bearing = [NSMutableArray array];
  NSData *data = [NSData dataWithContentsOfFile:[self.extractedDir stringByAppendingPathComponent:@"roads.geojson"]];
  id gj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  NSArray *feats = ([gj isKindOfClass:[NSDictionary class]] && [gj[@"features"] isKindOfClass:[NSArray class]]) ? gj[@"features"] : @[];
  for (id f in feats) {
    if (![f isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *geom = [f[@"geometry"] isKindOfClass:[NSDictionary class]] ? f[@"geometry"] : nil;
    NSDictionary *props = [f[@"properties"] isKindOfClass:[NSDictionary class]] ? f[@"properties"] : @{};
    NSString *kind = XsStr(props, @"kind", @"road");
    for (NSDictionary *prim in [self primitivesFromGeometry:geom]) {
      NSString *pk = prim[@"kind"];
      if (![pk isEqualToString:@"line"] && ![pk isEqualToString:@"polygon"]) continue;  // line-like only
      NSArray *coords = prim[@"coords"];
      if (coords.count < 2) continue;
      NSDictionary *feat = [self snapFeatureForProps:props kind:kind coords:coords];
      if ([kind isEqualToString:@"road_bearing"]) [bearing addObject:feat]; else [rich addObject:feat];
    }
  }
  [rich addObjectsFromArray:bearing];   // prefer real geometry; bearing line last
  return rich;
}

// Whether the tap is inside the packaged grid bounds (for the bearing fallback).
- (BOOL)inPackageBoundsLat:(double)lat lon:(double)lon {
  double col, row;
  if (![self colRowForLat:lat lon:lon outCol:&col outRow:&row]) return NO;
  return [self inBoundsCol:col row:row];
}

// Whether any snap feature is real road geometry (not just the derived bearing line).
- (BOOL)hasRichRoadGeometry {
  for (NSDictionary *f in self.roadSnapFeatures) {
    if (![f[@"kind"] isEqualToString:@"road_bearing"]) return YES;
  }
  return NO;
}

- (BOOL)crossSectionContextAvailable {
  NSDictionary *attrs = [self.roadCrossSectionCtx[@"attributes"] isKindOfClass:[NSDictionary class]] ? self.roadCrossSectionCtx[@"attributes"] : nil;
  return attrs != nil && attrs.count > 0;
}
- (NSString *)crossSectionLayoutSource {
  NSDictionary *attrs = [self.roadCrossSectionCtx[@"attributes"] isKindOfClass:[NSDictionary class]] ? self.roadCrossSectionCtx[@"attributes"] : nil;
  return XsStr(attrs, @"source", @"DEFAULT");
}

// The roadway layout for the section: packaged Road Inventory, else a labelled default.
- (NSDictionary *)crossSectionRoad {
  if ([self crossSectionContextAvailable]) return self.roadCrossSectionCtx[@"attributes"];
  return @{@"lt_lane_count": @1, @"rt_lane_count": @1, @"lt_lane_width_ft": @12, @"rt_lane_width_ft": @12,
           @"lt_outside_shoulder_ft": @4, @"rt_outside_shoulder_ft": @4, @"lt_inside_shoulder_ft": @0, @"rt_inside_shoulder_ft": @0,
           @"median_width_ft": @0, @"median_category": @"NONE", @"total_width_ft": @32, @"source": @"DEFAULT"};
}

// Cross Section usability (computed from the actually-loaded package — robust for
// legacy AND new packages). The tool is usable only when the app can snap to real road
// geometry OR orient from an upstation bearing.
- (BOOL)crossSectionSnapAvailable { return self.roadSnapFeatures.count > 0; }
- (BOOL)crossSectionOrientationAvailable { return isfinite(self.upstationHintDeg); }
- (BOOL)crossSectionFullyUsable { return [self crossSectionSnapAvailable] || [self crossSectionOrientationAvailable]; }

// Reason the packaged roads layer is unavailable (precise token or "disabled").
- (NSString *)roadsUnavailableReason {
  NSDictionary *roads = [self.contextLayers[@"roads"] isKindOfClass:[NSDictionary class]] ? self.contextLayers[@"roads"] : nil;
  if (roads != nil && [roads[@"available"] boolValue]) return nil;
  NSString *r = [roads[@"reason"] isKindOfClass:[NSString class]] ? roads[@"reason"] : @"no_road_context";
  return r;
}

- (void)onCrossSection {
  if (self.crossSectionMode) { [self setCrossSectionModeActive:NO]; return; }
  // Distinguish: fully usable -> enter tap mode; otherwise explain HONESTLY without
  // ever telling the user to "enable road context" when it is already enabled.
  if ([self crossSectionFullyUsable]) {
    [self setCrossSectionModeActive:YES];
    return;
  }
  NSString *msg;
  NSString *roadsReason = [self roadsUnavailableReason];
  if ([self crossSectionContextAvailable]) {
    msg = @"Roadway layout is packaged, but no road snap geometry or upstation bearing is available for this area.";
  } else if ([roadsReason isEqualToString:@"disabled"]) {
    msg = @"Road context is not packaged for this area.";
  } else {
    msg = @"Road context is enabled, but no road geometry was found for this package area.";
  }
  [self showCrossSectionMessage:msg];
}

- (void)setCrossSectionModeActive:(BOOL)active {
  self.crossSectionMode = active;
  self.crossSectionItem.title = active ? @"Cancel" : @"Cross Section";
  if (active && self.crossSectionBanner == nil) {
    UILabel *b = [[UILabel alloc] init];
    b.translatesAutoresizingMaskIntoConstraints = NO;
    b.numberOfLines = 0; b.textAlignment = NSTextAlignmentCenter;
    b.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
    b.textColor = [UIColor whiteColor];
    b.backgroundColor = [UIColor colorWithRed:0.13 green:0.33 blue:0.52 alpha:0.92];
    b.text = @"  Tap a road to create a cross section  ";
    b.layer.cornerRadius = 8; b.clipsToBounds = YES;
    [self.view addSubview:b];
    UILayoutGuide *g = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
      [b.centerXAnchor constraintEqualToAnchor:g.centerXAnchor],
      [b.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-16],
      [b.widthAnchor constraintLessThanOrEqualToAnchor:g.widthAnchor multiplier:0.9],
    ]];
    self.crossSectionBanner = b;
  }
  self.crossSectionBanner.hidden = !active;
  // Cancellable selection: clear the pending set + card either way; keep the highlight
  // only when an inspection has already been confirmed (PR #51 review).
  [self dismissCandidateCard];
  self.pendingCandidates = nil;
  self.pendingCandidateIndex = 0;
  if (active) { self.inspectionConfirmed = NO; [self clearSelectedRoadHighlight]; }   // fresh start
  else if (!self.inspectionConfirmed) { [self clearSelectedRoadHighlight]; }
  [self applyRoadDisplayFilter];   // emphasise selectable classes / dim the rest while active
}

- (void)onSceneTap:(UITapGestureRecognizer *)gr {
  if (!self.crossSectionMode) return;
  CGPoint pt = [gr locationInView:self.scnView];
  NSArray<SCNHitTestResult *> *hits = [self.scnView hitTest:pt options:@{SCNHitTestSortResultsKey: @YES}];
  SCNHitTestResult *hit = hits.firstObject;
  if (hit == nil) { [self showCrossSectionMessage:@"Tap on the terrain surface."]; return; }
  SCNVector3 wp = hit.worldCoordinates;
  double selLat = 0, selLon = 0;
  if (![self worldX:wp.x z:wp.z toLat:&selLat lon:&selLon]) { [self showCrossSectionMessage:@"Could not resolve that location."]; return; }
  [self createCrossSectionAtLat:selLat lon:selLon];
}

// world XZ -> lat/lon (inverse of surfaceWorldForCol; X/Z are exaggeration-independent).
- (BOOL)worldX:(double)x z:(double)z toLat:(double *)outLat lon:(double *)outLon {
  if (self.halfWidthUnits <= 0 || self.halfDepthUnits <= 0 || self.cols < 2 || self.rows < 2) return NO;
  double col = (x / (2.0 * self.halfWidthUnits) + 0.5) * (self.cols - 1);
  double row = (z / (2.0 * self.halfDepthUnits) + 0.5) * (self.rows - 1);
  NSDictionary *lt = self.terrainMeta[@"local_transform"];
  double originLon = XsNum(lt, @"origin_lon", 0), originLat = XsNum(lt, @"origin_lat", 0);
  double lonPerCol = XsNum(lt, @"lon_per_col", 0), latPerRow = XsNum(lt, @"lat_per_row", 0);
  if (lonPerCol == 0 || latPerRow == 0) return NO;
  *outLon = originLon + col * lonPerCol;
  *outLat = originLat + row * latPerRow;
  return YES;
}

// Tap handler: gather the HIGHWAY-FIRST bounded candidate set (Part 5) and present the
// confirmation card (Part 6) instead of silently committing to the nearest line. Honest
// fallbacks preserved: bearing fallback, "No road context near tap", "No road context
// packaged for this area", and never snapping to a class the filter excludes.
- (void)createCrossSectionAtLat:(double)selLat lon:(double)selLon {
  NSArray<NSDictionary *> *candidates = [self gatherCandidatesAtLat:selLat lon:selLon];
  if (candidates.count > 0) {
    [self presentCandidateConfirmation:candidates selLat:selLat selLon:selLon];
    return;
  }
  BOOL bearingAvailable = isfinite(self.upstationHintDeg);
  if (bearingAvailable && ![self hasRichRoadGeometry] && [self inPackageBoundsLat:selLat lon:selLon]) {
    // Only a bearing (or no line geometry) is packaged and the tap is inside the
    // package -> clearly-labelled BEARING FALLBACK (still confirmed so its provenance
    // is explicit; orientation is geometry/bearing-derived, never verified upstation).
    [self presentCandidateConfirmation:@[[self bearingFallbackCandidateAtLat:selLat lon:selLon]] selLat:selLat selLon:selLon];
    return;
  }
  // A road IS near the tap but its class is excluded by the current filter -> guide the
  // user; NEVER silently snap to a different class than the selected filter.
  NSString *excluded = [self nearbyExcludedClassAtLat:selLat lon:selLon];
  if (excluded != nil) {
    [self showCrossSectionMessage:[NSString stringWithFormat:
        @"The nearest road here is a %@. Change Road Display in Layers to include it, or tap a highlighted road.",
        [ErisRoadClassLabel(excluded) lowercaseString]]];
    return;
  }
  if ([self hasRichRoadGeometry]) {
    [self showCrossSectionMessage:@"No road context near tap. Try closer to the highlighted road line."];
    return;
  }
  [self showCrossSectionMessage:@"No road context packaged for this area. Regenerate the offline package with road context enabled."];
}

// Equirectangular metres between two lon/lat points (shared by candidate dedup).
- (double)metersBetweenLatA:(double)aLat lonA:(double)aLon latB:(double)bLat lonB:(double)bLon {
  double mLat = (aLat + bLat) / 2.0;
  double dN = (bLat - aLat) * kXsMPerDegLat;
  double dE = (bLon - aLon) * kXsMPerDegLat * cos(mLat * M_PI / 180.0);
  return hypot(dN, dE);
}

// HIGHWAY-FIRST candidate gathering (Part 5). For every eligible road snap feature,
// project the tap and keep it only if within ITS class tolerance. Rank deterministically
// by (1) class priority DESC — so a closer local can never out-rank an eligible highway,
// (2) distance ASC, (3) stable source order — then dedup near-identical lines and cap at
// the best few (kErisMaxCandidates) so complex interchanges surface a bounded choice.
- (NSArray<NSDictionary *> *)gatherCandidatesAtLat:(double)lat lon:(double)lon {
  NSMutableArray *cands = [NSMutableArray array];
  NSInteger order = 0;
  for (NSDictionary *f in self.roadSnapFeatures) {
    NSString *kind = f[@"kind"] ?: @"road";
    NSInteger idx = order++;
    if ([kind isEqualToString:@"road_bearing"]) continue;   // bearing is a fallback, not a class candidate
    NSString *rc = f[@"roadClass"] ?: @"unclassified";
    if (![self roadClassSelectable:rc]) continue;           // never snap to a non-selected class
    double sLat, sLon, tDeg, dist;
    // Project onto the TERRAIN-CLIPPED road, so the snap point is inherently inside the
    // elevation grid: a road entirely outside the grid yields no parts (not selectable,
    // even within tolerance); a crossing road snaps to its in-bounds portion.
    if (![self projectLat:lat lon:lon ontoParts:[self clipLineCoordsToTerrainBounds:f[@"coords"]]
                    outLat:&sLat outLon:&sLon outTangent:&tDeg outDist:&dist]) continue;
    if (dist > ErisSnapMaxMetersForClass(rc)) continue;     // per-class tolerance
    NSMutableDictionary *cand = [@{
      @"snapLat": @(sLat), @"snapLon": @(sLon), @"tangentDeg": @(tDeg), @"distM": @(dist),
      @"roadClass": rc, @"roadClassLabel": f[@"roadClassLabel"] ?: ErisRoadClassLabel(rc),
      @"name": f[@"name"] ?: @"", @"kind": kind, @"coords": f[@"coords"] ?: @[],
      @"priority": @(ErisRoadClassPriority(rc)), @"order": @(idx),
    } mutableCopy];
    // Carry display-only provider metadata to the confirmation UI (never classification).
    for (NSString *mk in @[@"basename", @"mtfcc", @"rttyp", @"sourceLayerId"]) {
      id v = f[mk]; if (v != nil) cand[mk] = v;
    }
    [cands addObject:cand];
  }
  [cands sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    NSInteger pa = [a[@"priority"] integerValue], pb = [b[@"priority"] integerValue];
    if (pa != pb) return pa > pb ? NSOrderedAscending : NSOrderedDescending;   // higher class first
    double da = [a[@"distM"] doubleValue], db = [b[@"distM"] doubleValue];
    if (fabs(da - db) > 1e-6) return da < db ? NSOrderedAscending : NSOrderedDescending;
    NSInteger oa = [a[@"order"] integerValue], ob = [b[@"order"] integerValue];
    return oa < ob ? NSOrderedAscending : (oa > ob ? NSOrderedDescending : NSOrderedSame);  // stable source order
  }];
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *c in cands) {
    BOOL dup = NO;
    for (NSDictionary *k in out) {
      if (![k[@"roadClass"] isEqual:c[@"roadClass"]]) continue;
      if ([self metersBetweenLatA:[k[@"snapLat"] doubleValue] lonA:[k[@"snapLon"] doubleValue]
                             latB:[c[@"snapLat"] doubleValue] lonB:[c[@"snapLon"] doubleValue]] < 8.0) { dup = YES; break; }
    }
    if (!dup) [out addObject:c];
    if ((NSInteger)out.count >= kErisMaxCandidates) break;
  }
  return out;
}

// The class of the nearest road within tolerance that is EXCLUDED by the current filter
// (so we can guide the user rather than silently snap to a different class), or nil.
- (NSString *)nearbyExcludedClassAtLat:(double)lat lon:(double)lon {
  NSString *bestClass = nil; double best = INFINITY;
  for (NSDictionary *f in self.roadSnapFeatures) {
    if ([f[@"kind"] isEqualToString:@"road_bearing"]) continue;
    NSString *rc = f[@"roadClass"] ?: @"unclassified";
    if ([self roadClassSelectable:rc]) continue;   // only classes excluded by the filter
    double sLat, sLon, tDeg, dist;
    if (![self projectLat:lat lon:lon ontoParts:[self clipLineCoordsToTerrainBounds:f[@"coords"]]
                    outLat:&sLat outLon:&sLon outTangent:&tDeg outDist:&dist]) continue;   // must be in-grid
    if (dist > ErisSnapMaxMetersForClass(rc)) continue;
    if (dist < best) { best = dist; bestClass = rc; }
  }
  return bestClass;
}

// Project a tap onto the nearest of several clipped road parts (each is [lon,lat]). The
// snap is guaranteed inside whatever bounds the parts were clipped to. NO if no parts.
- (BOOL)projectLat:(double)lat lon:(double)lon ontoParts:(NSArray *)parts
            outLat:(double *)outLat outLon:(double *)outLon outTangent:(double *)outTan outDist:(double *)outDist {
  BOOL found = NO; double best = INFINITY;
  for (NSArray *part in parts) {
    double sLat, sLon, tDeg, dist;
    if ([self projectLat:lat lon:lon ontoCoords:part outLat:&sLat outLon:&sLon outTangent:&tDeg outDist:&dist]) {
      if (dist < best) { best = dist; *outLat = sLat; *outLon = sLon; *outTan = tDeg; *outDist = dist; found = YES; }
    }
  }
  return found;
}

- (NSDictionary *)bearingFallbackCandidateAtLat:(double)lat lon:(double)lon {
  return @{
    @"snapLat": @(lat), @"snapLon": @(lon), @"tangentDeg": @(self.upstationHintDeg), @"distM": @(0.0),
    @"roadClass": @"unclassified", @"roadClassLabel": @"Bearing direction (no road geometry)",
    @"name": @"", @"kind": @"bearing_fallback", @"coords": @[], @"bearingFallback": @YES,
  };
}

// Build the immutable slice model for a CONFIRMED candidate, highlight it, run the
// map->inspection camera flight (Part 7), then present the Immersive/Technical
// inspection controller (Part 9). Both modes share this one slice model.
- (void)inspectCandidate:(NSDictionary *)cand selLat:(double)selLat selLon:(double)selLon {
  double snapLat = [cand[@"snapLat"] doubleValue], snapLon = [cand[@"snapLon"] doubleValue];
  // A cross section requires an elevation-grid station. Refuse (before building any
  // samples, camera target, slice or corridor) if the snapped point is outside the grid —
  // road geometry is packaged with a context buffer that can extend beyond the terrain.
  if (![self inPackageBoundsLat:snapLat lon:snapLon]) {
    [self clearSelectedRoadHighlight];
    [self showCrossSectionMessage:@"The selected road is outside the downloaded terrain area. Choose a road inside the offline terrain boundary."];
    return;
  }
  BOOL bearingFallback = [cand[@"bearingFallback"] boolValue];
  BOOL snapped = !bearingFallback;
  double upstationDeg = bearingFallback ? self.upstationHintDeg
                                        : XsResolveUpstation([cand[@"tangentDeg"] doubleValue], self.upstationHintDeg);
  double crossBearing = XsCrossBearing(upstationDeg);

  NSMutableDictionary *slice = [[self buildSliceSelectedLat:selLat selLon:selLon snapLat:snapLat snapLon:snapLon
                                              upstationDeg:upstationDeg snapped:snapped roadContextKind:cand[@"kind"]] mutableCopy];
  // Carry the selected-candidate metadata + honest orientation/layout flags (Part 10).
  slice[@"selectedRoadName"] = cand[@"name"] ?: @"";
  slice[@"selectedRoadClass"] = cand[@"roadClass"] ?: @"unclassified";
  slice[@"selectedRoadClassLabel"] = cand[@"roadClassLabel"] ?: @"Unclassified road";
  slice[@"snapDistanceM"] = cand[@"distM"] ?: @(0);
  slice[@"orientationAuthoritative"] = @(isfinite(self.upstationHintDeg));
  slice[@"selectedRoadCoords"] = cand[@"coords"] ?: @[];   // for the corridor road overlay

  NSDictionary *corridor = [self buildCorridorModelAtLat:snapLat lon:snapLon upstationDeg:upstationDeg
                                            crossBearing:crossBearing slice:slice];

  self.inspectionConfirmed = YES;   // keep the highlight through the transition + inspection
  [self drawSliceLineAtLat:snapLat lon:snapLon crossBearing:crossBearing road:[self crossSectionRoad]];
  [self setCrossSectionModeActive:NO];
  __weak typeof(self) weakSelf = self;
  [self animateMapToInspectionAtLat:snapLat lon:snapLon upstationDeg:upstationDeg completion:^{
    typeof(self) me = weakSelf; if (me == nil) return;
    me.didPresentInspection = YES;   // only now will the return restore the prior camera
    ErisInspectionViewController *vc = [[ErisInspectionViewController alloc] initWithSlice:slice corridor:corridor];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationFullScreen;
    nav.modalTransitionStyle = UIModalTransitionStyleCrossDissolve;   // coordinated with the camera flight
    [me presentViewController:nav animated:YES completion:nil];
  }];
}

- (BOOL)layoutRequiresAcknowledgment {
  return [[self crossSectionLayoutSource] isEqualToString:@"DEFAULT"];   // mirror requiresLayoutAcknowledgment (roadClass.ts)
}

// BLOCKING DEFAULT-layout gate (Part 10, PR #51 review). The inspection controller is NOT
// constructed or presented until "Acknowledge and inspect". Shows the exact default
// lane/shoulder/median values; a primary highway states the 1-lane-each-way, 32 ft layout
// is not observed highway geometry.
- (void)presentDefaultLayoutGateForCandidate:(NSDictionary *)c selLat:(double)selLat selLon:(double)selLon {
  NSDictionary *road = [self crossSectionRoad];
  NSMutableString *m = [NSMutableString stringWithString:@"This section uses DEFAULT roadway assumptions, not measured geometry:\n\n"];
  [m appendFormat:@"• Lanes: %g each direction @ %g ft\n", XsNum(road, @"lt_lane_count", 1), XsNum(road, @"lt_lane_width_ft", 12)];
  [m appendFormat:@"• Outside shoulders: %g ft\n", XsNum(road, @"lt_outside_shoulder_ft", 4)];
  [m appendFormat:@"• Median: %g ft (%@)\n", XsNum(road, @"median_width_ft", 0), XsStr(road, @"median_category", @"NONE")];
  [m appendFormat:@"• Total width: %g ft\n", XsNum(road, @"total_width_ft", 32)];
  if ([c[@"roadClass"] isEqualToString:@"primary"]) {
    [m appendString:@"\nThis is a highway, but the 1-lane-each-direction, 32-foot layout is NOT observed highway geometry. Verify lane, shoulder, and median dimensions."];
  } else {
    [m appendString:@"\nVerify lane, shoulder, and median dimensions before relying on this section."];
  }
  UIAlertController *a = [UIAlertController alertControllerWithTitle:@"Default roadway assumptions" message:m preferredStyle:UIAlertControllerStyleAlert];
  __weak typeof(self) weakSelf = self;
  [a addAction:[UIAlertAction actionWithTitle:@"Back" style:UIAlertActionStyleCancel handler:^(UIAlertAction *x) {
    [weakSelf clearSelectedRoadHighlight];   // returned WITHOUT constructing the inspection
  }]];
  [a addAction:[UIAlertAction actionWithTitle:@"Acknowledge and inspect" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) {
    typeof(self) me = weakSelf; if (me == nil) return;
    [me inspectCandidate:c selLat:selLat selLon:selLon];   // only now is the inspection built
  }]];
  [self presentViewController:a animated:YES completion:nil];
}

#pragma mark - Candidate confirmation card (Part 6)

- (NSDictionary *)currentPendingCandidate {
  if (self.pendingCandidateIndex < 0 || self.pendingCandidateIndex >= (NSInteger)self.pendingCandidates.count) return nil;
  return self.pendingCandidates[self.pendingCandidateIndex];
}

// Present the compact bottom confirmation card and highlight the current candidate on
// the 3D terrain BEFORE Inspect is pressed. For an unnamed divided highway with several
// nearby carriageway/ramp candidates, "Choose another road" cycles the bounded set so
// the selection is visible rather than pretended unambiguous.
- (void)presentCandidateConfirmation:(NSArray<NSDictionary *> *)candidates selLat:(double)selLat selLon:(double)selLon {
  self.pendingCandidates = candidates;
  self.pendingCandidateIndex = 0;
  self.pendingSelLat = selLat; self.pendingSelLon = selLon;
  [self showCandidateCard];
  [self highlightCandidate:[self currentPendingCandidate]];
}

- (UILabel *)cardLabel:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight color:(UIColor *)color {
  UILabel *l = [[UILabel alloc] init];
  l.text = text; l.font = [UIFont systemFontOfSize:size weight:weight]; l.textColor = color;
  l.numberOfLines = 0;
  return l;
}

- (UIButton *)cardButton:(NSString *)title filled:(BOOL)filled action:(SEL)action {
  UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
  [b setTitle:title forState:UIControlStateNormal];
  b.titleLabel.font = [UIFont systemFontOfSize:15 weight:UIFontWeightSemibold];
  b.titleLabel.adjustsFontSizeToFitWidth = YES;
  b.contentEdgeInsets = UIEdgeInsetsMake(10, 12, 10, 12);
  b.layer.cornerRadius = 10;
  if (filled) { b.backgroundColor = [UIColor colorWithRed:0.16 green:0.5 blue:0.95 alpha:1]; [b setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal]; }
  else { b.backgroundColor = [UIColor colorWithWhite:1 alpha:0.12]; [b setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal]; }
  [b addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
  return b;
}

- (UIColor *)cardClassColor:(NSString *)rc {
  ErisRoadStyle st = ErisRoadStyleForClass(rc);
  return [UIColor colorWithRed:st.r green:st.g blue:st.b alpha:1.0];
}

- (NSString *)candidateTitle:(NSDictionary *)c {
  NSString *name = c[@"name"];
  if ([name isKindOfClass:[NSString class]] && name.length) return name;
  return c[@"roadClassLabel"] ?: @"Unclassified road";   // fall back to the class label
}

// Rounded snap distance: whole metres up close, nearest 5 m further out.
- (NSString *)roundedDistanceText:(double)d {
  if (d < 1.0) return @"< 1";
  if (d < 20.0) return [NSString stringWithFormat:@"%.0f", round(d)];
  return [NSString stringWithFormat:@"%.0f", round(d / 5.0) * 5.0];
}

// Honest detail lines: snap distance, whether direction is authoritative or
// geometry-derived, and whether roadway dimensions are ERIS data / form data / defaults.
- (NSString *)candidateDetailText:(NSDictionary *)c {
  NSMutableArray *lines = [NSMutableArray array];
  if ([c[@"bearingFallback"] boolValue]) {
    [lines addObject:@"No road geometry here — oriented from the packaged bearing only."];
  } else {
    [lines addObject:[NSString stringWithFormat:@"Snap distance: %@ m from your tap", [self roundedDistanceText:[c[@"distM"] doubleValue]]]];
  }
  [lines addObject:isfinite(self.upstationHintDeg)
      ? @"Direction: from the packaged upstation bearing."
      : @"Direction: from centerline geometry — upstation is NOT verified."];
  NSString *src = [self crossSectionLayoutSource];
  [lines addObject:[src isEqualToString:@"ROAD_INVENTORY"] ? @"Roadway dimensions: ERIS Road Inventory data."
      : ([src isEqualToString:@"FORM_FIELDS"] ? @"Roadway dimensions: submission / form fields."
         : @"Roadway dimensions: DEFAULT assumptions — verify lane, shoulder, and median.")];
  // Part 10: never silently present the DEFAULT one-lane-each-way 32 ft template as real
  // highway geometry.
  if ([c[@"roadClass"] isEqualToString:@"primary"] && [src isEqualToString:@"DEFAULT"]) {
    [lines addObject:@"⚠ Highway shown with DEFAULT one-lane-each-way (32 ft) geometry — not real highway dimensions."];
  }
  return [lines componentsJoinedByString:@"\n"];
}

- (void)showCandidateCard {
  [self.candidateCardView removeFromSuperview];
  NSDictionary *c = [self currentPendingCandidate];
  if (c == nil) return;

  UIView *card = [[UIView alloc] init];
  card.translatesAutoresizingMaskIntoConstraints = NO;
  card.backgroundColor = [UIColor colorWithWhite:0.08 alpha:0.97];
  card.layer.cornerRadius = 16; card.clipsToBounds = YES;

  UILabel *title = [self cardLabel:[self candidateTitle:c] size:18 weight:UIFontWeightBold color:[UIColor whiteColor]];
  UILabel *cls = [self cardLabel:c[@"roadClassLabel"] size:13 weight:UIFontWeightSemibold color:[self cardClassColor:c[@"roadClass"]]];
  UILabel *detail = [self cardLabel:[self candidateDetailText:c] size:12.5 weight:UIFontWeightRegular color:[UIColor colorWithWhite:0.85 alpha:1]];

  UIButton *inspect = [self cardButton:@"Inspect" filled:YES action:@selector(onCardInspect)];
  UIButton *cancel = [self cardButton:@"Cancel" filled:NO action:@selector(onCardCancel)];
  UIStackView *actions = [[UIStackView alloc] initWithArrangedSubviews:@[inspect, cancel]];
  actions.axis = UILayoutConstraintAxisHorizontal; actions.distribution = UIStackViewDistributionFillEqually; actions.spacing = 10;

  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[title, cls, detail]];
  if (self.pendingCandidates.count > 1) {
    UIButton *another = [self cardButton:[NSString stringWithFormat:@"Choose another road  (%ld of %lu)",
                                          (long)(self.pendingCandidateIndex + 1), (unsigned long)self.pendingCandidates.count]
                                  filled:NO action:@selector(onCardChooseAnother)];
    [stack addArrangedSubview:another];
  }
  [stack addArrangedSubview:actions];
  stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 9;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [card addSubview:stack];
  [self.view addSubview:card];
  self.candidateCardView = card;

  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [card.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:12],
    [card.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-12],
    [card.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-12],
    [stack.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:16],
    [stack.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-16],
    [stack.topAnchor constraintEqualToAnchor:card.topAnchor constant:14],
    [stack.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-14],
  ]];
}

- (void)dismissCandidateCard {
  [self.candidateCardView removeFromSuperview];
  self.candidateCardView = nil;
}

- (void)onCardInspect {
  if (self.candidateCardView == nil) return;   // cancelled/superseded: card actions are inert
  NSDictionary *c = [self currentPendingCandidate];
  if (c == nil) return;
  double selLat = self.pendingSelLat, selLon = self.pendingSelLon;
  [self dismissCandidateCard];
  if ([self layoutRequiresAcknowledgment]) {
    [self presentDefaultLayoutGateForCandidate:c selLat:selLat selLon:selLon];   // gate BEFORE any inspection is built
  } else {
    [self inspectCandidate:c selLat:selLat selLon:selLon];
  }
}

- (void)onCardCancel {
  [self dismissCandidateCard];
  self.pendingCandidates = nil;
  self.pendingCandidateIndex = 0;
  [self clearSelectedRoadHighlight];   // stay in Cross Section mode so the user can retap
}

- (void)onCardChooseAnother {
  if (self.candidateCardView == nil || self.pendingCandidates.count == 0) return;
  self.pendingCandidateIndex = (self.pendingCandidateIndex + 1) % (NSInteger)self.pendingCandidates.count;
  [self showCandidateCard];
  [self highlightCandidate:[self currentPendingCandidate]];
}

// Highlight the selected candidate's road on the 3D terrain (bright ribbon lifted above
// the class ribbons) + a marker at the snapped point, so the choice is visible before
// Inspect. Persists briefly after inspection closes (cleared on the next fresh tap).
- (void)highlightCandidate:(NSDictionary *)c {
  [self clearSelectedRoadHighlight];
  if (c == nil) return;
  SCNNode *group = [SCNNode node];
  float lift = [self drapeLiftForLayer:ErisDrapeSelectedRoad];
  UIColor *hi = [UIColor colorWithRed:0.24 green:0.96 blue:1.0 alpha:1.0];
  // Same REAL clipping as buildRoadsLayer, so a highlighted candidate whose TIGER segment
  // crosses the terrain (with NO original vertex inside) still renders its in-bounds part.
  for (NSArray *part in [self clipLineCoordsToTerrainBounds:c[@"coords"]]) {
    SCNNode *ribbon = [self roadRibbonNodeFromCoords:part widthMeters:11.0 lift:lift color:hi opacity:0.92];
    if (ribbon) { ribbon.renderingOrder = 60; [group addChildNode:ribbon]; }
  }
  SCNVector3 sp;
  if ([self surfaceWorldForLat:[c[@"snapLat"] doubleValue] lon:[c[@"snapLon"] doubleValue] lift:lift out:&sp]) {
    SCNNode *dot = [SCNNode nodeWithGeometry:[SCNSphere sphereWithRadius:[self sceneUnitsForMeters:4.5]]];
    dot.geometry.firstMaterial.diffuse.contents = hi;
    dot.geometry.firstMaterial.lightingModelName = SCNLightingModelConstant;
    dot.position = sp; dot.renderingOrder = 61;
    [group addChildNode:dot];
  }
  self.selectedRoadNode = group;
  [self.exagNode addChildNode:group];
}

- (void)clearSelectedRoadHighlight {
  [self.selectedRoadNode removeFromParentNode];
  self.selectedRoadNode = nil;
}

#pragma mark - Map -> inspection camera transition (Part 7)

- (void)saveMapCameraState {
  self.savedCameraTransform = self.cameraNode.transform;
  self.savedCameraTarget = self.scnView.defaultCameraController.target;
  self.hasSavedCamera = YES;
}

// Bounded, cancellable flight from the current map camera toward the snapped station,
// rotated to look ALONG the selected road tangent, lowered to an oblique viewpoint. The
// completion presents the inspection ONLY if the transition is still current, this
// controller is still visible, is not being dismissed, and has nothing already presented
// (a monotonic token invalidates a superseded flight).
- (void)animateMapToInspectionAtLat:(double)lat lon:(double)lon upstationDeg:(double)upstationDeg completion:(void (^)(void))completion {
  [self saveMapCameraState];
  SCNVector3 focus;
  if (![self surfaceWorldForLat:lat lon:lon lift:0 out:&focus]) { if (completion) completion(); return; }
  focus.y *= (float)self.verticalExaggeration;
  double rad = upstationDeg * M_PI / 180.0;
  double ux = sin(rad), uz = -cos(rad);                 // upstation direction in world XZ
  float back = [self sceneUnitsForMeters:55.0], side = [self sceneUnitsForMeters:20.0], up = [self sceneUnitsForMeters:28.0];
  SCNVector3 camPos = SCNVector3Make(focus.x - (float)ux * back - (float)uz * side,
                                     focus.y + up,
                                     focus.z - (float)uz * back + (float)ux * side);
  SCNNode *target = [SCNNode node]; target.position = focus; target.name = @"inspectionFocus";
  [self.scnView.scene.rootNode addChildNode:target];
  self.inspectionFocusNode = target;
  SCNLookAtConstraint *look = [SCNLookAtConstraint lookAtConstraintWithTarget:target];
  look.gimbalLockEnabled = YES;
  self.cameraNode.constraints = @[look];   // orient toward the focus throughout the flight

  self.transitionInProgress = YES;
  NSInteger tok = ++self.transitionToken;
  __weak typeof(self) weakSelf = self;
  [SCNTransaction begin];
  [SCNTransaction setAnimationDuration:0.9];
  [SCNTransaction setCompletionBlock:^{
    typeof(self) me = weakSelf; if (me == nil) return;
    if (tok != me.transitionToken || !me.transitionInProgress) return;   // superseded / already cancelled
    if (me.view.window == nil || me.isBeingDismissed || me.presentedViewController != nil) {
      [me cancelInspectionTransition];   // Close/disappearance during the flight -> never present
      return;
    }
    me.transitionInProgress = NO;
    if (completion) completion();
  }];
  self.cameraNode.position = camPos;
  [SCNTransaction commit];
}

// Cancel a flight that never presented: invalidate the token, drop the look-at constraint
// + transient focus node, dismiss the card, and prevent any delayed presentation. Does NOT
// restore the saved camera (per review: only the real return path restores).
- (void)cancelInspectionTransition {
  self.transitionInProgress = NO;
  self.transitionToken++;
  self.cameraNode.constraints = @[];
  [self.inspectionFocusNode removeFromParentNode]; self.inspectionFocusNode = nil;
  [self dismissCandidateCard];
  self.hasSavedCamera = NO;
}

// Restore the PRIOR map camera when inspection actually closes (never reset to the
// incident view); the highlight + slice line stay visible briefly.
- (void)restoreMapCameraAfterInspection {
  self.hasSavedCamera = NO;
  self.inspectionConfirmed = NO;   // a future fresh tap may now clear the highlight
  self.cameraNode.constraints = @[];
  [self.inspectionFocusNode removeFromParentNode]; self.inspectionFocusNode = nil;
  [SCNTransaction begin];
  [SCNTransaction setAnimationDuration:0.5];
  self.cameraNode.transform = self.savedCameraTransform;
  [SCNTransaction commit];
  self.scnView.defaultCameraController.target = self.savedCameraTarget;
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  // Restore only when we actually presented an inspection (not on initial load, and not
  // for a flight that never presented).
  if (self.didPresentInspection && self.hasSavedCamera) [self restoreMapCameraAfterInspection];
  self.didPresentInspection = NO;
}

// Project onto a polyline (equirectangular metres): nearest point + tangent + distance.
- (BOOL)projectLat:(double)lat lon:(double)lon ontoCoords:(NSArray *)coords
            outLat:(double *)outLat outLon:(double *)outLon outTangent:(double *)outTan outDist:(double *)outDist {
  if (![coords isKindOfClass:[NSArray class]] || coords.count < 2) return NO;
  double mPerLon = kXsMPerDegLat * cos(lat * M_PI / 180.0);
  double px = lon * mPerLon, py = lat * kXsMPerDegLat;
  double best = INFINITY; BOOL found = NO;
  for (NSUInteger i = 0; i + 1 < coords.count; i++) {
    NSArray *A = coords[i], *B = coords[i + 1];
    if (![A isKindOfClass:[NSArray class]] || A.count < 2 || ![B isKindOfClass:[NSArray class]] || B.count < 2) continue;
    double aLon = [A[0] doubleValue], aLat = [A[1] doubleValue], bLon = [B[0] doubleValue], bLat = [B[1] doubleValue];
    double ax = aLon * mPerLon, ay = aLat * kXsMPerDegLat, bx = bLon * mPerLon, by = bLat * kXsMPerDegLat;
    double dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    double t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = MAX(0, MIN(1, t));
    double sx = ax + t * dx, sy = ay + t * dy;
    double dist = hypot(px - sx, py - sy);
    if (dist < best) {
      best = dist; found = YES;
      *outLon = sx / mPerLon; *outLat = sy / kXsMPerDegLat;
      double mLat = (aLat + bLat) / 2.0;
      double dN = (bLat - aLat) * kXsMPerDegLat, dE = (bLon - aLon) * kXsMPerDegLat * cos(mLat * M_PI / 180.0);
      *outTan = XsNorm360(atan2(dE, dN) * 180.0 / M_PI);
      *outDist = dist;
    }
  }
  return found;
}

- (NSDictionary *)buildSliceSelectedLat:(double)selLat selLon:(double)selLon snapLat:(double)snapLat snapLon:(double)snapLon
                           upstationDeg:(double)upstationDeg snapped:(BOOL)snapped roadContextKind:(NSString *)kind {
  NSDictionary *road = [self crossSectionRoad];
  double crossBearing = XsCrossBearing(upstationDeg);
  double ltShoulder = XsShoulderEdgeFt(road, YES), rtShoulder = XsShoulderEdgeFt(road, NO);

  NSMutableArray *samples = [NSMutableArray array];
  [samples addObject:[self xsSample:0 side:@"CENTER" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"Centerline"]];
  [samples addObject:[self xsSample:ltShoulder side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"LT outside shoulder edge"]];
  [samples addObject:[self xsSample:rtShoulder side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"RT outside shoulder edge"]];
  for (int d = 5; d <= 50; d += 5) {
    [samples addObject:[self xsSample:(ltShoulder - d) side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:[NSString stringWithFormat:@"LT +%d ft", d]]];
    [samples addObject:[self xsSample:(rtShoulder + d) side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:[NSString stringWithFormat:@"RT +%d ft", d]]];
  }

  NSDictionary *km = @{
    @"ltOutsideShoulderEdge": [self xsSample:ltShoulder side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"LT outside shoulder edge"],
    @"rtOutsideShoulderEdge": [self xsSample:rtShoulder side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"RT outside shoulder edge"],
    @"lt10ft": [self xsSample:(ltShoulder - 10) side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"LT +10 ft"],
    @"lt20ft": [self xsSample:(ltShoulder - 20) side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"LT +20 ft"],
    @"lt50ft": [self xsSample:(ltShoulder - 50) side:@"LT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"LT +50 ft"],
    @"rt10ft": [self xsSample:(rtShoulder + 10) side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"RT +10 ft"],
    @"rt20ft": [self xsSample:(rtShoulder + 20) side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"RT +20 ft"],
    @"rt50ft": [self xsSample:(rtShoulder + 50) side:@"RT" snapLat:snapLat snapLon:snapLon cross:crossBearing label:@"RT +50 ft"],
  };

  NSString *version = XsStr([self params], @"packageVersion", @"—");
  NSMutableDictionary *prov = [@{
    @"roadLayoutSource": XsStr(road, @"source", @"DEFAULT"),
    @"elevationSource": @"USGS 3DEP source-derived offline terrain grid",
    @"packageVersion": version,
    @"snappedToRoadContext": @(snapped),
  } mutableCopy];
  if (kind) prov[@"roadContextSource"] = kind;

  return @{
    @"selectedLat": @(selLat), @"selectedLon": @(selLon),
    @"snappedLat": @(snapLat), @"snappedLon": @(snapLon),
    @"upstationBearingDeg": @(XsNorm360(upstationDeg)),
    @"crossSectionBearingDeg": @(crossBearing),
    @"road": road,
    @"elevationSource": @"USGS_3DEP_OFFLINE_GRID",
    @"samples": samples,
    @"keyMarkers": km,
    @"provenance": prov,
  };
}

- (NSDictionary *)xsSample:(double)offsetFt side:(NSString *)side snapLat:(double)snapLat snapLon:(double)snapLon
                     cross:(double)crossBearing label:(NSString *)label {
  double dM = offsetFt / kXsFtPerM, rad = crossBearing * M_PI / 180.0;
  double dNorth = dM * cos(rad), dEast = dM * sin(rad);
  double cosLat = cos(snapLat * M_PI / 180.0); if (fabs(cosLat) < 1e-9) cosLat = 1e-9;
  double lat = snapLat + dNorth / kXsMPerDegLat;
  double lon = snapLon + dEast / (kXsMPerDegLat * cosLat);
  NSString *status = @"OUT_OF_BOUNDS";
  double elevM = [self sampleElevationMetersAtLat:lat lon:lon outStatus:&status];
  NSMutableDictionary *s = [@{
    @"side": side, @"offsetFt": @(offsetFt), @"lat": @(lat), @"lon": @(lon),
    @"source": @"USGS_3DEP_OFFLINE_GRID", @"status": status, @"label": label,
  } mutableCopy];
  if (isfinite(elevM) && [status isEqualToString:@"OK"]) {
    s[@"elevationM"] = @(elevM);
    s[@"elevationFt"] = @(elevM * kXsFtPerM);
  } else {
    s[@"elevationM"] = [NSNull null];
    s[@"elevationFt"] = [NSNull null];
  }
  return s;
}

// Bilinear elevation (metres) from the READ-ONLY grid, or NAN with an honest status.
// Never mutates gridData or any packaged file.
- (double)sampleElevationMetersAtLat:(double)lat lon:(double)lon outStatus:(NSString **)outStatus {
  if (self.gridData == nil) { if (outStatus) *outStatus = @"OUT_OF_BOUNDS"; return NAN; }
  double col, row;
  if (![self colRowForLat:lat lon:lon outCol:&col outRow:&row]) { if (outStatus) *outStatus = @"OUT_OF_BOUNDS"; return NAN; }
  double eps = 1e-6;
  if (!(col >= -eps && col <= (self.cols - 1) + eps && row >= -eps && row <= (self.rows - 1) + eps)) {
    if (outStatus) *outStatus = @"OUT_OF_BOUNDS"; return NAN;
  }
  double cc = MIN(MAX(col, 0.0), (double)(self.cols - 1));
  double rr = MIN(MAX(row, 0.0), (double)(self.rows - 1));
  NSInteger c0 = (NSInteger)floor(cc), r0 = (NSInteger)floor(rr);
  NSInteger c1 = MIN(c0 + 1, self.cols - 1), r1 = MIN(r0 + 1, self.rows - 1);
  double fc = cc - c0, fr = rr - r0;
  const float *h = (const float *)self.gridData.bytes;   // READ-ONLY
  double cells[4] = {h[r0 * self.cols + c0], h[r0 * self.cols + c1], h[r1 * self.cols + c0], h[r1 * self.cols + c1]};
  for (int i = 0; i < 4; i++) {
    if (!isfinite(cells[i]) || cells[i] == self.noData) { if (outStatus) *outStatus = @"NO_DATA"; return NAN; }
  }
  double top = cells[0] + (cells[1] - cells[0]) * fc, bot = cells[2] + (cells[3] - cells[2]) * fc;
  if (outStatus) *outStatus = @"OK";
  return top + (bot - top) * fr;
}

#pragma mark - Immersive corridor model (Part 8)

// Composite the packaged imagery (single OR tiled) into ONE north-up UIImage covering the
// corridor bounds — fully offline (Core Graphics only, no network). Returns nil when no
// imagery is packaged (the immersive view then falls back to shaded relief).
- (UIImage *)corridorImageForMinLon:(double)minLon minLat:(double)minLat maxLon:(double)maxLon maxLat:(double)maxLat {
  if (![self imageryUsable]) return nil;
  double du = maxLon - minLon, dv = maxLat - minLat;
  if (!(du > 0) || !(dv > 0)) return nil;
  CGSize size = CGSizeMake(512, 512);
  UIGraphicsImageRendererFormat *fmt = [UIGraphicsImageRendererFormat defaultFormat];
  fmt.opaque = YES; fmt.scale = 1.0;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:fmt];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *rc) {
    [[UIColor colorWithWhite:0.10 alpha:1.0] setFill];
    [rc fillRect:CGRectMake(0, 0, size.width, size.height)];
    if (self.imageryTiled) {
      // Draw each tile into the corridor by its OWN declared bounds (north at top).
      for (NSDictionary *meta in self.imageryTileMetas) {
        UIImage *img = meta[@"image"]; NSDictionary *b = meta[@"bounds"];
        if (![img isKindOfClass:[UIImage class]] || ![b isKindOfClass:[NSDictionary class]]) continue;
        double tMinLon = [b[@"min_lon"] doubleValue], tMaxLon = [b[@"max_lon"] doubleValue];
        double tMinLat = [b[@"min_lat"] doubleValue], tMaxLat = [b[@"max_lat"] doubleValue];
        CGFloat x0 = (CGFloat)((tMinLon - minLon) / du) * size.width;
        CGFloat x1 = (CGFloat)((tMaxLon - minLon) / du) * size.width;
        CGFloat y0 = (CGFloat)((maxLat - tMaxLat) / dv) * size.height;
        CGFloat y1 = (CGFloat)((maxLat - tMinLat) / dv) * size.height;
        [img drawInRect:CGRectMake(x0, y0, x1 - x0, y1 - y0)];
      }
    } else if (self.imageryImage != nil) {
      // Single image spans the whole AOI: crop the sub-rect that maps to the corridor.
      double au = self.aoiMaxLon - self.aoiMinLon, av = self.aoiMaxLat - self.aoiMinLat;
      if (au > 0 && av > 0 && self.imageryImage.CGImage != NULL) {
        CGFloat iw = self.imageryImage.size.width, ih = self.imageryImage.size.height;
        CGFloat sx = (CGFloat)((minLon - self.aoiMinLon) / au) * iw;
        CGFloat sw = (CGFloat)(du / au) * iw;
        CGFloat sy = (CGFloat)((self.aoiMaxLat - maxLat) / av) * ih;
        CGFloat sh = (CGFloat)(dv / av) * ih;
        CGRect crop = CGRectIntersection(CGRectMake(sx, sy, sw, sh), CGRectMake(0, 0, iw, ih));
        CGImageRef sub = CGRectIsNull(crop) ? NULL : CGImageCreateWithImageInRect(self.imageryImage.CGImage, crop);
        if (sub) {
          [[UIImage imageWithCGImage:sub] drawInRect:CGRectMake(0, 0, size.width, size.height)];
          CGImageRelease(sub);
        }
      }
    }
  }];
}

// Build the immersive corridor model (Part 8): a north-up terrain patch (~260 m) around
// the snapped station, sampled from the SAME read-only elevation grid, with a composited
// aerial drape, the selected road, and the cross-section slice — all in patch-local
// metres. The camera is oriented along the road by the immersive controller.
- (NSDictionary *)buildCorridorModelAtLat:(double)lat lon:(double)lon upstationDeg:(double)upstationDeg
                             crossBearing:(double)crossBearing slice:(NSDictionary *)slice {
  double halfM = 130.0;
  double cosLat = cos(lat * M_PI / 180.0); if (fabs(cosLat) < 1e-9) cosLat = 1e-9;
  double dLat = halfM / kXsMPerDegLat, dLon = halfM / (kXsMPerDegLat * cosLat);
  double minLon = MAX(self.aoiMinLon, lon - dLon), maxLon = MIN(self.aoiMaxLon, lon + dLon);
  double minLat = MAX(self.aoiMinLat, lat - dLat), maxLat = MIN(self.aoiMaxLat, lat + dLat);
  if (!(maxLon > minLon) || !(maxLat > minLat)) { minLon = lon - dLon; maxLon = lon + dLon; minLat = lat - dLat; maxLat = lat + dLat; }
  double centerLon = (minLon + maxLon) / 2.0, centerLat = (minLat + maxLat) / 2.0;
  double widthM = (maxLon - minLon) * kXsMPerDegLat * cosLat, depthM = (maxLat - minLat) * kXsMPerDegLat;

  NSInteger cols = 48, rows = 48;
  NSMutableArray<NSNumber *> *heights = [NSMutableArray arrayWithCapacity:(NSUInteger)(rows * cols)];
  double minElev = INFINITY, maxElev = -INFINITY;
  for (NSInteger r = 0; r < rows; r++) {
    double fLat = maxLat - (maxLat - minLat) * ((double)r / (rows - 1));   // row 0 = north
    for (NSInteger cc = 0; cc < cols; cc++) {
      double fLon = minLon + (maxLon - minLon) * ((double)cc / (cols - 1));
      NSString *status = @"";
      double e = [self sampleElevationMetersAtLat:fLat lon:fLon outStatus:&status];
      if (!isfinite(e) || ![status isEqualToString:@"OK"]) e = self.minE;   // honest fallback, never invented relief
      [heights addObject:@(e)];
      minElev = MIN(minElev, e); maxElev = MAX(maxElev, e);
    }
  }
  if (!isfinite(minElev)) { minElev = self.minE; maxElev = self.maxE; }

  // Station-FIXED geometry: the cross-section plane + camera target follow the snapped
  // station (lat/lon), NOT the edge-clipped patch midpoint (centerLon/centerLat).
  double stationEastM = (lon - centerLon) * kXsMPerDegLat * cosLat;
  double stationSouthM = (centerLat - lat) * kXsMPerDegLat;

  // Selected road: REAL per-segment clip to the corridor rect -> separate parts (a
  // crossing segment survives even when both endpoints are outside; leave/re-enter makes
  // separate parts; disconnected parts are never chorded). Mirrors corridorModel.ts.
  NSArray<NSArray *> *clippedParts = [self clipRoadCoords:slice[@"selectedRoadCoords"]
                                                   minLon:minLon minLat:minLat maxLon:maxLon maxLat:maxLat
                                               stationLon:lon stationLat:lat];
  NSMutableArray *roadPartsXsZs = [NSMutableArray array];
  for (NSArray *part in clippedParts) {
    NSMutableArray *lp = [NSMutableArray array];
    for (NSArray *c in part) {
      double clon = [c[0] doubleValue], clat = [c[1] doubleValue];
      [lp addObject:@[@((clon - centerLon) * kXsMPerDegLat * cosLat), @((centerLat - clat) * kXsMPerDegLat)]];
    }
    if (lp.count >= 2) [roadPartsXsZs addObject:lp];   // render each part independently
  }

  // Slice line built around the STATION (so the cross-section plane passes through the
  // exact snapped point) and CLIPPED to the corridor rect (so an edge station never draws
  // a plane floating beyond the terrain mesh, and never uses clamped edge elevation).
  NSDictionary *road = [self crossSectionRoad];
  double ltSh = XsShoulderEdgeFt(road, YES), rtSh = XsShoulderEdgeFt(road, NO);
  double minOff = ltSh - 50, maxOff = rtSh + 50;
  double r2 = crossBearing * M_PI / 180.0;
  double e0 = minOff / kXsFtPerM, e1 = maxOff / kXsFtPerM;
  double lon0 = lon + (e0 * sin(r2)) / (kXsMPerDegLat * cosLat), lat0 = lat + (e0 * cos(r2)) / kXsMPerDegLat;
  double lon1 = lon + (e1 * sin(r2)) / (kXsMPerDegLat * cosLat), lat1 = lat + (e1 * cos(r2)) / kXsMPerDegLat;
  double st0, st1;
  BOOL sliceInRect = [self clipSegAx:lon0 ay:lat0 bx:lon1 by:lat1 minX:minLon minY:minLat maxX:maxLon maxY:maxLat lo:&st0 hi:&st1];
  BOOL sliceTruncated = !sliceInRect || st0 > 1e-9 || st1 < 1 - 1e-9;   // cut by the package boundary
  NSMutableArray *sliceXsZs = [NSMutableArray array];
  if (sliceInRect) {
    for (int i = 0; i <= 20; i++) {
      double tt = st0 + (st1 - st0) * ((double)i / 20.0);
      double slon = lon0 + (lon1 - lon0) * tt, slat = lat0 + (lat1 - lat0) * tt;
      [sliceXsZs addObject:@[@((slon - centerLon) * kXsMPerDegLat * cosLat), @((centerLat - slat) * kXsMPerDegLat)]];
    }
  }

  UIImage *img = [self corridorImageForMinLon:minLon minLat:minLat maxLon:maxLon maxLat:maxLat];
  return @{
    @"cols": @(cols), @"rows": @(rows), @"widthM": @(widthM), @"depthM": @(depthM),
    @"heights": heights, @"minElevM": @(minElev), @"maxElevM": @(maxElev),
    @"image": img ?: (id)[NSNull null], @"hasImagery": @(img != nil),
    @"roadPartsXsZs": roadPartsXsZs, @"sliceXsZs": sliceXsZs, @"sliceTruncated": @(sliceTruncated),
    @"stationEastM": @(stationEastM), @"stationSouthM": @(stationSouthM),
    @"upstationDeg": @(upstationDeg), @"crossBearingDeg": @(crossBearing),
  };
}

// Liang-Barsky clip of ONE segment to the rect; sets lo/hi params, returns NO on a miss.
- (BOOL)clipSegAx:(double)ax ay:(double)ay bx:(double)bx by:(double)by
             minX:(double)minX minY:(double)minY maxX:(double)maxX maxY:(double)maxY
               lo:(double *)lo hi:(double *)hi {
  double dx = bx - ax, dy = by - ay;
  double p[4] = {-dx, dx, -dy, dy};
  double q[4] = {ax - minX, maxX - ax, ay - minY, maxY - ay};
  double t0 = 0, t1 = 1;
  for (int i = 0; i < 4; i++) {
    if (p[i] == 0) { if (q[i] < 0) return NO; }
    else {
      double t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return NO; if (t > t0) t0 = t; }
      else { if (t < t0) return NO; if (t < t1) t1 = t; }
    }
  }
  if (t0 > t1) return NO;
  *lo = t0; *hi = t1; return YES;
}

// SHARED clip helper: clip a line ([lon,lat] array) to a geographic rect via Liang-Barsky
// per segment -> array of SEPARATE parts. A crossing segment (both endpoints outside) is
// retained and cut to the two boundaries; a partial segment is cut at the boundary; a
// fully-outside segment is dropped; leave/re-enter yields separate parts; disconnected
// parts are never joined; every output coordinate lies inside the rect. Mirrors
// clipPolylineToRect in corridorModel.ts (unit-tested there).
- (NSArray<NSMutableArray *> *)clipLineCoords:(id)coordsIn toMinLon:(double)minLon minLat:(double)minLat
                                       maxLon:(double)maxLon maxLat:(double)maxLat {
  NSArray *coords = [coordsIn isKindOfClass:[NSArray class]] ? coordsIn : @[];
  NSMutableArray<NSMutableArray *> *parts = [NSMutableArray array];
  NSMutableArray *cur = [NSMutableArray array];
  double eps = 1e-12;
  for (NSUInteger i = 0; i + 1 < coords.count; i++) {
    NSArray *A = coords[i], *B = coords[i + 1];
    if (![A isKindOfClass:[NSArray class]] || A.count < 2 || ![B isKindOfClass:[NSArray class]] || B.count < 2) {
      if (cur.count) { [parts addObject:cur]; cur = [NSMutableArray array]; }
      continue;
    }
    double ax = [A[0] doubleValue], ay = [A[1] doubleValue], bx = [B[0] doubleValue], by = [B[1] doubleValue];
    double t0, t1;
    if (![self clipSegAx:ax ay:ay bx:bx by:by minX:minLon minY:minLat maxX:maxLon maxY:maxLat lo:&t0 hi:&t1]) {
      if (cur.count) { [parts addObject:cur]; cur = [NSMutableArray array]; }
      continue;
    }
    double p0x = ax + (bx - ax) * t0, p0y = ay + (by - ay) * t0;
    double p1x = ax + (bx - ax) * t1, p1y = ay + (by - ay) * t1;
    BOOL entering = t0 > eps, exiting = t1 < 1 - eps;
    if (cur.count == 0 || entering) {
      if (cur.count) [parts addObject:cur];
      cur = [NSMutableArray arrayWithObject:@[@(p0x), @(p0y)]];
    }
    NSArray *last = cur.lastObject;
    if (!(fabs([last[0] doubleValue] - p1x) < 1e-12 && fabs([last[1] doubleValue] - p1y) < 1e-12)) {
      [cur addObject:@[@(p1x), @(p1y)]];
    }
    if (exiting) { [parts addObject:cur]; cur = [NSMutableArray array]; }
  }
  if (cur.count) [parts addObject:cur];
  NSMutableArray<NSMutableArray *> *out = [NSMutableArray array];
  for (NSMutableArray *p in parts) if (p.count >= 2) [out addObject:p];
  return out;
}

// Clip a line to the EXACT terrain-grid geographic bounds (used by buildRoadsLayer +
// highlightCandidate + uploaded-line geometry, so all main-map lines are truly clipped,
// not vertex-filtered).
- (NSArray<NSMutableArray *> *)clipLineCoordsToTerrainBounds:(id)coordsIn {
  return [self clipLineCoords:coordsIn toMinLon:self.aoiMinLon minLat:self.aoiMinLat
                       maxLon:self.aoiMaxLon maxLat:self.aoiMaxLat];
}

// Clip a road to the corridor rect + insert the station into the nearest part.
- (NSArray<NSArray *> *)clipRoadCoords:(id)coordsIn minLon:(double)minLon minLat:(double)minLat
                                maxLon:(double)maxLon maxLat:(double)maxLat
                            stationLon:(double)stationLon stationLat:(double)stationLat {
  NSMutableArray<NSMutableArray *> *out = [[self clipLineCoords:coordsIn toMinLon:minLon minLat:minLat
                                                        maxLon:maxLon maxLat:maxLat] mutableCopy];
  [self insertStationLon:stationLon lat:stationLat intoParts:out];
  return out;
}

// Insert the station as an explicit vertex of the nearest road part (within ~2 m). Never
// creates a new part or a false chord.
- (void)insertStationLon:(double)sLon lat:(double)sLat intoParts:(NSMutableArray<NSMutableArray *> *)parts {
  double bestD = INFINITY; NSInteger bpi = -1, bsi = -1;
  double cosLat = cos(sLat * M_PI / 180.0); if (fabs(cosLat) < 1e-9) cosLat = 1e-9;
  double px = sLon * kXsMPerDegLat * cosLat, py = sLat * kXsMPerDegLat;
  for (NSUInteger pi = 0; pi < parts.count; pi++) {
    NSArray *part = parts[pi];
    for (NSUInteger si = 0; si + 1 < part.count; si++) {
      double ax = [part[si][0] doubleValue] * kXsMPerDegLat * cosLat, ay = [part[si][1] doubleValue] * kXsMPerDegLat;
      double bx = [part[si + 1][0] doubleValue] * kXsMPerDegLat * cosLat, by = [part[si + 1][1] doubleValue] * kXsMPerDegLat;
      double dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      double t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0; t = MAX(0, MIN(1, t));
      double d = hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) { bestD = d; bpi = (NSInteger)pi; bsi = (NSInteger)si; }
    }
  }
  if (bpi < 0 || bestD > 2.0) return;
  NSMutableArray *part = parts[bpi];
  NSArray *a = part[bsi], *b = part[bsi + 1];
  BOOL nearA = fabs([a[0] doubleValue] - sLon) < 1e-9 && fabs([a[1] doubleValue] - sLat) < 1e-9;
  BOOL nearB = fabs([b[0] doubleValue] - sLon) < 1e-9 && fabs([b[1] doubleValue] - sLat) < 1e-9;
  if (!nearA && !nearB) [part insertObject:@[@(sLon), @(sLat)] atIndex:bsi + 1];
}

// Translucent slice line draped across the road on the terrain surface (under exagNode).
- (void)drawSliceLineAtLat:(double)lat lon:(double)lon crossBearing:(double)crossBearing road:(NSDictionary *)road {
  [self.sliceLineNode removeFromParentNode];
  double ltShoulder = XsShoulderEdgeFt(road, YES), rtShoulder = XsShoulderEdgeFt(road, NO);
  double minOff = ltShoulder - 50, maxOff = rtShoulder + 50;
  NSMutableArray<NSValue *> *pts = [NSMutableArray array];
  int steps = 24;
  for (int i = 0; i <= steps; i++) {
    double off = minOff + (maxOff - minOff) * ((double)i / steps);
    double dM = off / kXsFtPerM, rad = crossBearing * M_PI / 180.0;
    double cosLat = cos(lat * M_PI / 180.0); if (fabs(cosLat) < 1e-9) cosLat = 1e-9;
    double slat = lat + (dM * cos(rad)) / kXsMPerDegLat;
    double slon = lon + (dM * sin(rad)) / (kXsMPerDegLat * cosLat);
    SCNVector3 w;
    if ([self surfaceWorldForLat:slat lon:slon lift:[self drapeLiftForLayer:ErisDrapeSliceIndicator] out:&w]) [pts addObject:[NSValue valueWithSCNVector3:w]];
  }
  if (pts.count < 2) return;
  SCNNode *line = [self polylineFromPoints:pts color:[UIColor colorWithRed:0.30 green:0.85 blue:0.95 alpha:0.9] closed:NO];
  self.sliceLineNode = line;
  [self.exagNode addChildNode:line];
}

- (void)showCrossSectionMessage:(NSString *)msg {
  UIAlertController *a = [UIAlertController alertControllerWithTitle:@"Cross Section" message:msg preferredStyle:UIAlertControllerStyleAlert];
  [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:a animated:YES completion:nil];
}

@end
