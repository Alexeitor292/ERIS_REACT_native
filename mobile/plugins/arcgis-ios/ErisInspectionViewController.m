#import "ErisInspectionViewController.h"
#import "ErisImmersiveCorridorViewController.h"
#import "ErisRoadSliceSceneViewController.h"

static NSString *InsStr(NSDictionary *d, NSString *k, NSString *def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v isKindOfClass:[NSString class]] ? v : def;
}

static NSString *const kErisInsObservedDividedCorridor = @"observed_divided_corridor";

@interface ErisInspectionViewController ()
@property(nonatomic, strong) NSDictionary *slice, *corridor;
// The ONE immutable divided-corridor inspection model, built by the terrain controller
// before presentation and handed unchanged to BOTH children. Never rebuilt here.
@property(nonatomic, strong) NSDictionary *inspectionGeometry;
// The ONE immutable provenance record from the terrain controller (real corridor/model
// values). Rendered verbatim — this view never re-derives a provenance fact.
@property(nonatomic, strong) NSDictionary *provenance;
@property(nonatomic, strong) ErisImmersiveCorridorViewController *immersiveVC;   // Immersive (default)
@property(nonatomic, strong) ErisRoadSliceSceneViewController *technicalVC;      // Technical (orthographic)
@property(nonatomic, strong) UIView *containerView;
@property(nonatomic, strong) UISegmentedControl *modeControl;
@property(nonatomic, strong) UIViewController *activeChild;

// Compact expandable provenance (Part 11). One control, one line collapsed; no second
// acknowledgment anywhere in the inspection flow.
@property(nonatomic, strong) UIView *provenanceBar;
@property(nonatomic, strong) UILabel *provenanceSummaryLabel;
@property(nonatomic, strong) UILabel *provenanceDetailLabel;
@property(nonatomic, strong) UIButton *provenanceToggle;
@property(nonatomic, strong) NSLayoutConstraint *provenanceDetailHeight;
@property(nonatomic, assign) BOOL provenanceExpanded;
@end

@implementation ErisInspectionViewController

- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor
           inspectionGeometry:(NSDictionary *)inspectionGeometry
                   provenance:(NSDictionary *)provenance {
  if ((self = [super init])) {
    _slice = [slice isKindOfClass:[NSDictionary class]] ? slice : @{};
    _corridor = [corridor isKindOfClass:[NSDictionary class]] ? corridor : @{};
    _inspectionGeometry = [inspectionGeometry isKindOfClass:[NSDictionary class]] ? inspectionGeometry : nil;
    // Fall back to the slice's own provenance only when none was supplied, so an older
    // call site degrades to less detail rather than to a wrong claim.
    _provenance = [provenance isKindOfClass:[NSDictionary class]] ? provenance
                : ([_slice[@"provenance"] isKindOfClass:[NSDictionary class]] ? _slice[@"provenance"] : @{});
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];
  self.title = @"Road Inspection";

  self.containerView = [[UIView alloc] initWithFrame:self.view.bounds];
  self.containerView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.view addSubview:self.containerView];

  // Both children are built from the SAME slice and the SAME inspectionGeometry instance
  // (Part 9/12 — one shared immutable model). Neither child reprojects the station or
  // derives its own section: they consume what the terrain controller already validated.
  self.immersiveVC = [[ErisImmersiveCorridorViewController alloc] initWithSlice:self.slice
                                                                       corridor:self.corridor
                                                             inspectionGeometry:self.inspectionGeometry];
  self.technicalVC = [[ErisRoadSliceSceneViewController alloc] initWithSlice:self.slice
                                                         inspectionGeometry:self.inspectionGeometry];

#if DEBUG
  // The two children must be looking at the identical model — not equal copies, the SAME
  // object. A divergence here would mean two different "truths" for one station.
  if (self.inspectionGeometry) {
    NSAssert([self.immersiveVC valueForKey:@"inspectionGeometry"] == self.inspectionGeometry,
             @"Immersive child must receive the shared inspectionGeometry instance");
    NSAssert([self.technicalVC valueForKey:@"inspectionGeometry"] == self.inspectionGeometry,
             @"Technical child must receive the shared inspectionGeometry instance");
    NSDictionary *st = self.inspectionGeometry[@"station"];
    NSAssert([self.inspectionGeometry[@"featureId"] isKindOfClass:[NSString class]] &&
                 [st[@"lat"] isKindOfClass:[NSNumber class]] && [st[@"lon"] isKindOfClass:[NSNumber class]],
             @"inspectionGeometry must carry a featureId and a resolved station");
  }
