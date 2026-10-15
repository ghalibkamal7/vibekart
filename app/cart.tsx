import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { calculateDeliveryCharge, formatPrice, getProductImages } from '@/data/store';
import { ProductImagePlaceholder } from '@/components/ProductImagePlaceholder';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function CartScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { cart, cartTotal, removeFromCart, storeSettings } = useStore();
  const deliveryCharge = calculateDeliveryCharge(cartTotal, storeSettings);
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: 150 }}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="arrow-left" size={19} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Your bag</Text>
          <View style={{ width: 42 }} />
        </View>
        {!cart.length ? (
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.coralSoft }]}>
              <Feather name="shopping-bag" size={28} color={colors.coral} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Your bag is taking a breather.</Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>Add something you love and it will wait here.</Text>
            <Pressable onPress={() => router.back()} style={[styles.shopButton, { backgroundColor: colors.moss }]}>
              <Text style={styles.shopButtonText}>Keep browsing</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={[styles.caption, { color: colors.mutedForeground }]}>{cart.length} pick{cart.length > 1 ? 's' : ''} · Ready to checkout</Text>
            {cart.map((line) => {
              const images = getProductImages(line.product);
              return (
                <View key={`${line.product.id}-${line.option}`} style={[styles.line, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  {images.length ? (
                    <Image source={images[0]} style={styles.lineImage} />
                  ) : (
                    <ProductImagePlaceholder style={styles.lineImage} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.lineName, { color: colors.foreground }]} numberOfLines={1}>{line.product.name}</Text>
                    <Text style={[styles.lineOption, { color: colors.mutedForeground }]}>{line.option} · Qty {line.quantity}</Text>
                    <Text style={[styles.linePrice, { color: colors.foreground }]}>{formatPrice(line.priceAtAdd * line.quantity)}</Text>
                  </View>
                  <Pressable onPress={() => removeFromCart(line.product.id)} hitSlop={10}>
                    <Feather name="minus-circle" size={19} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              );
            })}
            <View style={[styles.summary, { borderTopColor: colors.border }]}>
              <View style={styles.summaryRow}><Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Subtotal</Text><Text style={[styles.summaryValue, { color: colors.foreground }]}>{formatPrice(cartTotal)}</Text></View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Delivery</Text>
                <Text style={[styles.summaryValue, { color: deliveryCharge ? colors.foreground : colors.moss }]}>
                  {deliveryCharge ? formatPrice(deliveryCharge) : 'No charge'}
                </Text>
              </View>
              {storeSettings.freeDeliveryEnabled && storeSettings.deliveryPromotionActive && deliveryCharge > 0 ? (
                <Text style={[styles.deliveryPromo, { color: colors.mutedForeground }]}>
                  {storeSettings.deliveryPromotionText} on orders over {formatPrice(storeSettings.freeDeliveryThreshold)}.
                </Text>
              ) : null}
              <View style={[styles.summaryRow, { marginTop: 14 }]}><Text style={[styles.totalLabel, { color: colors.foreground }]}>Estimated total</Text><Text style={[styles.totalValue, { color: colors.foreground }]}>{formatPrice(cartTotal + deliveryCharge)}</Text></View>
            </View>
          </>
        )}
      </ScrollView>
      {cart.length ? (
        <View style={[styles.checkoutBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
          <Pressable onPress={() => router.push('/checkout')} style={[styles.checkoutButton, { backgroundColor: colors.coral }]} testID="checkout">
            <Text style={styles.checkoutText}>Continue to checkout</Text>
            <Feather name="arrow-right" size={18} color="#FFFFFF" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  caption: { fontSize: 12, fontFamily: 'Inter_400Regular', paddingHorizontal: 20, marginTop: 24, marginBottom: 12 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 18, padding: 10, borderWidth: 1, borderRadius: 18, marginBottom: 10 },
  lineImage: { width: 76, height: 76, borderRadius: 13 },
  lineName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  lineOption: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 5 },
  linePrice: { fontSize: 13, fontFamily: 'Inter_700Bold', marginTop: 10 },
  summary: { margin: 18, paddingTop: 17, borderTopWidth: 1, gap: 13 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  summaryValue: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  free: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  deliveryPromo: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: -6 },
  totalLabel: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  totalValue: { fontSize: 19, fontFamily: 'Inter_700Bold' },
  empty: { alignItems: 'center', paddingHorizontal: 26, paddingTop: 100 },
  emptyIcon: { width: 70, height: 70, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', textAlign: 'center', marginTop: 17 },
  emptyBody: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 7 },
  shopButton: { paddingHorizontal: 18, paddingVertical: 13, borderRadius: 15, marginTop: 23 },
  shopButtonText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  checkoutBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1 },
  checkoutButton: { height: 54, borderRadius: 18, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  checkoutText: { color: '#FFFFFF', fontSize: 14, fontFamily: 'Inter_700Bold' },
});