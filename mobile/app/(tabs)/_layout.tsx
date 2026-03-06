import { Tabs, router, usePathname } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { clearToken, getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import { useUiSettings } from '@/src/ui/UiSettingsContext';

export default function TabLayout() {
  const { palette, scheme } = useUiSettings();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const tabBaseHeight = 54;

  useEffect(() => {
    let cancelled = false;
    const loadRoles = async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const me = await apiFetch<{ roles: string[] }>("/auth/me", { token });
        if (!cancelled) setRoles(Array.isArray(me.roles) ? me.roles : []);
      } catch (e) {
        if (!isSessionExpiredError(e) && !cancelled) {
          setRoles([]);
        }
      } finally {
        if (!cancelled) setRolesLoaded(true);
      }
    };
    loadRoles().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const roleSet = useMemo(() => new Set(roles), [roles]);
  const isMaintenanceWorker =
    roleSet.has("MAINTENANCE") ||
    roleSet.has("FIELD_WORKER") ||
    roleSet.has("ADMIN");
  const canSeeDraftsSubmissions =
    rolesLoaded && (roleSet.has("FIELD_WORKER") || roleSet.has("REVIEWER") || roleSet.has("ADMIN"));
  const canSeeIncidents =
    !rolesLoaded ||
    roleSet.has("MAINTENANCE") ||
    roleSet.has("MAINT_COORDINATOR") ||
    roleSet.has("OFFICE_CHIEF") ||
    roleSet.has("BRANCH_CHIEF") ||
    roleSet.has("FIELD_WORKER") ||
    roleSet.has("ADMIN");

  const currentTabIndex = useMemo(() => {
    if (pathname?.startsWith("/incidents")) return 0;
    if (pathname === "/drafts") return 1;
    if (pathname === "/submissions") return 2;
    return -1;
  }, [pathname]);
  const isIncidentDetailsRoute = useMemo(() => /\/incidents\/\d+$/.test(pathname || ""), [pathname]);

  const canSwipeTabs = currentTabIndex >= 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuScale = useRef(new Animated.Value(0.92)).current;
  const menuOpacity = useRef(new Animated.Value(0)).current;

  const openMenu = () => {
    setMenuOpen(true);
    Animated.parallel([
      Animated.timing(menuOpacity, { toValue: 1, duration: 170, useNativeDriver: true }),
      Animated.spring(menuScale, { toValue: 1, speed: 20, bounciness: 5, useNativeDriver: true }),
    ]).start();
  };

  const closeMenu = (cb?: () => void) => {
    Animated.parallel([
      Animated.timing(menuOpacity, { toValue: 0, duration: 130, useNativeDriver: true }),
      Animated.timing(menuScale, { toValue: 0.96, duration: 130, useNativeDriver: true }),
    ]).start(() => {
      setMenuOpen(false);
      cb?.();
    });
  };

  const onLogout = () => {
    closeMenu(async () => {
      await clearToken();
      router.replace("/(auth)/login");
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        initialRouteName="incidents/track"
        detachInactiveScreens={false}
        screenOptions={{
          tabBarActiveTintColor: palette.primary,
          headerShown: false,
          lazy: false,
          tabBarHideOnKeyboard: true,
          tabBarButton: HapticTab,
          tabBarStyle: {
            borderTopColor: palette.border,
            backgroundColor: palette.panel,
            height: tabBaseHeight + insets.bottom,
            paddingBottom: Math.max(insets.bottom, 6),
            paddingTop: 6,
          },
          tabBarInactiveTintColor: scheme === "dark" ? "#9fb0cf" : "#7b8da8",
        }}
      >
      <Tabs.Screen
        name="index"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="explore"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="incidents/create"
        options={{
          href: isMaintenanceWorker ? undefined : null,
          title: "Create Incident",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="plus.circle.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="incidents/track"
        options={{
          href: canSeeIncidents ? undefined : null,
          title: "Track Incidents",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="exclamationmark.triangle.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="drafts"
        options={{
          href: canSeeDraftsSubmissions ? undefined : null,
          title: "Drafts",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="doc.text.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="submissions"
        options={{
          href: canSeeDraftsSubmissions ? undefined : null,
          title: "Submissions",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="tray.full.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="incidents/index"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="incidents/[id]"
        options={{
          href: null,
          headerShown: false,
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          href: null,
          title: "Settings",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
      </Tabs>

      {canSwipeTabs && !isIncidentDetailsRoute ? (
        <Pressable
          onPress={openMenu}
          style={[
            styles.profileBtn,
            {
              top: insets.top + 8,
              right: 12,
              backgroundColor: palette.panel,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.profileText, { color: palette.text }]}>Me</Text>
        </Pressable>
      ) : null}

      {menuOpen && !isIncidentDetailsRoute ? (
        <View style={styles.menuBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => closeMenu()} />
          <Animated.View
            style={[
              styles.menuBubble,
              {
                top: insets.top + 50,
                right: 12,
                backgroundColor: palette.panel,
                borderColor: palette.border,
                opacity: menuOpacity,
                transform: [{ scale: menuScale }, { translateY: Animated.multiply(Animated.subtract(1, menuOpacity), -8) }],
              },
            ]}
          >
            <Pressable
              style={[styles.menuItem, { borderBottomColor: palette.border }]}
              onPress={() => closeMenu(() => router.push("/(tabs)/settings"))}
            >
              <Text style={[styles.menuItemText, { color: palette.text }]}>Settings</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={onLogout}>
              <Text style={[styles.menuItemText, { color: "#dc2626" }]}>Logout</Text>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  profileBtn: {
    position: "absolute",
    zIndex: 50,
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  profileText: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 60,
  },
  menuBubble: {
    position: "absolute",
    width: 180,
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
  },
  menuItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: "700",
  },
});