#endif

  self.modeControl = [[UISegmentedControl alloc] initWithItems:@[@"Immersive", @"Technical"]];
  self.modeControl.selectedSegmentIndex = 0;   // Immersive first (Part 8/9)
  self.modeControl.accessibilityLabel = @"Inspection mode";
  [self.modeControl addTarget:self action:@selector(onModeChanged) forControlEvents:UIControlEventValueChanged];
  self.navigationItem.titleView = self.modeControl;

  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(onClose)];
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Reset" style:UIBarButtonItemStylePlain target:self action:@selector(onReset)];

  [self showChild:self.immersiveVC];
  [self addProvenanceBar];
}

- (void)showChild:(UIViewController *)vc {
  if (self.activeChild == vc) return;
  if (self.activeChild) {
    [self.activeChild willMoveToParentViewController:nil];
    [self.activeChild.view removeFromSuperview];
    [self.activeChild removeFromParentViewController];
  }
  [self addChildViewController:vc];
  vc.view.frame = self.containerView.bounds;
  vc.view.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.containerView addSubview:vc.view];
  [vc didMoveToParentViewController:self];
  self.activeChild = vc;
  if (self.provenanceBar) [self.view bringSubviewToFront:self.provenanceBar];
}

- (void)onModeChanged {
  [self showChild:(self.modeControl.selectedSegmentIndex == 0) ? (UIViewController *)self.immersiveVC
                                                               : (UIViewController *)self.technicalVC];
}

- (void)onReset {
  if ([self.activeChild respondsToSelector:@selector(resetCameraFraming)]) {
    [(id)self.activeChild resetCameraFraming];
  }
}

- (void)onClose {
  [self releaseChildSceneResources];
  [self dismissViewControllerAnimated:YES completion:nil];
}

#pragma mark - Deterministic teardown (Part 12F)

// Inspection scenes hold decoded imagery, composited corridor textures and elevation
// arrays — tens of MB. Release them the moment the inspection goes away rather than
// waiting on autorelease/dealloc timing. Idempotent: safe from every path below.
- (void)releaseChildSceneResources {
  if ([self.immersiveVC respondsToSelector:@selector(releaseSceneResources)]) [self.immersiveVC releaseSceneResources];
  if ([self.technicalVC respondsToSelector:@selector(releaseSceneResources)]) [self.technicalVC releaseSceneResources];
}

- (void)viewDidDisappear:(BOOL)animated {
  [super viewDidDisappear:animated];
  if (self.isBeingDismissed || self.navigationController.isBeingDismissed || self.parentViewController == nil) {
    [self releaseChildSceneResources];
  }
}

- (void)dealloc {
  [self releaseChildSceneResources];
}

#pragma mark - Compact expandable provenance (Part 12E)

