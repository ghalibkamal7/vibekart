import { AntDesign, Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isFirebaseConfigured } from '@/services/firebase/config';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

// Mobile OTP sign-in is temporarily hidden from this screen. Nothing behind
// it was removed: sendPhoneOtp / verifyPhoneOtp still exist in StoreContext,
// requestPhoneOtp / confirmPhoneOtp still exist in services/firebase/auth.ts,
// and the Cloudflare Worker in workers/otp/ is untouched — restoring OTP
// later means re-adding the phone tab to this screen, not rebuilding it.

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signUpEmail, signInEmail, signInWithGoogle, continueAsGuest, authError } = useStore();

  const [emailMode, setEmailMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [emailPhone, setEmailPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [googleError, setGoogleError] = useState('');

  const handleGoogle = async () => {
    setGoogleError('');
    setLocalError('');
    setBusy(true);
    try {
      await signInWithGoogle();
      router.replace('/(tabs)');
    } catch (error) {
      // The thrown error already carries a user-friendly message
      // (see friendlyAuthMessage in services/firebase/auth.ts).
      setGoogleError(error instanceof Error ? error.message : "We couldn't sign you in with Google. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSubmit = async () => {
    setLocalError('');
    setGoogleError('');
    if (!email.trim() || password.length < 6) {
      setLocalError('Enter a valid email and a password of at least 6 characters');
      return;
    }
    if (emailMode === 'signup' && !name.trim()) {
      setLocalError('Enter your name');
      return;
    }
    setBusy(true);
    try {
      if (emailMode === 'signup') {
        await signUpEmail({ email: email.trim(), password, name: name.trim(), phone: emailPhone.trim() || undefined });
      } else {
        await signInEmail(email.trim(), password);
      }
      router.replace('/(tabs)');
    } catch {
      // authError already carries the message
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.screen, { backgroundColor: colors.moss, paddingTop: insets.top + 40 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brandRow}>
        <Image source={require('@/assets/images/icon.png')} style={styles.logo} />
        <Text style={styles.brand}>VibeKart</Text>
      </View>
      <Text style={styles.tagline}>Good things, curated at your price.</Text>

      {!isFirebaseConfigured ? (
        <View style={[styles.demoNote, { backgroundColor: colors.coralSoft }]}>
          <Feather name="info" size={14} color={colors.coral} />
          <Text style={[styles.demoNoteText, { color: colors.foreground }]}>
            Firebase isn't configured yet (see .env) — you can only browse as a guest for now.
          </Text>
        </View>
      ) : (
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          <Pressable
            onPress={handleGoogle}
            disabled={busy}
            style={[
              styles.googleButton,
              { backgroundColor: colors.card, borderColor: colors.moss, opacity: busy ? 0.7 : 1 },
            ]}
            testID="google-signin"
          >
            {busy ? (
              <ActivityIndicator color={colors.moss} />
            ) : (
              <>
                <AntDesign name="google" size={19} color={colors.foreground} />
                <Text style={[styles.googleButtonText, { color: colors.foreground }]}>Continue with Google</Text>
              </>
            )}
          </Pressable>
          {googleError ? <Text style={[styles.error, { color: colors.destructive }]}>{googleError}</Text> : null}

          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>OR</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
          </View>

          <View style={[styles.tabRow, { backgroundColor: colors.card, borderColor: colors.border, marginBottom: 16 }]}>
            <Pressable onPress={() => setEmailMode('signin')} style={[styles.tab, emailMode === 'signin' && { backgroundColor: colors.moss }]}>
              <Text style={[styles.tabText, { color: emailMode === 'signin' ? '#FFFFFF' : colors.mutedForeground }]}>Sign in</Text>
            </Pressable>
            <Pressable onPress={() => setEmailMode('signup')} style={[styles.tab, emailMode === 'signup' && { backgroundColor: colors.moss }]}>
              <Text style={[styles.tabText, { color: emailMode === 'signup' ? '#FFFFFF' : colors.mutedForeground }]}>Sign up</Text>
            </Pressable>
          </View>

          {emailMode === 'signup' ? (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>Name</Text>
              <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.mutedForeground} style={[styles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]} />
              <Text style={[styles.label, { color: colors.foreground }]}>Mobile number (optional)</Text>
              <TextInput value={emailPhone} onChangeText={setEmailPhone} keyboardType="phone-pad" maxLength={10} placeholder="98765 43210" placeholderTextColor={colors.mutedForeground} style={[styles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]} />
            </>
          ) : null}

          <Text style={[styles.label, { color: colors.foreground }]}>Email</Text>
          <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" placeholderTextColor={colors.mutedForeground} style={[styles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Password</Text>
          <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 6 characters" placeholderTextColor={colors.mutedForeground} style={[styles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]} />

          {localError || authError ? (
            <Text style={[styles.error, { color: colors.destructive }]}>{localError || authError}</Text>
          ) : null}

          <Pressable onPress={handleEmailSubmit} disabled={busy} style={[styles.primaryButton, { backgroundColor: colors.coral, opacity: busy ? 0.7 : 1 }]}>
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Text style={styles.primaryButtonText}>{emailMode === 'signup' ? 'Create Account' : 'Sign in'}</Text>
                <Feather name="arrow-right" size={17} color="#FFFFFF" />
              </>
            )}
          </Pressable>
        </View>
      )}

      <Pressable
        onPress={() => {
          continueAsGuest();
          router.replace('/(tabs)');
        }}
        style={styles.guestButton}
      >
        <Text style={styles.guestText}>Continue as Guest</Text>
        <Feather name="arrow-right" size={15} color="#FFFFFF" />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 42, height: 42, borderRadius: 14 },
  brand: { color: '#FFFFFF', fontSize: 24, fontFamily: 'Inter_700Bold', letterSpacing: -1 },
  tagline: { color: '#DCEBE5', fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 10, maxWidth: 280 },
  card: { borderRadius: 24, padding: 22, marginTop: 32 },
  googleButton: { height: 54, borderRadius: 16, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  googleButtonText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 20 },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  tabRow: { flexDirection: 'row', borderWidth: 1, borderRadius: 13, padding: 4, marginBottom: 18 },
  tab: { flex: 1, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  label: { fontSize: 12, fontFamily: 'Inter_700Bold', marginBottom: 8, marginTop: 12 },
  input: { height: 50, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontSize: 14, fontFamily: 'Inter_500Medium' },
  error: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 10 },
  primaryButton: { height: 52, borderRadius: 16, marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Inter_700Bold' },
  demoNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 16, padding: 14, marginTop: 32 },
  demoNoteText: { flex: 1, fontSize: 12, lineHeight: 17, fontFamily: 'Inter_500Medium' },
  guestButton: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 8, marginTop: 30 },
  guestText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_600SemiBold', textDecorationLine: 'underline' },
});