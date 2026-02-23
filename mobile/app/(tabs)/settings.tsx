import { useRef } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useUiSettings } from "@/src/ui/UiSettingsContext";

function Choice({
  label,
  active,
  onPress,
  palette,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  palette: { border: string; panelSoft: string; primary: string; text: string };
}) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, { borderColor: palette.border, backgroundColor: palette.panelSoft }, active ? [styles.choiceOn, { borderColor: palette.primary }] : null]}>
      <Text style={[styles.choiceText, { color: palette.text }, active ? [styles.choiceTextOn, { color: palette.primary }] : null]}>{label}</Text>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { themeMode, accent, density, setThemeMode, setAccent, setDensity, palette } = useUiSettings();
  const entrance = useRef(new Animated.Value(22)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useRef(() => {
      entrance.setValue(28);
      fade.setValue(0);
      const anim = Animated.parallel([
        Animated.timing(entrance, { toValue: 0, duration: 260, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]);
      anim.start();
      return () => anim.stop();
    }).current
  );

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.container, { backgroundColor: palette.bg }]}>
      <Animated.View style={[{ flex: 1, opacity: fade, transform: [{ translateX: entrance }] }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: palette.text }]}>Display Settings</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>
          Personalize colors and spacing for better field usability.
        </Text>

        <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.text }]}>Theme</Text>
          <View style={styles.row}>
            <Choice label="System" palette={palette} active={themeMode === "system"} onPress={() => setThemeMode("system")} />
            <Choice label="Light" palette={palette} active={themeMode === "light"} onPress={() => setThemeMode("light")} />
            <Choice label="Dark" palette={palette} active={themeMode === "dark"} onPress={() => setThemeMode("dark")} />
          </View>
        </View>

        <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.text }]}>Accent</Text>
          <View style={styles.row}>
            <Choice label="Blue" palette={palette} active={accent === "blue"} onPress={() => setAccent("blue")} />
            <Choice label="Teal" palette={palette} active={accent === "teal"} onPress={() => setAccent("teal")} />
            <Choice label="Amber" palette={palette} active={accent === "amber"} onPress={() => setAccent("amber")} />
          </View>
        </View>

        <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.text }]}>Density</Text>
          <View style={styles.row}>
            <Choice
              label="Comfortable"
              palette={palette}
              active={density === "comfortable"}
              onPress={() => setDensity("comfortable")}
            />
            <Choice label="Compact" palette={palette} active={density === "compact"} onPress={() => setDensity("compact")} />
          </View>
        </View>
      </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 14, gap: 10, paddingBottom: 28 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { marginTop: 2, marginBottom: 6, fontSize: 13 },
  section: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
  },
  sectionTitle: {
    fontWeight: "800",
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  choice: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#c8d5ea",
    backgroundColor: "#f8fbff",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  choiceOn: {
    borderColor: "#1d4ed8",
    backgroundColor: "#dbeafe",
  },
  choiceText: {
    color: "#334155",
    fontWeight: "700",
    fontSize: 12,
  },
  choiceTextOn: {
    color: "#1d4ed8",
  },
});
