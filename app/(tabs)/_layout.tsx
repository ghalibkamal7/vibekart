import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Redirect, Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

// NOTE: an earlier version of this file switched to expo-router's
// experimental `NativeTabs` (expo-router/unstable-native-tabs) for the iOS-26
// "Liquid Glass" tab bar look. That module's web build pulls in @radix-ui
// packages whose versions don't resolve together, which broke web bundling
// entirely (and Expo Router's route scanner requires this file even when a
// platform-specific override exists, so a `.web.tsx` override alone doesn't
// avoid it). Sticking to the classic <Tabs> component below works reliably
// on iOS, Android, and web.
//
// This file — not the root layout — owns the "must be signed in (or
// browsing as guest) to see the app" redirect. The root layout unconditionally
// redirecting to /login was firing even while already ON /login (any render
// of the root Stack re-evaluated it), which Expo Router/React Navigation
// turned into a rapid repeated navigation — Chrome's "Throttling navigation
// to prevent the browser from hanging". Gating at the (tabs) route instead
// means /login only ever gets navigated to when someone actually lands on a
// tabs route without a session — never redirected to itself.
export default function TabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const { authUser, authLoaded } = useStore();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  // In practice the root layout already waits for authLoaded before
  // rendering the Stack that contains this screen, so this almost never
  // shows — it's a defensive fallback, not the primary loading state.
  if (!authLoaded) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.moss} />
      </View>
    );
  }

  // No session at all (not even guest) → this is the one place that sends
  // someone to /login, and only when they're actually trying to view a
  // protected tab, not on every render of the root Stack.
  if (!authUser) return <Redirect href="/login" />;

  // Guest sessions ({ isGuest: true }) and real signed-in users both reach
  // here and see the tabs normally — guest browsing is intentionally
  // supported, not a blocked state.

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={100} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) =>
            isIOS ? <SymbolView name="house" tintColor={color} size={24} /> : <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{ title: 'Explore', tabBarIcon: ({ color }) => <Feather name="compass" size={22} color={color} /> }}
      />
      <Tabs.Screen
        name="orders"
        options={{ title: 'Orders', tabBarIcon: ({ color }) => <Feather name="package" size={22} color={color} /> }}
      />
      <Tabs.Screen
        name="account"
        options={{ title: 'Account', tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});