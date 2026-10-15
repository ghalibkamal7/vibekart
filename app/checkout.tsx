import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buildUpiQrUrl, buildUpiUri, formatPrice } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { fetchPaymentConfigViaWorker } from '@/services/firebase/firestore';

/**
 * DIRECT GOOGLE PAY INDIA (UPI) CONFIGURATION
 *
 * Supports both:
 * 1. Admin self-service UPI configuration (via Admin Panel "Payment Settings")
 * 2. Server-authoritative automated acquiring bank PSP API integration
 *
 * If neither is configured, checkout gracefully displays a clear "Payment setup pending"
 * state and disables order placement.
 */
const PAYMENT_CONFIGURED = process.env.EXPO_PUBLIC_PAYMENT_GATEWAY_CONFIGURED === 'true';
const MERCHANT_NAME = process.env.EXPO_PUBLIC_MERCHANT_NAME || 'VibeKart';

export default function CheckoutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { cart, cartTotal, placeOrder, authUser, paymentSettings } = useStore();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [customerUtr, setCustomerUtr] = useState('');
  const [placing, setPlacing] = useState(false);
  const [copiedVpa, setCopiedVpa] = useState(false);
  const [paymentConfig, setPaymentConfig] = useState<{
    gpayEnabled: boolean;
    status: string;
    merchantName?: string;
  } | null>(null);

  useEffect(() => {
    fetchPaymentConfigViaWorker()
      .then((cfg) => setPaymentConfig(cfg))
      .catch(() => {});
  }, []);

  const hasItems = cart.length > 0;
  const allInStock = cart.every((line) => line.product.inStock && (line.product.enabled ?? true));
  const fieldsOk = name.trim() && address.trim() && phone.trim();

  // Self-service manual UPI readiness from Admin Panel
  const manualUpiReady = Boolean(paymentSettings.enabled && paymentSettings.merchantVpa?.trim());

  // Payment is ready if manual UPI is configured or automated server PSP is configured
  const paymentReady = manualUpiReady || (paymentConfig ? paymentConfig.gpayEnabled : PAYMENT_CONFIGURED);
  const canPlace = !placing && hasItems && allInStock && !!fieldsOk && paymentReady;

  const activeMerchantName = paymentSettings.merchantName?.trim() || paymentConfig?.merchantName || MERCHANT_NAME;
  const activeMerchantVpa = paymentSettings.merchantVpa?.trim() || '';
  const qrDisplayUrl = paymentSettings.qrImageUrl || (paymentSettings.autoGenerateQr && activeMerchantVpa ? buildUpiQrUrl(activeMerchantVpa, activeMerchantName, cartTotal) : '');

  const handlePlaceOrder = async () => {
    if (!paymentReady) {
      Alert.alert(
        'Payment not available',
        'Online payment setup is pending. The store owner needs to configure UPI payment settings in the Admin Panel before orders can be placed.',
      );
      return;
    }
    if (!hasItems) {
      Alert.alert('Empty cart', 'Your cart is empty. Add items before placing an order.');
      return;
    }
    if (!allInStock) {
      Alert.alert(
        'Item unavailable',
        'One or more items in your cart are out of stock or no longer available. Please remove them and try again.',
      );
      return;
    }
    setPlacing(true);
    try {
      const order = await placeOrder({
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerAddress: address.trim(),
        paymentMethod: 'UPI',
        customerUtr: customerUtr.trim() || undefined,
      });
      if (order) {
        router.replace('/(tabs)/orders');
      } else {
        Alert.alert('Order failed', 'Something went wrong. Please try again.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      Alert.alert('Order failed', message);
    } finally {
      setPlacing(false);
    }
  };

  const handleCopyVpa = async () => {
    if (!activeMerchantVpa) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(activeMerchantVpa);
      setCopiedVpa(true);
      setTimeout(() => setCopiedVpa(false), 2500);
    } else {
      Alert.alert('UPI VPA', activeMerchantVpa);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: 130 }}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="arrow-left" size={19} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Checkout</Text>
          <Feather name="lock" size={18} color={colors.moss} />
        </View>
        <Text style={[styles.kicker, { color: colors.coral }]}>ALMOST YOURS</Text>
        <Text style={[styles.title, { color: colors.foreground }]}>Where should we{"\n"}send your picks?</Text>

        {!hasItems ? (
          <View style={[styles.emptyWarning, { backgroundColor: colors.coralSoft, borderColor: colors.coral }]}>
            <Feather name="alert-circle" size={15} color={colors.coral} />
            <Text style={[styles.emptyWarningText, { color: colors.coral }]}>Your cart is empty.</Text>
          </View>
        ) : !allInStock ? (
          <View style={[styles.emptyWarning, { backgroundColor: colors.coralSoft, borderColor: colors.coral }]}>
            <Feather name="alert-circle" size={15} color={colors.coral} />
            <Text style={[styles.emptyWarningText, { color: colors.coral }]}>
              Some items are out of stock or unavailable. Please update your cart.
            </Text>
          </View>
        ) : null}

        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.foreground }]}>Full name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Aarav Sharma" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Phone number</Text>
          <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+91 98765 43210" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Delivery address</Text>
          <TextInput value={address} onChangeText={setAddress} multiline placeholder="Flat, building, street, city, pincode" placeholderTextColor={colors.mutedForeground} style={[styles.input, styles.addressInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />

          <Text style={[styles.label, { color: colors.foreground, marginTop: 23 }]}>Payment Method</Text>

          {/* Online payment only — COD removed */}
          <View style={[styles.paymentOption, { backgroundColor: colors.mossSoft, borderColor: colors.moss }]}>
            <Feather name="smartphone" size={17} color={colors.moss} />
            <Text style={[styles.paymentText, { color: colors.moss }]}>Direct UPI / Google Pay</Text>
            <Feather name="check-circle" size={16} color={colors.moss} />
          </View>

          {!paymentReady ? (
            <View style={[styles.paymentPendingBox, { backgroundColor: '#FFF8E1', borderColor: '#F59E0B' }]}>
              <Feather name="clock" size={15} color="#F59E0B" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.paymentPendingTitle, { color: '#92400E' }]}>
                  UPI Payment Setup Required
                </Text>
                <Text style={[styles.paymentPendingText, { color: '#92400E' }]}>
                  Online UPI payment is currently being configured by the store owner. Please configure your UPI VPA in the Admin Panel to enable checkout.
                </Text>
              </View>
            </View>
          ) : (
            <View style={[styles.upiPaymentCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {/* Payee Info */}
              <View style={styles.payeeRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.payeeLabel, { color: colors.mutedForeground }]}>Pay to Business</Text>
                  <Text style={[styles.payeeName, { color: colors.foreground }]}>{activeMerchantName}</Text>
                  {activeMerchantVpa ? (
                    <Text style={[styles.payeeVpa, { color: colors.moss }]}>{activeMerchantVpa}</Text>
                  ) : null}
                </View>
                {activeMerchantVpa ? (
                  <Pressable
                    onPress={handleCopyVpa}
                    style={[styles.copyBtn, { backgroundColor: colors.mossSoft, borderColor: colors.moss }]}
                  >
                    <Feather name={copiedVpa ? 'check' : 'copy'} size={13} color={colors.moss} />
                    <Text style={[styles.copyBtnText, { color: colors.moss }]}>{copiedVpa ? 'Copied' : 'Copy UPI'}</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* QR Code Display */}
              {qrDisplayUrl ? (
                <View style={styles.qrContainer}>
                  <Image source={{ uri: qrDisplayUrl }} style={styles.checkoutQrImage} resizeMode="contain" />
                  <Text style={[styles.qrScanText, { color: colors.mutedForeground }]}>
                    Scan using Google Pay, PhonePe, Paytm, or any UPI App
                  </Text>
                </View>
              ) : null}

              {/* Instructions */}
              {paymentSettings.instructions ? (
                <View style={[styles.instructionBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <Text style={[styles.instructionTitle, { color: colors.foreground }]}>How to complete payment:</Text>
                  <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                    {paymentSettings.instructions}
                  </Text>
                </View>
              ) : null}

              {/* Customer UTR Input */}
              <View style={{ marginTop: 14 }}>
                <Text style={[styles.label, { color: colors.foreground, marginTop: 0 }]}>
                  UPI Transaction Reference / UTR (Optional)
                </Text>
                <TextInput
                  value={customerUtr}
                  onChangeText={setCustomerUtr}
                  maxLength={100}
                  placeholder="e.g. UPI Ref No., UTR, or Transaction ID from receipt"
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                />
                <Text style={[styles.pendingAdvisoryText, { color: colors.mutedForeground }]}>
                  Note: Payment will be placed in "Pending Verification" until the store admin verifies receipt in their bank/UPI account.
                </Text>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
      <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <View style={styles.totalRow}><Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Payable today</Text><Text style={[styles.total, { color: colors.foreground }]}>{formatPrice(cartTotal)}</Text></View>
        <Pressable
          disabled={!canPlace}
          onPress={handlePlaceOrder}
          style={[styles.placeButton, { backgroundColor: canPlace ? colors.coral : colors.muted }]}
          testID="place-order"
        >
          {placing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Text style={[styles.placeText, { color: canPlace ? '#FFFFFF' : colors.mutedForeground }]}>
                {paymentReady ? 'Place order & pay' : 'Payment setup pending'}
              </Text>
              {paymentReady ? <Feather name="arrow-right" size={18} color={canPlace ? '#FFFFFF' : colors.mutedForeground} /> : null}
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7, paddingHorizontal: 20, marginTop: 28 },
  title: { fontSize: 29, lineHeight: 32, fontFamily: 'Inter_700Bold', letterSpacing: -1, paddingHorizontal: 20, marginTop: 8 },
  emptyWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 20, marginTop: 16, padding: 12, borderRadius: 13, borderWidth: 1 },
  emptyWarningText: { flex: 1, fontSize: 12, fontFamily: 'Inter_600SemiBold', lineHeight: 17 },
  form: { paddingHorizontal: 20, marginTop: 25 },
  label: { fontSize: 12, fontFamily: 'Inter_700Bold', marginBottom: 8, marginTop: 15 },
  input: { minHeight: 49, borderWidth: 1, borderRadius: 15, paddingHorizontal: 14, fontSize: 13, fontFamily: 'Inter_400Regular' },
  addressInput: { minHeight: 86, paddingTop: 14, textAlignVertical: 'top' },
  paymentOption: { minHeight: 52, borderWidth: 1, borderRadius: 15, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  paymentText: { flex: 1, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  paymentNote: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 10, lineHeight: 16 },
  paymentPendingBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 14, borderWidth: 1, marginTop: 12 },
  paymentPendingTitle: { fontSize: 12, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  paymentPendingText: { fontSize: 11, fontFamily: 'Inter_400Regular', lineHeight: 16 },
  upiPaymentCard: { padding: 14, borderRadius: 16, borderWidth: 1, marginTop: 12 },
  payeeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payeeLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  payeeName: { fontSize: 14, fontFamily: 'Inter_700Bold', marginTop: 2 },
  payeeVpa: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 2 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  copyBtnText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  qrContainer: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#EEEEEE', marginTop: 12 },
  checkoutQrImage: { width: 180, height: 180, borderRadius: 12 },
  qrScanText: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 8, textAlign: 'center' },
  instructionBox: { padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 10 },
  instructionTitle: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  instructionText: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3, lineHeight: 16 },
  pendingAdvisoryText: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 6, lineHeight: 14 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 13, borderTopWidth: 1 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 11 },
  totalLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  total: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  placeButton: { height: 54, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  placeText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});