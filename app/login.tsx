import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isFirebaseConfigured } from '@/services/firebase/config';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

type Method = 'phone' | 'email';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sendPhoneOtp, verifyPhoneOtp, signUpEmail, signInEmail, continueAsGuest, authError } = useStore();

  const [method, setMethod] = useState<Method>('phone');

  // phone-otp state
  const [phoneStep, setPhoneStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');

  // email state
  const [emailMode, setEmailMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [emailPhone, setEmailPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleSendOtp = async () => {
    setLocalError('');
    if (phone.trim().length !== 10) {
      setLocalError('Enter a valid 10-digit mobile number');
      return;
    }
    setBusy(true);
    try {
      await sendPhoneOtp(phone.trim());
      setPhoneStep('otp');
    } catch {
      // authError already carries the message
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async () => {
    setLocalError('');
    if (otp.trim().length !== 4) {
      setLocalError('Enter the 4-digit OTP');
      return;
    }
    setBusy(true);
    try {
      await verifyPhoneOtp(phone.trim(), otp.trim());
      router.replace('/(tabs)');
    } catch {
      // authError already carries the message
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSubmit = async () => {
    setLocalError('');
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
          <View style={[styles.tabRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Pressable
              onPress={() => {
                setMethod('phone');
                setLocalError('');
              }}
              style={[styles.tab, method === 'phone' && { backgroundColor: colors.moss }]}
            >
              <Text style={[styles.tabText, { color: method === 'phone' ? '#FFFFFF' : colors.mutedForeground }]}>Mobile OTP</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setMethod('email');
                setLocalError('');
              }}
              style={[styles.tab, method === 'email' && { backgroundColor: colors.moss }]}
            >
              <Text style={[styles.tabText, { color: method === 'email' ? '#FFFFFF' : colors.mutedForeground }]}>Email</Text>
            </Pressable>
          </View>

          {method === 'phone' ? (
            phoneStep === 'phone' ? (
              <>
                <Text style={[styles.label, { color: colors.foreground }]}>Mobile number</Text>
                <View style={[styles.phoneRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
                  <Text style={[styles.prefix, { color: colors.mutedForeground }]}>+91</Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    maxLength={10}
                    placeholder="98765 43210"
                    placeholderTextColor={colors.mutedForeground}
                    style={[styles.phoneInput, { color: colors.foreground }]}
                  />
                </View>
                {localError || authError ? (
                  <Text style={[styles.error, { color: colors.destructive }]}>{localError || authError}</Text>
                ) : null}
                <Pressable onPress={handleSendOtp} disabled={busy} style={[styles.primaryButton, { backgroundColor: colors.coral, opacity: busy ? 0.7 : 1 }]}>
                  {busy ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Send OTP</Text>
                      <Feather name="arrow-right" size={17} color="#FFFFFF" />
                    </>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.label, { color: colors.foreground }]}>OTP sent to +91 {phone}</Text>
                <View style={[styles.phoneRow, { borderColor: colors.border, backgroundColor: colors.card, justifyContent: 'center' }]}>
                  <TextInput
                    value={otp}
                    onChangeText={setOtp}
                    keyboardType="number-pad"
                    maxLength={4}
                    placeholder="4-digit OTP"
                    placeholderTextColor={colors.mutedForeground}
                    style={[styles.phoneInput, { color: colors.foreground, textAlign: 'center', letterSpacing: 6 }]}
                  />
                </View>
                {localError || authError ? (
                  <Text style={[styles.error, { color: colors.destructive }]}>{localError || authError}</Text>
                ) : null}
                <Pressable onPress={handleVerifyOtp} disabled={busy} style={[styles.primaryButton, { backgroundColor: colors.coral, opacity: busy ? 0.7 : 1 }]}>
                  {busy ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Verify &amp; continue</Text>
                      <Feather name="check" size={17} color="#FFFFFF" />
                    </>
                  )}
                </Pressable>
                <Pressable onPress={() => { setPhoneStep('phone'); setOtp(''); setLocalError(''); }} hitSlop={10} style={{ marginTop: 12, alignSelf: 'center' }}>
                  <Text style={[styles.linkText, { color: colors.moss }]}>Change number</Text>
                </Pressable>
              </>
            )
          ) : (
            <>
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
            </>
          )}
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
  tabRow: { flexDirection: 'row', borderWidth: 1, borderRadius: 13, padding: 4, marginBottom: 18 },
  tab: { flex: 1, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  label: { fontSize: 12, fontFamily: 'Inter_700Bold', marginBottom: 8, marginTop: 12 },
  input: { height: 50, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontSize: 14, fontFamily: 'Inter_500Medium' },
  phoneRow: { flexDirection: 'row', alignItems: 'center', height: 52, borderWidth: 1, borderRadius: 15, paddingHorizontal: 14, gap: 8 },
  prefix: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  phoneInput: { flex: 1, fontSize: 15, fontFamily: 'Inter_500Medium' },
  error: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 10 },
  primaryButton: { height: 52, borderRadius: 16, marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Inter_700Bold' },
  linkText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  demoNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 16, padding: 14, marginTop: 32 },
  demoNoteText: { flex: 1, fontSize: 12, lineHeight: 17, fontFamily: 'Inter_500Medium' },
  guestButton: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 8, marginTop: 30 },
  guestText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_600SemiBold', textDecorationLine: 'underline' },
});