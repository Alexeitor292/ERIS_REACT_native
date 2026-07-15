#import <UIKit/UIKit.h>

// Road-inspection container (Part 9). Hosts a prominent Immersive | Technical segmented
// control and swaps between two child controllers that consume the SAME immutable slice
// model: the immersive perspective corridor (default) and the existing technical
// orthographic cutaway. Switching modes preserves the selected location, road candidate,
// samples, and roadway-layout source. Fully offline.
@interface ErisInspectionViewController : UIViewController
- (instancetype)initWithSlice:(NSDictionary *)slice corridor:(NSDictionary *)corridor;
@end
