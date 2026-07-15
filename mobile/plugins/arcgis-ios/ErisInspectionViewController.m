#import "ErisInspectionViewController.h"
#import "ErisImmersiveCorridorViewController.h"
#import "ErisRoadSliceSceneViewController.h"

static NSString *InsStr(NSDictionary *d, NSString *k, NSString *def) {
  id v = [d isKindOfClass:[NSDictionary class]] ? d[k] : nil;
  return [v isKindOfClass:[NSString class]] ? v : def;
}

@interface ErisInspectionViewController ()
@property(nonatomic, strong) NSDictionary *slice, *corridor;
@property(nonatomic, strong) ErisImmersiveCorridorViewController *immersiveVC;   // Immersive (default)
@property(nonatomic, strong) ErisRoadSliceSceneViewController *technicalVC;      // Technical (orthographic)
@property(nonatomic, strong) UIView *containerView;
@property(nonatomic, strong) UISegmentedControl *modeControl;
@property(nonatomic, strong) UIViewController *activeChild;
@property(nonatomic, strong) UIView *ackBanner;
@end

@implementation ErisInspectionViewController

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
  self.title = @"Road Inspection";

  self.containerView = [[UIView alloc] initWithFrame:self.view.bounds];
  self.containerView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.view addSubview:self.containerView];

  // Both children built from the SAME slice model (Part 9 — shared immutable state).
  self.immersiveVC = [[ErisImmersiveCorridorViewController alloc] initWithSlice:self.slice corridor:self.corridor];
  self.technicalVC = [[ErisRoadSliceSceneViewController alloc] initWithSlice:self.slice];

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
  [self addAcknowledgmentIfNeeded];
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
  if (self.ackBanner) [self.view bringSubviewToFront:self.ackBanner];   // keep the acknowledgment on top
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

- (void)onClose { [self dismissViewControllerAnimated:YES completion:nil]; }

// Part 10: when the roadway layout is DEFAULT, require an explicit acknowledgment before
// the schematic is relied upon (a primary highway gets the stronger not-real-geometry
// wording). Truthful; never depicts a DEFAULT template as an observed freeway layout.
- (void)addAcknowledgmentIfNeeded {
  NSDictionary *prov = [self.slice[@"provenance"] isKindOfClass:[NSDictionary class]] ? self.slice[@"provenance"] : @{};
  NSString *layoutSrc = InsStr(prov, @"roadLayoutSource", @"DEFAULT");
  if (![layoutSrc isEqualToString:@"DEFAULT"]) return;
  NSString *cls = InsStr(self.slice, @"selectedRoadClass", @"unclassified");
  NSString *msg = [cls isEqualToString:@"primary"]
      ? @"Default roadway assumptions. This highway is drawn from a DEFAULT one-lane-each-way (32 ft) template — NOT real highway geometry. Verify lane, shoulder, and median dimensions."
      : @"Default roadway assumptions — verify lane, shoulder, and median dimensions before relying on this section.";

  UIView *banner = [[UIView alloc] init];
  banner.translatesAutoresizingMaskIntoConstraints = NO;
  banner.backgroundColor = [UIColor colorWithRed:0.55 green:0.42 blue:0.05 alpha:0.96];
  banner.layer.cornerRadius = 12; banner.clipsToBounds = YES;
  UILabel *l = [[UILabel alloc] init];
  l.translatesAutoresizingMaskIntoConstraints = NO; l.numberOfLines = 0;
  l.font = [UIFont systemFontOfSize:12 weight:UIFontWeightSemibold];
  l.textColor = [UIColor whiteColor]; l.text = msg;
  UIButton *ack = [UIButton buttonWithType:UIButtonTypeSystem];
  ack.translatesAutoresizingMaskIntoConstraints = NO;
  [ack setTitle:@"Acknowledge" forState:UIControlStateNormal];
  [ack setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
  ack.titleLabel.font = [UIFont systemFontOfSize:14 weight:UIFontWeightBold];
  [ack addTarget:self action:@selector(onAcknowledge) forControlEvents:UIControlEventTouchUpInside];
  [banner addSubview:l]; [banner addSubview:ack];
  [self.view addSubview:banner];
  self.ackBanner = banner;
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [banner.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:10],
    [banner.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-10],
    [banner.topAnchor constraintEqualToAnchor:g.topAnchor constant:8],
    [l.leadingAnchor constraintEqualToAnchor:banner.leadingAnchor constant:12],
    [l.topAnchor constraintEqualToAnchor:banner.topAnchor constant:10],
    [l.bottomAnchor constraintEqualToAnchor:banner.bottomAnchor constant:-10],
    [ack.leadingAnchor constraintEqualToAnchor:l.trailingAnchor constant:12],
    [ack.trailingAnchor constraintEqualToAnchor:banner.trailingAnchor constant:-12],
    [ack.centerYAnchor constraintEqualToAnchor:banner.centerYAnchor],
    [ack.widthAnchor constraintGreaterThanOrEqualToConstant:96],
  ]];
}

- (void)onAcknowledge {
  [UIView animateWithDuration:0.25 animations:^{ self.ackBanner.alpha = 0; }
                   completion:^(BOOL f) { [self.ackBanner removeFromSuperview]; self.ackBanner = nil; }];
}

@end
