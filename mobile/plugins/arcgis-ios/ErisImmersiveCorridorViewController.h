#import <UIKit/UIKit.h>

// Immersive offline terrain-inspection corridor (Part 8). Builds a PERSPECTIVE scene
// around the selected cross-section location from ONLY packaged data (the read-only
// elevation grid sampled by the terrain controller, the packaged aerial imagery
// composited for the corridor, the selected road geometry, and the cross-section
// samples). No network, no fabricated buildings/panoramas/signs/vegetation. It is an
// offline aerial-terrain inspection — never a claim of street-level photography.
@interface ErisImmersiveCorridorViewController : UIViewController
- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor;
- (void)resetCameraFraming;
@end
