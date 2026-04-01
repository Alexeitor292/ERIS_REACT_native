#import "ArcGisPencilSketchViewController.h"

#import <PencilKit/PencilKit.h>

#import "ArcGisSketchStore.h"

@interface ArcGisPencilSketchViewController ()

@property(nonatomic, strong) PKCanvasView *canvasView;
@property(nonatomic, strong) PKToolPicker *toolPicker;
@property(nonatomic, assign) BOOL hasNotifiedClose;

@end

@implementation ArcGisPencilSketchViewController

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = [UIColor systemBackgroundColor];
  self.title = @"Sketchpad";
  self.hasNotifiedClose = NO;

  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:@"Cancel"
                                       style:UIBarButtonItemStylePlain
                                      target:self
                                      action:@selector(onCancel)];
  self.navigationItem.rightBarButtonItems = @[
    [[UIBarButtonItem alloc] initWithTitle:@"Clear"
                                     style:UIBarButtonItemStylePlain
                                    target:self
                                    action:@selector(onClear)],
    [[UIBarButtonItem alloc] initWithTitle:@"Save"
                                     style:UIBarButtonItemStyleDone
                                    target:self
                                    action:@selector(onDone)]
  ];

  self.canvasView = [[PKCanvasView alloc] initWithFrame:CGRectZero];
  self.canvasView.translatesAutoresizingMaskIntoConstraints = NO;
  self.canvasView.backgroundColor = [UIColor whiteColor];
  self.canvasView.drawingPolicy = PKCanvasViewDrawingPolicyAnyInput;
  self.canvasView.alwaysBounceVertical = NO;
  self.canvasView.alwaysBounceHorizontal = NO;
  self.canvasView.minimumZoomScale = 1.0;
  self.canvasView.maximumZoomScale = 1.0;
  self.canvasView.tool = [[PKInkingTool alloc] initWithInkType:PKInkTypePen
                                                         color:[UIColor blackColor]
                                                         width:5.0];

  [self.view addSubview:self.canvasView];
  UILayoutGuide *guide = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.canvasView.topAnchor constraintEqualToAnchor:guide.topAnchor],
    [self.canvasView.leadingAnchor constraintEqualToAnchor:guide.leadingAnchor],
    [self.canvasView.trailingAnchor constraintEqualToAnchor:guide.trailingAnchor],
    [self.canvasView.bottomAnchor constraintEqualToAnchor:guide.bottomAnchor],
  ]];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];

  if (@available(iOS 14.0, *)) {
    self.toolPicker = [[PKToolPicker alloc] init];
  } else {
    self.toolPicker = [PKToolPicker sharedToolPickerForWindow:self.view.window];
  }

  [self.toolPicker setVisible:YES forFirstResponder:self.canvasView];
  [self.toolPicker addObserver:self.canvasView];
  [self.canvasView becomeFirstResponder];
}

- (void)viewDidDisappear:(BOOL)animated {
  [super viewDidDisappear:animated];
  if (self.toolPicker != nil) {
    [self.toolPicker setVisible:NO forFirstResponder:self.canvasView];
    [self.toolPicker removeObserver:self.canvasView];
  }
}

- (void)onClear {
  self.canvasView.drawing = [[PKDrawing alloc] init];
}

- (void)onCancel {
  [self dismissAndNotify];
}

- (void)onDone {
  if (self.canvasView.drawing.strokes.count == 0) {
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"No sketch yet"
                                            message:@"Draw a sketch before saving."
                                     preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK"
                                              style:UIAlertActionStyleDefault
                                            handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
    return;
  }

  UIImage *image = [self imageFromCurrentDrawing];
  NSData *pngData = UIImagePNGRepresentation(image);
  if (pngData == nil || pngData.length == 0) {
    [self showSaveError:@"Could not create sketch image."];
    return;
  }

  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *cachesDir = [[fm URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  NSURL *targetDir = [cachesDir URLByAppendingPathComponent:@"gisa-sketches" isDirectory:YES];
  NSError *dirError = nil;
  [fm createDirectoryAtURL:targetDir withIntermediateDirectories:YES attributes:nil error:&dirError];
  if (dirError != nil) {
    [self showSaveError:(dirError.localizedDescription ?: @"Could not create sketch cache directory.")];
    return;
  }

  NSString *fileName = [NSString stringWithFormat:@"gisa-sketch-%@.png", [[NSUUID UUID] UUIDString]];
  NSURL *targetFile = [targetDir URLByAppendingPathComponent:fileName];
  NSError *writeError = nil;
  if (![pngData writeToURL:targetFile options:NSDataWritingAtomic error:&writeError]) {
    [self showSaveError:(writeError.localizedDescription ?: @"Could not save sketch image.")];
    return;
  }

  [ArcGisSketchStore setLatestSketchImagePath:targetFile.absoluteString];
  [self dismissAndNotify];
}

- (UIImage *)imageFromCurrentDrawing {
  CGRect bounds = self.canvasView.bounds;
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.opaque = YES;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithBounds:bounds format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *_Nonnull context) {
    [[UIColor whiteColor] setFill];
    [context fillRect:bounds];
    UIImage *drawingImage = [self.canvasView.drawing imageFromRect:bounds scale:UIScreen.mainScreen.scale];
    [drawingImage drawInRect:bounds];
  }];
}

- (void)showSaveError:(NSString *)message {
  UIAlertController *alert =
      [UIAlertController alertControllerWithTitle:@"Save failed"
                                          message:message
                                   preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"OK"
                                            style:UIAlertActionStyleDefault
                                          handler:nil]];
  [self presentViewController:alert animated:YES completion:nil];
}

- (void)dismissAndNotify {
  [self dismissViewControllerAnimated:YES
                           completion:^{
                             [self notifyClosedOnce];
                           }];
}

- (void)notifyClosedOnce {
  if (self.hasNotifiedClose) {
    return;
  }
  self.hasNotifiedClose = YES;
  if (self.onClose != nil) {
    self.onClose();
  }
}

@end