// ONE compact provenance bar: a single summary line plus a Details disclosure. It replaces
// the old full-width acknowledgment panel and its Acknowledge button — the inspection flow
// has exactly one acknowledgment (on the map, before entry), never a second one here.
// Nothing is gated behind a tap: the summary is always visible, Details only adds depth.
- (void)addProvenanceBar {
  NSDictionary *prov = self.provenance;
  NSString *summary = [self provenanceSummaryText:prov];
  NSString *detail = [self provenanceDetailText:prov];
  if (summary.length == 0) return;

  UIView *bar = [[UIView alloc] init];
  bar.translatesAutoresizingMaskIntoConstraints = NO;
  bar.backgroundColor = [UIColor colorWithWhite:0.06 alpha:0.90];
  bar.layer.cornerRadius = 10; bar.clipsToBounds = YES;
  bar.layer.borderWidth = 1.0 / UIScreen.mainScreen.scale;
  bar.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.18].CGColor;

  UILabel *sum = [[UILabel alloc] init];
  sum.translatesAutoresizingMaskIntoConstraints = NO;
  sum.numberOfLines = 2;
  sum.font = [UIFont preferredFontForTextStyle:UIFontTextStyleCaption1];
  sum.adjustsFontForContentSizeCategory = YES;   // Dynamic Type
  sum.textColor = [UIColor colorWithWhite:0.92 alpha:1.0];
  sum.text = summary;
  sum.isAccessibilityElement = YES;
  sum.accessibilityLabel = [@"Data provenance. " stringByAppendingString:summary];

  UIButton *toggle = [UIButton buttonWithType:UIButtonTypeSystem];
  toggle.translatesAutoresizingMaskIntoConstraints = NO;
  [toggle setTitle:@"Details" forState:UIControlStateNormal];
  toggle.titleLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleCaption1];
  toggle.titleLabel.adjustsFontForContentSizeCategory = YES;
  [toggle setTitleColor:[UIColor colorWithRed:0.42 green:0.75 blue:1.0 alpha:1.0] forState:UIControlStateNormal];
  [toggle addTarget:self action:@selector(onToggleProvenance) forControlEvents:UIControlEventTouchUpInside];
  toggle.accessibilityLabel = @"Show provenance details";
  toggle.accessibilityHint = @"Expands the sources and limitations for this cross section";
  toggle.accessibilityTraits = UIAccessibilityTraitButton;

  UILabel *det = [[UILabel alloc] init];
  det.translatesAutoresizingMaskIntoConstraints = NO;
  det.numberOfLines = 0;
  det.font = [UIFont preferredFontForTextStyle:UIFontTextStyleCaption2];
  det.adjustsFontForContentSizeCategory = YES;
  det.textColor = [UIColor colorWithWhite:0.80 alpha:1.0];
  det.text = detail;
  det.hidden = YES;                       // collapsed by default — compact
  det.accessibilityElementsHidden = YES;

  [bar addSubview:sum]; [bar addSubview:toggle]; [bar addSubview:det];
  [self.view addSubview:bar];
  self.provenanceBar = bar;
  self.provenanceSummaryLabel = sum;
  self.provenanceDetailLabel = det;
  self.provenanceToggle = toggle;
  self.provenanceExpanded = NO;

  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [bar.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:10],
    [bar.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-10],
    [bar.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-8],
    [sum.leadingAnchor constraintEqualToAnchor:bar.leadingAnchor constant:10],
    [sum.topAnchor constraintEqualToAnchor:bar.topAnchor constant:8],
    [toggle.leadingAnchor constraintEqualToAnchor:sum.trailingAnchor constant:8],
    [toggle.trailingAnchor constraintEqualToAnchor:bar.trailingAnchor constant:-10],
    [toggle.firstBaselineAnchor constraintEqualToAnchor:sum.firstBaselineAnchor],
    [toggle.widthAnchor constraintGreaterThanOrEqualToConstant:56],
    [det.leadingAnchor constraintEqualToAnchor:bar.leadingAnchor constant:10],
    [det.trailingAnchor constraintEqualToAnchor:bar.trailingAnchor constant:-10],
    [det.topAnchor constraintEqualToAnchor:sum.bottomAnchor constant:6],
    [det.bottomAnchor constraintEqualToAnchor:bar.bottomAnchor constant:-8],
  ]];
  // Collapsed: the bar hugs the summary line; the detail label is hidden with zero height.
  self.provenanceDetailHeight = [det.heightAnchor constraintEqualToConstant:0];
  self.provenanceDetailHeight.active = YES;
}

- (void)onToggleProvenance {
  self.provenanceExpanded = !self.provenanceExpanded;
  BOOL open = self.provenanceExpanded;
  self.provenanceDetailLabel.hidden = NO;
  self.provenanceDetailHeight.active = !open;
  self.provenanceDetailLabel.accessibilityElementsHidden = !open;
  [self.provenanceToggle setTitle:(open ? @"Hide" : @"Details") forState:UIControlStateNormal];
  self.provenanceToggle.accessibilityLabel = open ? @"Hide provenance details" : @"Show provenance details";
  [UIView animateWithDuration:0.22
      animations:^{
        self.provenanceDetailLabel.alpha = open ? 1.0 : 0.0;
        [self.view layoutIfNeeded];
      }
      completion:^(BOOL finished) {
        self.provenanceDetailLabel.hidden = !open;
        UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification,
                                        open ? self.provenanceDetailLabel : self.provenanceToggle);
      }];
}

// Summary line. For an observed divided corridor this states the MEASURED separation and
// the imagery basis — never a lane/width claim, which the package cannot support.
- (NSString *)provenanceSummaryText:(NSDictionary *)prov {
  NSMutableArray *bits = [NSMutableArray array];
  NSDictionary *dc = self.inspectionGeometry;
  if (dc && [InsStr(self.slice, @"renderingMode", @"") isEqualToString:kErisInsObservedDividedCorridor]) {
    double sep = [dc[@"separationM"] doubleValue];
    [bits addObject:[NSString stringWithFormat:@"Observed divided corridor • %.1f m centerline separation", sep]];
  } else {
    NSString *layoutSrc = InsStr(prov, @"roadLayoutSource", @"DEFAULT");
    [bits addObject:[layoutSrc isEqualToString:@"DEFAULT"] ? @"Default roadway template — not observed geometry"
                                                           : [NSString stringWithFormat:@"Roadway layout • %@", layoutSrc]];
  }
  NSString *imgProv = InsStr(prov, @"imageryProvider", nil);
  id gsd = prov[@"imageryMetersPerPixel"];
  if (imgProv.length && [gsd isKindOfClass:[NSNumber class]]) {
    [bits addObject:[NSString stringWithFormat:@"%@ • %.2f m/px", imgProv, [gsd doubleValue]]];
  } else if (imgProv.length) {
    [bits addObject:imgProv];
  }
  return [bits componentsJoinedByString:@"\n"];
}

