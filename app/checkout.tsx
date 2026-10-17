import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  normalizeIndianMobile,
  validateProductRequestDetails,
  validateCheckoutName,
} from '@/data/checkout-validation';
import { showPlatformAlert } from '@/utils/platformDialogs';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function CheckoutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    cart,
    placeOrder,
    authUser,
    authLoaded,
    isCloudMode,
  } = useStore();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [houseDetails, setHouseDetails] = useState('');
  const [roadArea, setRoadArea] = useState('');
  const [pincode, setPincode] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [placing, setPlacing] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const orderIdempotencyKey = useRef<{ uid: string; key: string } | null>(null);
  const hasItems = cart.length > 0;
  const allInStock = cart.every((line) => line.product.inStock && (line.product.enabled ?? true));
  const address = { houseDetails, roadArea, pincode, city, state };
  const validationErrors = validateProductRequestDetails({ name, phone, address });
  const canPlace = !placing && isCloudMode && !!authUser && !authUser.isGuest && hasItems && allInStock;

  useEffect(() => {
    if (!authLoaded || !authUser || authUser.isGuest) return;
    setName((current) => current || (validateCheckoutName(authUser.name) ? '' : authUser.name.trim()));
    setPhone((current) => current || (normalizeIndianMobile(authUser.phone ?? '') ?? ''));
  }, [authLoaded, authUser]);

  const handlePlaceOrder = async () => {
    if (!isCloudMode) {
      showPlatformAlert('Sign in required', 'Sign in to submit a product request.');
      return;
    }
    if (!authUser || authUser.isGuest) {
      showPlatformAlert('Sign in required', 'Sign in with a customer account before submitting a request.');
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
    const errors = validateProductRequestDetails({ name, phone, address });
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
        address: {
          houseDetails: houseDetails.trim(),
          roadArea: roadArea.trim(),
          pincode: pincode.trim(),
          city: city.trim(),
          state: state.trim(),
        },
        idempotencyKey,
      });
      if (order) {
        await AsyncStorage.removeItem(idempotencyStorageKey);
        orderIdempotencyKey.current = null;
        showPlatformAlert(
          'Request received',
          `Your product request was saved with status “${order.status}”. We will contact you using the mobile number provided. No order has been placed with Meesho yet.`,
        );
        router.replace('/(tabs)/orders');
      } else {
        showPlatformAlert('Request failed', 'Something went wrong. Please try again.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      showPlatformAlert('Request failed', message);
    } finally {
      setPlacing(false);
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
          <Text style={[styles.sectionTitle, { color: colors.foreground, marginTop: 24 }]}>Delivery details</Text>
          <Text style={[styles.label, { color: colors.foreground }]}>House / building details</Text>
          <TextInput
            value={houseDetails}
            onChangeText={setHouseDetails}
            autoComplete="address-line1"
            maxLength={160}
            placeholder="House / building / flat"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="House or building details"
            testID="checkout-house-details"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.houseDetails ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.houseDetails}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>Road / area / colony</Text>
          <TextInput
            value={roadArea}
            onChangeText={setRoadArea}
            autoComplete="address-line2"
            maxLength={160}
            placeholder="Street, road, area, or colony"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Road, area, or colony"
            testID="checkout-road-area"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.roadArea ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.roadArea}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>Six-digit pincode</Text>
          <TextInput
            value={pincode}
            onChangeText={setPincode}
            autoComplete="postal-code"
            keyboardType="number-pad"
            maxLength={6}
            placeholder="560001"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Six-digit pincode"
            testID="checkout-pincode"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.pincode ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.pincode}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>City</Text>
          <TextInput
            value={city}
            onChangeText={setCity}
            autoComplete="off"
            maxLength={80}
            placeholder="Bengaluru"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="City"
            testID="checkout-city"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.city ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.city}</Text>
          ) : null}
          <Text style={[styles.label, { color: colors.foreground }]}>State</Text>
          <TextInput
            value={state}
            onChangeText={setState}
            autoComplete="off"
            maxLength={80}
            placeholder="Karnataka"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="State"
            testID="checkout-state"
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />
          {showValidation && validationErrors.state ? (
            <Text accessibilityRole="alert" style={[styles.validationError, { color: colors.coral }]}>{validationErrors.state}</Text>
          ) : null}
          <View style={[styles.requestSummary, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Products requested</Text>
            {cart.map((line) => (
              <Text key={`${line.product.id}:${line.option ?? ''}`} style={[styles.requestItem, { color: colors.mutedForeground }]}>
                {line.product.name}{line.option ? ` (${line.option})` : ''} × {line.quantity}
              </Text>
            ))}
          </View>
          {!isCloudMode ? (
            <Text style={[styles.pendingAdvisoryText, { color: colors.coral, marginTop: 12 }]}>
              Sign in to submit a product request. Guest browsing remains available.
            </Text>
          ) : null}
        </View>
      </ScrollView>
      <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          disabled={!canPlace}
          onPress={handlePlaceOrder}
          style={[styles.placeButton, { backgroundColor: canPlace ? colors.coral : colors.muted }]}
          testID="submit-product-request"
        >
          {placing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Text style={[styles.placeText, { color: canPlace ? '#FFFFFF' : colors.mutedForeground }]}>
                {!isCloudMode || !authUser || authUser.isGuest ? 'Sign in to submit request' : 'Submit product request'}
              </Text>
              <Feather name="arrow-right" size={18} color={canPlace ? '#FFFFFF' : colors.mutedForeground} />
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
  sectionTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  requestSummary: { marginTop: 20, padding: 14, borderWidth: 1, borderRadius: 14, gap: 7 },
  requestItem: { fontSize: 12, fontFamily: 'Inter_500Medium', lineHeight: 18 },
  pendingAdvisoryText: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 6, lineHeight: 14 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 13, borderTopWidth: 1 },
  placeButton: { height: 54, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  placeText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});