#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArcGisSketchStore : NSObject

+ (nullable NSString *)latestGeoJson;
+ (void)setLatestGeoJson:(nullable NSString *)value;

+ (nullable NSString *)mmpkPath;
+ (void)setMmpkPath:(nullable NSString *)value;

+ (nullable NSString *)initialEsriJson;
+ (void)setInitialEsriJson:(nullable NSString *)value;

+ (nullable NSNumber *)initialLatitude;
+ (void)setInitialLatitude:(nullable NSNumber *)value;

+ (nullable NSNumber *)initialLongitude;
+ (void)setInitialLongitude:(nullable NSNumber *)value;

@end

NS_ASSUME_NONNULL_END