// Detail body. Says plainly what is observed and what is UNAVAILABLE, so the compact bar
// never becomes a way of hiding a limitation.
- (NSString *)provenanceDetailText:(NSDictionary *)prov {
  NSMutableArray *lines = [NSMutableArray array];
  NSDictionary *dc = self.inspectionGeometry;
  if (dc && [InsStr(self.slice, @"renderingMode", @"") isEqualToString:kErisInsObservedDividedCorridor]) {
    [lines addObject:[NSString stringWithFormat:
        @"Observed: two carriageway centerlines paired by %@ (%@); separation measured perpendicular to the corridor axis at this station.",
        InsStr(dc, @"pairingMethod", @"station-local pairing"), InsStr(dc, @"pairingVersion", @"—")]];
    [lines addObject:@"Unavailable: lane count, lane width, shoulder width, pavement edges and physical median width are not in this package. Nothing between the centerlines is measured pavement."];
  } else {
    NSString *layoutSrc = InsStr(prov, @"roadLayoutSource", @"DEFAULT");
    if ([layoutSrc isEqualToString:@"DEFAULT"]) {
      NSString *cls = InsStr(self.slice, @"selectedRoadClass", @"unclassified");
      [lines addObject:[cls isEqualToString:@"primary"]
          ? @"Unavailable: this highway is drawn from a DEFAULT one-lane-each-way (32 ft) template — NOT real highway geometry. Verify lane, shoulder and median dimensions."
          : @"Unavailable: roadway dimensions come from a DEFAULT template. Verify lane, shoulder and median dimensions before relying on this section."];
    } else {
      [lines addObject:[NSString stringWithFormat:@"Observed: roadway layout from %@.", layoutSrc]];
    }
  }
  NSString *elev = InsStr(prov, @"elevationSource", nil);
  if (elev.length) [lines addObject:[NSString stringWithFormat:@"Ground profile: %@.", elev]];

  // The section actually measured, and whether the package could supply all of it.
  id reqSpan = prov[@"sectionRequestedSpanM"], clipSpan = prov[@"sectionClippedSpanM"];
  if ([reqSpan isKindOfClass:[NSNumber class]] && [clipSpan isKindOfClass:[NSNumber class]]) {
    NSMutableString *s = [NSMutableString stringWithFormat:
        @"Section: %.1f m requested across the corridor, %.1f m measured from the packaged grid",
        [reqSpan doubleValue], [clipSpan doubleValue]];
    id n = prov[@"sectionSampleCount"], sp = prov[@"sectionSampleSpacingM"];
    if ([n isKindOfClass:[NSNumber class]] && [sp isKindOfClass:[NSNumber class]]) {
      [s appendFormat:@" (%@ samples at ~%.1f m spacing)", n, [sp doubleValue]];
    }
    [s appendString:@"."];
    [lines addObject:s];
  }

  // Every applicable quality flag, stated rather than implied by silence.
  NSMutableArray *flags = [NSMutableArray array];
  if (![prov[@"imageryPresent"] boolValue]) {
    [flags addObject:@"No packaged imagery covers this corridor — terrain is shown as shaded relief."];
  } else {
    id tiles = prov[@"imageryTileCount"];
    id w = prov[@"textureWidthPx"], h = prov[@"textureHeightPx"];
    if ([w isKindOfClass:[NSNumber class]] && [h isKindOfClass:[NSNumber class]] && [w intValue] > 0) {
      [flags addObject:[NSString stringWithFormat:@"Corridor texture %@×%@ px from %@ packaged tile(s).", w, h, tiles ?: @(0)]];
    }
    if ([prov[@"imageryLegacySingle"] boolValue]) {
      [flags addObject:@"Imagery comes from a single packaged overview, not tile-native detail — apparent sharpness is limited by that source."];
    }
    if ([prov[@"textureSourceLimited"] boolValue]) {
      [flags addObject:@"Texture resolution is limited by the packaged source, not by the display."];
    }
    if ([prov[@"textureMemoryCapped"] boolValue]) {
      [flags addObject:@"Texture was capped by the memory budget — fine detail may be reduced."];
    }
  }
  if ([prov[@"sectionTruncated"] boolValue]) {
    [flags addObject:@"The section is truncated by the package boundary — only the in-bounds portion is measured."];
  }
  if (![prov[@"orientationAuthoritative"] boolValue]) {
    [flags addObject:@"Orientation follows packaged centerline geometry; upstation is not verified."];
  }
  if (flags.count) [lines addObject:[flags componentsJoinedByString:@"\n"]];

  [lines addObject:@"Packaged offline — no network data was used for this inspection."];
  return [lines componentsJoinedByString:@"\n\n"];
}

@end
