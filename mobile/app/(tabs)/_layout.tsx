import { Tabs, router, usePathname } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { clearToken, getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import { getUnread } from "@/src/api/notifications";
import { badgeText } from "@/src/notifications/notificationRoutes";
import { useUiSettings } from '@/src/ui/UiSettingsContext';
import {
  canReportIncident,
  isAssessmentAuthor,
  isOperationalUser,
  isPublicOnly,
  isWorkforceUser,
} from "@/src/utils/roleModel";

export default function TabLayout() {
  const { palette, scheme, componentScale } = useUiSettings();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [roles, setRoles] = useState<string[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const tabBaseHeight = Math.round(54 * componentScale);
  const tabIconSize = Math.round(28 * componentScale);
  const meBtnSize = Math.round(42 * componentScale);

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

  // Every gate below tests the role codes through the shared role model, never
  // a raw string (design §9.3).
  //
  // A read-only (Guest) account holds no operational role, so it matches none
  // of these and keeps only the read-only incident feed below.
  const publicOnly = rolesLoaded && isPublicOnly(roles);
  const isMaintenanceWorker = canReportIncident(roles);
  // The Senior Specialist fills the GISA form exactly as Staff do, so without
  // these two gates a Senior Specialist would see the Assessments tab and
  // nothing it links to.
  const canSeeDraftsSubmissions = rolesLoaded && isAssessmentAuthor(roles);
  // No `!rolesLoaded ||` any more: defaulting to visible flashed the tab into
  // view for an account that must not have it, then emptied it (design §9.1).
  const canSeeIncidents =
    rolesLoaded &&
    (publicOnly || isWorkforceUser(roles));
  // Assessments are for non-maintenance operational users only.
  const canSeeAssessments = rolesLoaded && isOperationalUser(roles);

  const currentTabIndex = useMemo(() => {
    if (pathname?.startsWith("/incidents")) return 0;
    if (pathname === "/drafts") return 1;
    if (pathname === "/submissions") return 2;
    return -1;
  }, [pathname]);
  const isIncidentDetailsRoute = useMemo(() => /\/incidents\/\d+$/.test(pathname || ""), [pathname]);

  // The notification feed's unread count (the same feed as the web portal's
  // bell): refreshed every minute, when the app comes back to the foreground,
  // and on every screen change (so it drops after reading).
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!rolesLoaded || publicOnly) return;
    let cancelled = false;
    const refresh = async () => {
      const token = await getToken();
      if (!token || cancelled) return;
      try {
        const r = await getUnread(token);
        if (!cancelled) setUnread(r.unread);
      } catch {
        // offline or signed out: keep the last count
      }
    };
    refresh().catch(() => {});
    const timer = setInterval(() => { refresh().catch(() => {}); }, 60_000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh().catch(() => {});
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [rolesLoaded, publicOnly, pathname]);
  const unreadBadge = badgeText(unread);

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
            paddingTop: Math.max(6, Math.round(6 * componentScale)),
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
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="plus.circle.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="incidents/track"
        options={{
          href: canSeeIncidents ? undefined : null,
          title: "Track Incidents",
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="exclamationmark.triangle.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="assessments/index"
        options={{
          href: canSeeAssessments ? undefined : null,
          title: "Assessments",
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="checkmark.seal.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="drafts"
        options={{
          href: canSeeDraftsSubmissions ? undefined : null,
          title: "Drafts",
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="doc.text.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="submissions"
        options={{
          href: canSeeDraftsSubmissions ? undefined : null,
          title: "Submissions",
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="tray.full.fill" color={color} />,
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
          tabBarIcon: ({ color }) => <IconSymbol size={tabIconSize} name="gearshape.fill" color={color} />,
        }}
      />

      <Tabs.Screen
        name="road-inventory"
        options={{
          href: null,
          title: "Road Inventory",
        }}
      />

      <Tabs.Screen
        name="notifications"
        options={{
          href: null,
          title: "Notifications",
        }}
      />
      </Tabs>

      {canSwipeTabs && !isIncidentDetailsRoute && rolesLoaded && !publicOnly ? (
        <Pressable
          onPress={() => router.push("/(tabs)/notifications" as any)}
          accessibilityLabel={unreadBadge ? `Notifications, ${unread} unread` : "Notifications"}
          style={[
            styles.profileBtn,
            {
              top: insets.top + 8,
              right: 12 + meBtnSize + 8,
              width: meBtnSize,
              height: meBtnSize,
              borderRadius: Math.round(meBtnSize / 2),
              backgroundColor: palette.panel,
              borderColor: palette.border,
            },
          ]}
        >
          <IconSymbol size={Math.round(meBtnSize * 0.5)} name="bell.fill" color={palette.text} />
          {unreadBadge ? (
            <View style={[styles.badge, { backgroundColor: palette.danger }]}>
              <Text style={styles.badgeText}>{unreadBadge}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}

      {canSwipeTabs && !isIncidentDetailsRoute ? (
        <Pressable
          onPress={openMenu}
          style={[
            styles.profileBtn,
            {
              top: insets.top + 8,
              right: 12,
              width: meBtnSize,
              height: meBtnSize,
              borderRadius: Math.round(meBtnSize / 2),
              backgroundColor: palette.panel,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.profileText, { color: palette.text, fontSize: Math.round(13 * componentScale) }]}>Me</Text>
        </Pressable>
      ) : null}

      {menuOpen && !isIncidentDetailsRoute ? (
        <View style={styles.menuBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => closeMenu()} />
          <Animated.View
            style={[
              styles.menuBubble,
              {
                top: insets.top + Math.round(50 * componentScale),
                right: 12,
                backgroundColor: palette.panel,
                borderColor: palette.border,
                opacity: menuOpacity,
                transform: [{ scale: menuScale }, { translateY: Animated.multiply(Animated.subtract(1, menuOpacity), -8) }],
              },
            ]}
          >
            {!publicOnly ? (
              <Pressable
                style={[styles.menuItem, { borderBottomColor: palette.border }]}
                onPress={() => closeMenu(() => router.push("/(tabs)/notifications" as any))}
              >
                <Text style={[styles.menuItemText, { color: palette.text }]}>
                  Notifications{unread ? ` (${unread})` : ""}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.menuItem, { borderBottomColor: palette.border }]}
              onPress={() => closeMenu(() => router.push("/(tabs)/settings"))}
            >
              <Text style={[styles.menuItemText, { color: palette.text }]}>Settings</Text>
            </Pressable>
            <Pressable
              style={[styles.menuItem, { borderBottomColor: palette.border }]}
              onPress={() => closeMenu(() => router.push("/(tabs)/road-inventory"))}
            >
              <Text style={[styles.menuItemText, { color: palette.text }]}>Road Inventory</Text>
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
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
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
