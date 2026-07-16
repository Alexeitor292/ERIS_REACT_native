#import <UIKit/UIKit.h>

// Road-inspection container (Part 9). Hosts a prominent Immersive | Technical segmented
// control and swaps between two child controllers that consume the SAME immutable slice
// model: the immersive perspective corridor (default) and the existing technical
// orthographic cutaway. Switching modes preserves the selected location, road candidate,
// samples, and roadway-layout source. Fully offline.
@interface ErisInspectionViewController : UIViewController
// `inspectionGeometry` is the ONE immutable divided-corridor model built by the terrain
// controller (nil for non-divided roads). It is handed unchanged to BOTH children so
// neither can reproject the station or derive a different section.
// `provenance` is the ONE immutable provenance record assembled by the terrain controller
// from the real corridor/model values. This view renders it verbatim and derives nothing.
- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor
           inspectionGeometry:(NSDictionary *)inspectionGeometry
                   provenance:(NSDictionary *)provenance;
@end
