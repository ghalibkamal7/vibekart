import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export function PwaInstallBanner() {
  const colors = useColors();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    // Check if already installed / running in standalone mode
    const isStandaloneMode =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    if (isStandaloneMode) {
      setIsStandalone(true);
      return;
    }

    // Check if iOS Safari
    const ua = window.navigator.userAgent;
    const isIosDevice = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
    const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(ua);
    if (isIosDevice && isSafari) {
      setIsIOS(true);
    }

    // Capture the PWA install prompt event on Chromium/Android/Desktop
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // Detect when the app is installed
    const handleAppInstalled = () => {
      setIsStandalone(true);
      setDeferredPrompt(null);
    };
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  if (Platform.OS !== 'web' || isStandalone || isDismissed) {
    return null;
  }

  // Only show if we either have a genuine install prompt or are on iOS Safari
  if (!deferredPrompt && !isIOS) {
    return null;
  }

  const handleInstallClick = async () => {
    if (!deferredPrompt) {
      if (isIOS) {
        setShowIOSInstructions((prev) => !prev);
      }
      return;
    }

    try {
      await deferredPrompt.prompt();
      const choiceResult = await deferredPrompt.userChoice;
      if (choiceResult.outcome === 'accepted') {
        setIsStandalone(true);
      }
      setDeferredPrompt(null);
    } catch (err) {
      console.warn('[PWA] Install prompt failed:', err);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.mossSoft, borderColor: colors.moss }]}>
      <View style={styles.contentRow}>
        <View style={[styles.iconWrap, { backgroundColor: colors.moss }]}>
          <Feather name="download" size={16} color="#FFFFFF" />
        </View>
        <View style={styles.textWrap}>
          <Text style={[styles.title, { color: colors.foreground }]}>Install VibeKart</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Install our web app for faster shopping & offline access.
          </Text>
        </View>

        <Pressable
          onPress={handleInstallClick}
          style={[styles.installButton, { backgroundColor: colors.moss }]}
        >
          <Text style={styles.installButtonText}>
            {isIOS ? (showIOSInstructions ? 'Hide' : 'How to Install') : 'Install'}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setIsDismissed(true)}
          hitSlop={8}
          style={styles.closeButton}
          accessibilityLabel="Dismiss install banner"
        >
          <Feather name="x" size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {isIOS && showIOSInstructions ? (
        <View style={[styles.iosBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.iosTitle, { color: colors.foreground }]}>To install on iPhone/iPad:</Text>
          <Text style={[styles.iosStep, { color: colors.mutedForeground }]}>
            1. Tap the <Text style={{ fontWeight: '700' }}>Share</Text> button (square with arrow) at the bottom of Safari.
          </Text>
          <Text style={[styles.iosStep, { color: colors.mutedForeground }]}>
            2. Scroll down and tap <Text style={{ fontWeight: '700' }}>Add to Home Screen</Text>.
          </Text>
          <Text style={[styles.iosStep, { color: colors.mutedForeground }]}>
            3. Tap <Text style={{ fontWeight: '700' }}>Add</Text> in the top right.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginVertical: 10,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
  },
  title: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  subtitle: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
    lineHeight: 14,
  },
  installButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  installButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
  },
  closeButton: {
    padding: 4,
    marginLeft: 2,
  },
  iosBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  iosTitle: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  iosStep: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    lineHeight: 15,
  },
});
