import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import {
  buildUpiPaymentUri,
  normalizeIndianMobile,
  validateCheckoutDetails,
  validateCheckoutName,
} from '@/data/checkout-validation';
import { calculateDeliveryCharge, formatPrice } from '@/data/store';
import { showPlatformAlert } from '@/utils/platformDialogs';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { Order } from '@/data/store';

const MERCHANT_NAME = process.env.EXPO_PUBLIC_MERCHANT_NAME || 'VibeKart';

export default function CheckoutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    cart,
    cartTotal,
    placeOrder,
    submitManualOrderUtr,
    authUser,
    authLoaded,
    isCloudMode,
    paymentSettings,
    storeSettings,
  } = useStore();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [customerUtr, setCustomerUtr] = useState('');
  const [placing, setPlacing] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const [detailsSubmitted, setDetailsSubmitted] = useState(false);
  const [copiedVpa, setCopiedVpa] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const orderIdempotencyKey = useRef<{ uid: string; key: string } | null>(null);
  const hasItems = cart.length > 0;
  const allInStock = cart.every((line) => line.product.inStock && (line.product.enabled ?? true));
  const validationErrors = validateCheckoutDetails({ name, phone, address });

  // Self-service manual UPI readiness from Admin Panel
  const manualUpiReady = Boolean(paymentSettings.enabled && paymentSettings.merchantVpa?.trim());

  const paymentReady = manualUpiReady;
  const canPlace =
    !pendingOrder && !placing && isCloudMode && !!authUser && !authUser.isGuest &&
    hasItems && allInStock && paymentReady;
  const canSubmitDetails =
    !!pendingOrder && pendingOrder.paymentStatus === 'Pending' &&
    !detailsSubmitted && !placing && !!customerUtr.trim();

  const activeMerchantName = paymentSettings.merchantName?.trim() || MERCHANT_NAME;
  const activeMerchantVpa = paymentSettings.merchantVpa?.trim() || '';
  const estimatedDeliveryCharge = calculateDeliveryCharge(cartTotal, storeSettings);
  const estimatedTotal = cartTotal + estimatedDeliveryCharge;
  const payableAmount = pendingOrder?.total ?? estimatedTotal;
  const qrPaymentUri = buildUpiPaymentUri(activeMerchantVpa, activeMerchantName, payableAmount);

  useEffect(() => {
    if (!authLoaded || !authUser || authUser.isGuest) return;
    setName((current) => current || (validateCheckoutName(authUser.name) ? '' : authUser.name.trim()));
    setPhone((current) => current || (normalizeIndianMobile(authUser.phone ?? '') ?? ''));
  }, [authLoaded, authUser]);

  const handlePlaceOrder = async () => {
    if (!paymentReady) {
      showPlatformAlert(
        'Payment not available',
        'Online payment setup is pending. The store owner needs to configure UPI payment settings in the Admin Panel before orders can be placed.',
      );
      return;
    }
    if (!isCloudMode) {
      showPlatformAlert('Sign in required', 'Sign in to place a manual UPI order.');
      return;
    }
    if (!authUser || authUser.isGuest) {
      showPlatformAlert('Sign in required', 'Sign in with a customer account before placing an order.');
      return;
    }
    if (!hasItems) {
      showPlatformAlert('Empty cart', 'Your cart is empty. Add items before placing an order.');
      return;
    }
    if (!allInStock) {
      showPlatformAlert(
        'Item unavailable',
        'One or more items in your cart are out of stock or no longer available. Please remove them and try again.',
      );
      return;
    }
    setShowValidation(true);
    const errors = validateCheckoutDetails({ name, phone, address });
    if (Object.keys(errors).length > 0) return;
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!normalizedPhone) return;
    setPlacing(true);
    try {
      const idempotencyStorageKey = `vibekart:checkout-idempotency:${authUser.uid}`;
      let idempotencyKey = orderIdempotencyKey.current?.uid === authUser.uid
        ? orderIdempotencyKey.current.key
        : await AsyncStorage.getItem(idempotencyStorageKey);
      if (!idempotencyKey) {
        idempotencyKey = `checkout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        await AsyncStorage.setItem(idempotencyStorageKey, idempotencyKey);
      }
      orderIdempotencyKey.current = { uid: authUser.uid, key: idempotencyKey };
      const order = await placeOrder({
        customerName: name.trim(),
        customerPhone: normalizedPhone,
        customerAddress: address.trim(),
        paymentMethod: 'UPI',
        idempotencyKey,
      });
      if (order) {
        await AsyncStorage.removeItem(idempotencyStorageKey);
        orderIdempotencyKey.current = null;
        setPendingOrder(order);
      } else {
        showPlatformAlert('Order failed', 'Something went wrong. Please try again.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      showPlatformAlert('Order failed', message);
    } finally {
      setPlacing(false);
    }
  };

  const handleSubmitPaymentDetails = async () => {
    const utr = customerUtr.trim();
    if (!pendingOrder || !utr) {
      showPlatformAlert('UTR required', 'Enter the transaction reference from your UPI payment receipt.');
      return;
    }
    setPlacing(true);
    try {
      await submitManualOrderUtr(pendingOrder.id, utr);
      setDetailsSubmitted(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not submit payment details.';
      showPlatformAlert('Submission failed', message);
    } finally {
      setPlacing(false);
    }
  };

  const handleCopyVpa = async () => {
    if (!activeMerchantVpa) return;
    if (Platform.OS === 'web') {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard) {
          throw new Error('Clipboard access is unavailable in this browser.');
        }
        await navigator.clipboard.writeText(activeMerchantVpa);
        setCopiedVpa(true);
        setTimeout(() => setCopiedVpa(false), 2500);
      } catch {
        showPlatformAlert('Copy unavailable', `Copy this UPI ID manually: ${activeMerchantVpa}`);
      }
      return;
    }
    showPlatformAlert('UPI VPA', activeMerchantVpa);
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
          <TextInput
            value={name}
            onChangeText={setName}
            autoComplete="name"
            textContentType="name"
            autoCapitalize="words"
            placeholder="Aarav Sharma"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Full name"
            testID="checkout-name"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.name ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.name}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>Phone number</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            autoComplete="tel"
            textContentType="telephoneNumber"
            keyboardType="phone-pad"
            autoCorrect={false}
            maxLength={20}
            placeholder="+91 98765 43210"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Indian mobile number"
            testID="checkout-phone"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.phone ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.phone}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>Delivery address</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            autoComplete="street-address"
            textContentType="fullStreetAddress"
            multiline
            maxLength={300}
            placeholder="Flat, building, street, city, pincode"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Delivery address"
            testID="checkout-address"
            style={[styles.input, styles.addressInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.address ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.address}</Text>
          ) : null}

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

              {qrPaymentUri ? (
                <View style={styles.qrContainer} testID="checkout-upi-qr">
                  <QRCode
                    value={qrPaymentUri}
                    size={200}
                    ecl="M"
                    quietZone={10}
                    backgroundColor="#FFFFFF"
                    color="#111111"
                  />
                  <Text style={[styles.qrScanText, { color: colors.foreground }]}>
                    {pendingOrder ? `Scan to pay exactly ${formatPrice(pendingOrder.total)}` : `QR amount: estimated ${formatPrice(estimatedTotal)}`}
                  </Text>
                  <Text style={[styles.qrScanText, { color: colors.mutedForeground }]}>
                    {pendingOrder
                      ? 'Scan using any UPI app. Payment remains pending until an administrator verifies the actual merchant-account credit.'
                      : 'Create your pending order before paying. The server will confirm the final amount.'}
                  </Text>
                </View>
              ) : null}

              {pendingOrder ? (
                <>
                  <View style={[styles.instructionBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <Text style={[styles.instructionTitle, { color: colors.foreground }]}>
                      Pay exactly {formatPrice(pendingOrder.total)} to the merchant
                    </Text>
                    <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                      Complete the UPI payment first. Your order remains pending while payment is reviewed. Submitting a UTR does not confirm payment; an administrator must verify the actual merchant-account credit.
                    </Text>
                  </View>
                  {paymentSettings.instructions ? (
                    <Text style={[styles.instructionText, { color: colors.mutedForeground, marginTop: 8 }]}>
                      {paymentSettings.instructions}
                    </Text>
                  ) : null}
                  {detailsSubmitted ? (
                    <View style={[styles.instructionBox, { backgroundColor: colors.mossSoft, borderColor: colors.moss }]}>
                      <Text style={[styles.instructionTitle, { color: colors.moss }]}>
                        Payment details submitted. Your payment is awaiting verification.
                      </Text>
                      <Text style={[styles.instructionText, { color: colors.moss }]}>
                        Order {pendingOrder.id}. You can check its status in Orders.
                      </Text>
                    </View>
                  ) : (
                    <View style={{ marginTop: 14 }}>
                      <Text style={[styles.label, { color: colors.foreground, marginTop: 0 }]}>
                        UPI transaction reference / UTR (required to submit)
                      </Text>
                      <TextInput
                        value={customerUtr}
                        onChangeText={setCustomerUtr}
                        maxLength={100}
                        autoCapitalize="none"
                        placeholder="Enter the reference shown in your payment receipt"
                        placeholderTextColor={colors.mutedForeground}
                        style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                      />
                      <Text style={[styles.pendingAdvisoryText, { color: colors.mutedForeground }]}>
                        Find it in your payment app's transaction details (Google Pay, PhonePe, or your bank app). The reference is not proof of payment. If you cannot find it yet, leave the order pending and return later from Orders.
                      </Text>
                    </View>
                  )}
                </>
              ) : (
                <View style={[styles.instructionBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <Text style={[styles.instructionTitle, { color: colors.foreground }]}>Create your pending order first</Text>
                  <Text style={[styles.instructionText, { color: colors.mutedForeground }]}>
                    Current product prices and delivery settings are refreshed before the pending order is saved. Payment stays pending until an administrator verifies the actual credit.
                  </Text>
                </View>
              )}
            </View>
          )}
          {!isCloudMode ? (
            <Text style={[styles.pendingAdvisoryText, { color: colors.coral, marginTop: 12 }]}>
              Sign in to place a manual UPI order. Guest/demo checkout cannot submit payment details.
            </Text>
          ) : null}
          <View style={[styles.deliverySummary, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.deliverySummaryRow}>
              <Text style={[styles.deliverySummaryLabel, { color: colors.mutedForeground }]}>Estimated delivery</Text>
              <Text style={[styles.deliverySummaryValue, { color: colors.foreground }]}>
                {pendingOrder
                  ? `${pendingOrder.deliveryMinDays ?? storeSettings.deliveryMinDays}–${pendingOrder.deliveryMaxDays ?? storeSettings.deliveryMaxDays} working days`
                  : `${storeSettings.deliveryMinDays}–${storeSettings.deliveryMaxDays} working days`}
              </Text>
            </View>
            {pendingOrder ? (
              <View style={styles.deliverySummaryRow}>
                <Text style={[styles.deliverySummaryLabel, { color: colors.mutedForeground }]}>Delivery charge</Text>
                <Text style={[styles.deliverySummaryValue, { color: colors.foreground }]}>
                  {pendingOrder.deliveryCharge ? formatPrice(pendingOrder.deliveryCharge) : 'No charge'}
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.deliverySummaryRow}>
                  <Text style={[styles.deliverySummaryLabel, { color: colors.mutedForeground }]}>Delivery charge</Text>
                  <Text style={[styles.deliverySummaryValue, { color: estimatedDeliveryCharge ? colors.foreground : colors.moss }]}>
                    {estimatedDeliveryCharge ? formatPrice(estimatedDeliveryCharge) : 'No charge'}
                  </Text>
                </View>
                {storeSettings.freeDeliveryEnabled && storeSettings.deliveryPromotionActive && estimatedDeliveryCharge > 0 ? (
                  <Text style={[styles.deliveryInstructions, { color: colors.mutedForeground }]}>
                    {storeSettings.deliveryPromotionText} on orders over {formatPrice(storeSettings.freeDeliveryThreshold)}.
                  </Text>
                ) : null}
              </>
            )}
            {storeSettings.deliveryInstructions ? (
              <Text style={[styles.deliveryInstructions, { color: colors.mutedForeground }]}>{storeSettings.deliveryInstructions}</Text>
            ) : null}
          </View>
        </View>
      </ScrollView>
      <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <View style={styles.totalRow}><Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>{pendingOrder ? 'Order total' : 'Estimated total'}</Text><Text style={[styles.total, { color: colors.foreground }]}>{formatPrice(payableAmount)}</Text></View>
        <Pressable
          disabled={pendingOrder ? !canSubmitDetails : !canPlace}
          onPress={pendingOrder ? handleSubmitPaymentDetails : handlePlaceOrder}
          style={[styles.placeButton, { backgroundColor: (pendingOrder ? canSubmitDetails : canPlace) ? colors.coral : colors.muted }]}
          testID="place-order"
        >
          {placing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Text style={[styles.placeText, { color: (pendingOrder ? canSubmitDetails : canPlace) ? '#FFFFFF' : colors.mutedForeground }]}>
                {pendingOrder
                  ? detailsSubmitted
                    ? 'Awaiting verification'
                    : 'Submit payment details'
                  : !paymentReady
                    ? 'Payment setup pending'
                    : !isCloudMode || !authUser || authUser.isGuest
                      ? 'Sign in to continue'
                      : 'Create pending order'}
              </Text>
              {!detailsSubmitted ? <Feather name="arrow-right" size={18} color={(pendingOrder ? canSubmitDetails : canPlace) ? '#FFFFFF' : colors.mutedForeground} /> : null}
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
  validationError: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 5 },
  addressInput: { minHeight: 86, paddingTop: 14, textAlignVertical: 'top' },
  paymentOption: { minHeight: 52, borderWidth: 1, borderRadius: 15, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  paymentText: { flex: 1, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  paymentNote: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 10, lineHeight: 16 },
  paymentPendingBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 14, borderWidth: 1, marginTop: 12 },
  paymentPendingTitle: { fontSize: 12, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  paymentPendingText: { fontSize: 11, fontFamily: 'Inter_400Regular', lineHeight: 16 },
  deliverySummary: { marginTop: 16, padding: 13, borderWidth: 1, borderRadius: 14, gap: 8 },
  deliverySummaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  deliverySummaryLabel: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  deliverySummaryValue: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  deliveryInstructions: { fontSize: 11, fontFamily: 'Inter_400Regular', lineHeight: 16 },
  upiPaymentCard: { padding: 14, borderRadius: 16, borderWidth: 1, marginTop: 12 },
  payeeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payeeLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  payeeName: { fontSize: 14, fontFamily: 'Inter_700Bold', marginTop: 2 },
  payeeVpa: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 2 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  copyBtnText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  qrContainer: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#EEEEEE', marginTop: 12 },
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