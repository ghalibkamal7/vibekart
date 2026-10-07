import React, { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StoreProvider, useStore } from '@/context/StoreContext';

// Prevent the splash screen from auto-hiding before asset loading is
// complete. This is a no-op-ish call on web; guarded with .catch() (not
// try/catch, since this returns a Promise) so a rejection here — which
// would otherwise be an unhandled promise rejection — is logged instead of
// silent, and never blocks anything downstream.
SplashScreen.preventAutoHideAsync().catch((error) => {
  console.warn('[splash] preventAutoHideAsync failed (safe to ignore on web)', error);
});

const queryClient = new QueryClient();

// Shown instead of a bare `return null` for both startup gates below (font
// loading, and auth-state resolution). The point isn't the visual — it's
// that a refresh, a slow connection, or a Firebase hiccup shows *something*
// branded rather than a blank white page indefinitely.
function StartupLoadingScreen() {
  return (
    <View style={styles.loadingScreen}>
      <Image source={require('@/assets/images/icon.png')} style={styles.loadingLogo} />
      <ActivityIndicator color="#FFFFFF" style={styles.loadingSpinner} />
    </View>
  );
}

function RootLayoutNav() {
  const { authLoaded } = useStore();

  // authLoaded is guaranteed to resolve (see context/StoreContext.tsx's
  // auth effect — every path through it ends in a `finally { setAuthLoaded
  // (true) }`), so this is a brief loading state, never a permanent one.
  //
  // This layout deliberately does NOT redirect based on authUser. It used
  // to (`if (!authUser) return <Redirect href="/login" />`), but that ran
  // on every render of this Stack — including while already ON /login —
  // which Expo Router turned into a rapid repeated navigation (Chrome's
  // "Throttling navigation to prevent the browser from hanging"). Route
  // -level protection now lives in app/(tabs)/_layout.tsx instead, so
  // /login is just a normal, unprotected screen in this Stack and never
  // redirects to itself.
  if (!authLoaded) return <StartupLoadingScreen />;

  return (
    <Stack screenOptions={{ headerBackTitle: 'Back', headerShown: false }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="product/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="cart" options={{ presentation: 'modal' }} />
      <Stack.Screen name="checkout" options={{ presentation: 'modal' }} />
      <Stack.Screen name="seller" options={{ presentation: 'card' }} />
      <Stack.Screen name="seller-add-product" options={{ presentation: 'modal' }} />
      <Stack.Screen name="seller-orders" options={{ presentation: 'card' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Belt-and-suspenders: useFonts should settle almost instantly (these are
  // bundled assets, not a network fetch), but this file's whole job is to
  // make sure nothing can gate the app open-endedly. A cold Metro dev-server
  // bundle (the "Bundler cache is empty, rebuilding" case) can genuinely
  // take a few seconds to serve font assets for the first time, so this is
  // generous rather than tight — if fonts truly never settle for some other
  // reason, proceed anyway rather than sit on a blank screen forever.
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      console.warn('[fonts] timed out waiting for custom fonts — proceeding with system fallback');
      setFontsTimedOut(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  const fontsSettled = fontsLoaded || Boolean(fontError) || fontsTimedOut;

  useEffect(() => {
    if (fontsSettled) {
      SplashScreen.hideAsync().catch((error) => {
        console.warn('[splash] hideAsync failed (safe to ignore on web)', error);
      });
    }
  }, [fontsSettled]);

  if (fontError) {
    console.warn('[fonts] useFonts reported an error — proceeding with system fallback', fontError);
  }

  if (!fontsSettled) return <StartupLoadingScreen />;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <StoreProvider>
            <GestureHandlerRootView>
              <KeyboardProvider>
                <RootLayoutNav />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </StoreProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#315A51' },
  loadingLogo: { width: 72, height: 72, borderRadius: 20 },
  loadingSpinner: { marginTop: 18 },
});