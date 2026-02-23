import React, { useEffect } from "react";
import { Dimensions, Image, StyleSheet, Text } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

type AnimatedSplashProps = {
  onDone: () => void;
};

const { width } = Dimensions.get("window");
const LOGO_SIZE = Math.min(220, width * 0.54);

export default function AnimatedSplash({ onDone }: AnimatedSplashProps) {
  const scale = useSharedValue(6);
  const logoOpacity = useSharedValue(1);
  const erisOpacity = useSharedValue(0);
  const containerOpacity = useSharedValue(1);

  useEffect(() => {
    scale.value = withTiming(1, {
      duration: 900,
      easing: Easing.out(Easing.cubic),
    });

    erisOpacity.value = withDelay(
      460,
      withTiming(1, { duration: 420, easing: Easing.out(Easing.quad) })
    );

    logoOpacity.value = withDelay(
      950,
      withTiming(1, { duration: 0 })
    );

    const doneTimer = setTimeout(() => {
      containerOpacity.value = withTiming(0, { duration: 260 }, (finished) => {
        if (finished) {
          runOnJS(onDone)();
        }
      });
    }, 1750);

    return () => clearTimeout(doneTimer);
  }, [containerOpacity, erisOpacity, logoOpacity, onDone, scale]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: scale.value }],
  }));

  const erisStyle = useAnimatedStyle(() => ({
    opacity: erisOpacity.value,
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.container, containerStyle]}>
      <Animated.View style={[styles.logoWrap, logoStyle]}>
        <Image
          source={require("../../assets/images/splash-icon.png")}
          resizeMode="contain"
          style={styles.logo}
        />
      </Animated.View>
      <Animated.View style={[styles.textWrap, erisStyle]}>
        <Text style={styles.eris}>ERIS</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 9999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#04132d",
  },
  logoWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
  textWrap: {
    marginTop: 12,
    alignItems: "center",
  },
  eris: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 2.4,
  },
});
