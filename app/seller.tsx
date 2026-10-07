import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function SellerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { products, analytics, toggleStock, deleteProduct } = useStore();

  const confirmDelete = (id: string, name: string) => {
    Alert.alert('Delete product?', `"${name}" will be permanently removed from your catalogue.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteProduct(id) },
    ]);
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 14, paddingBottom: 100 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="arrow-left" size={19} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Seller space</Text>
        <Pressable onPress={() => router.push('/seller-orders')} hitSlop={10}>
          <Feather name="clipboard" size={20} color={colors.foreground} />
        </Pressable>
      </View>
      <Text style={[styles.kicker, { color: colors.coral }]}>RESELLER SNAPSHOT</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>Make every pick{"\n"}work harder.</Text>

      <View style={styles.metrics}>
        <View style={[styles.metric, { backgroundColor: colors.moss }]}>
          <Text style={styles.metricLabel}>NET PROFIT</Text>
          <Text style={styles.metricValue}>{formatPrice(analytics.totalProfit)}</Text>
          <Text style={styles.metricFoot}>{analytics.ordersCount} order{analytics.ordersCount === 1 ? '' : 's'} total</Text>
        </View>
        <View style={[styles.metric, { backgroundColor: colors.butter }]}>
          <Text style={[styles.metricLabel, { color: colors.moss }]}>REVENUE</Text>
          <Text style={[styles.metricValue, { color: colors.moss }]}>{formatPrice(analytics.totalRevenue)}</Text>
          <Text style={[styles.metricFoot, { color: colors.moss }]}>Cost: {formatPrice(analytics.totalCost)}</Text>
        </View>
      </View>

      <View style={styles.quickRow}>
        <Pressable onPress={() => router.push('/seller-add-product')} style={[styles.quickAction, { backgroundColor: colors.coral }]} testID="add-product">
          <Feather name="plus" size={16} color="#FFFFFF" />
          <Text style={styles.quickActionText}>Add product</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/seller-orders')} style={[styles.quickAction, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]} testID="view-orders">
          <Feather name="package" size={16} color={colors.moss} />
          <Text style={[styles.quickActionText, { color: colors.moss }]}>Fulfil orders</Text>
        </Pressable>
      </View>

      <View style={[styles.note, { backgroundColor: colors.coralSoft }]}>
        <Feather name="info" size={17} color={colors.coral} />
        <Text style={[styles.noteText, { color: colors.foreground }]}>
          Set base cost and markup for every product — customers only ever see the final price, never the cost.
        </Text>
      </View>

      <View style={styles.sectionRow}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Catalogue ({products.length})</Text>
      </View>
      {products.map((product) => (
        <View key={product.id} style={[styles.productRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.productDot, { backgroundColor: product.inStock ? colors.mossSoft : colors.coralSoft }]}>
            <Feather name="package" size={16} color={product.inStock ? colors.moss : colors.coral} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.productName, { color: colors.foreground }]} numberOfLines={1}>{product.name}</Text>
            <Text style={[styles.productMeta, { color: colors.mutedForeground }]}>
              Cost {formatPrice(product.baseCost)} → Sell {formatPrice(product.price)} · Margin {formatPrice(product.price - product.baseCost)}
            </Text>
            <Text style={[styles.markupTag, { color: colors.moss }]}>
              {product.markupType === 'percent' ? `+${product.markupValue}%` : `+${formatPrice(product.markupValue)}`} markup
            </Text>
          </View>
          <View style={styles.productActions}>
            <Switch
              value={product.inStock}
              onValueChange={() => toggleStock(product.id)}
              trackColor={{ false: colors.border, true: colors.mossSoft }}
              thumbColor={product.inStock ? colors.moss : colors.mutedForeground}
            />
            <Pressable onPress={() => router.push({ pathname: '/seller-add-product', params: { id: product.id } })} hitSlop={8} style={{ marginTop: 10 }}>
              <Feather name="edit-3" size={16} color={colors.moss} />
            </Pressable>
            <Pressable onPress={() => confirmDelete(product.id, product.name)} hitSlop={8} style={{ marginTop: 12 }}>
              <Feather name="trash-2" size={16} color={colors.destructive} />
            </Pressable>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7, marginTop: 30 },
  title: { fontSize: 30, lineHeight: 33, fontFamily: 'Inter_700Bold', letterSpacing: -1, marginTop: 8 },
  metrics: { flexDirection: 'row', gap: 11, marginTop: 22 },
  metric: { flex: 1, minHeight: 131, borderRadius: 20, padding: 15, justifyContent: 'space-between' },
  metricLabel: { color: '#DCEBE5', fontSize: 9, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  metricValue: { color: '#FFFFFF', fontSize: 22, fontFamily: 'Inter_700Bold' },
  metricFoot: { color: '#DCEBE5', fontSize: 10, fontFamily: 'Inter_400Regular' },
  quickRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  quickAction: { flex: 1, height: 48, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  quickActionText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 17, padding: 13, marginTop: 15 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 16, fontFamily: 'Inter_500Medium' },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 10 },
  sectionTitle: { fontSize: 19, fontFamily: 'Inter_700Bold' },
  productRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderRadius: 17, borderWidth: 1, padding: 12, marginBottom: 9 },
  productDot: { width: 39, height: 39, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  productName: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  productMeta: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 4 },
  markupTag: { fontSize: 10, fontFamily: 'Inter_700Bold', marginTop: 4 },
  productActions: { alignItems: 'center' },
});
