import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function CheckoutScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { cart, cartTotal, placeOrder } = useStore();
  const [payment, setPayment] = useState<'UPI' | 'COD'>('UPI');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [placing, setPlacing] = useState(false);

  const hasItems = cart.length > 0;
  const allInStock = cart.every((line) => line.product.inStock && (line.product.enabled ?? true));
  const fieldsOk = name.trim() && address.trim() && phone.trim();
  const canPlace = !placing && hasItems && allInStock && !!fieldsOk;

  const handlePlaceOrder = async () => {
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
        paymentMethod: payment,
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
          <Text style={[styles.label, { color: colors.foreground, marginTop: 23 }]}>Payment method</Text>
          <View style={styles.paymentRow}>
            {(['UPI', 'COD'] as const).map((method) => (
              <Pressable key={method} onPress={() => setPayment(method)} style={[styles.paymentOption, { backgroundColor: payment === method ? colors.mossSoft : colors.card, borderColor: payment === method ? colors.moss : colors.border }]}>
                <Feather name={method === 'UPI' ? 'smartphone' : 'package'} size={17} color={payment === method ? colors.moss : colors.mutedForeground} />
                <Text style={[styles.paymentText, { color: payment === method ? colors.moss : colors.foreground }]}>{method === 'UPI' ? 'UPI / Cards' : 'Cash on delivery'}</Text>
                {payment === method ? <Feather name="check-circle" size={16} color={colors.moss} /> : null}
              </Pressable>
            ))}
          </View>
          {payment === 'UPI' ? (
            <Text style={[styles.paymentNote, { color: colors.mutedForeground }]}>
              UPI payment is selected — payment link will be shared after order confirmation.
            </Text>
          ) : (
            <Text style={[styles.paymentNote, { color: colors.mutedForeground }]}>
              Pay in cash when your order arrives.
            </Text>
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
              <Text style={[styles.placeText, { color: canPlace ? '#FFFFFF' : colors.mutedForeground }]}>Place order</Text>
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
  addressInput: { minHeight: 86, paddingTop: 14, textAlignVertical: 'top' },
  paymentRow: { gap: 9 },
  paymentOption: { minHeight: 52, borderWidth: 1, borderRadius: 15, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  paymentText: { flex: 1, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  paymentNote: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 10, lineHeight: 16 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 13, borderTopWidth: 1 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 11 },
  totalLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  total: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  placeButton: { height: 54, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  placeText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});