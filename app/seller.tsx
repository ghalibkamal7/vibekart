import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice, getProductImages } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { confirmPlatformAction, showPlatformAlert } from '@/utils/platformDialogs';

type DateFilter = 'Today' | 'Last 7 Days' | 'All Time';
const DATE_FILTERS: DateFilter[] = ['Today', 'Last 7 Days', 'All Time'];

function isWithinDays(dateStr: string, days: number): boolean {
  // dateStr is formatted like "14 Oct" — parse by comparing with recent dates
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() - d);
    const label = candidate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    if (dateStr === label) return true;
  }
  return false;
}

export default function SellerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { products, orders, analytics, toggleStock, toggleEnabled, deleteProduct, deletingProductId, authUser, isCloudMode } = useStore();
  const [dateFilter, setDateFilter] = useState<DateFilter>('All Time');

  // Client-side route guard — computed before any early return so hooks
  // are always called in the same order (React rules of hooks).
  const isSeller = !isCloudMode || (authUser && !authUser.isGuest && authUser.role === 'seller');

  const filteredOrders = useMemo(() => {
    const paidOrders = orders.filter((order) => order.paymentStatus === 'Paid');
    if (dateFilter === 'All Time') return paidOrders;
    const days = dateFilter === 'Today' ? 1 : 7;
    return paidOrders.filter((o) => isWithinDays(o.date, days));
  }, [orders, dateFilter]);

  const filteredAnalytics = useMemo(() => {
    const active = filteredOrders.filter((o) => o.status !== 'Cancelled');
    const revenue = active.reduce((s, o) => s + o.total, 0);
    const cost = active.reduce((s, o) => s + (o.costTotal ?? 0), 0);
    const profit = revenue - cost;
    return {
      revenue,
      cost,
      profit,
      marginPercent: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      ordersCount: filteredOrders.length,
      activeCount: filteredOrders.filter((o) => !['Delivered', 'Cancelled'].includes(o.status)).length,
      deliveredCount: filteredOrders.filter((o) => o.status === 'Delivered').length,
    };
  }, [filteredOrders]);

  const confirmDelete = (id: string, name: string) => {
    confirmPlatformAction(
      'Delete product?',
      `"${name}" will be permanently removed from your catalogue.`,
      'Delete',
      async () => {
        if (deletingProductId) return;
        try {
          await deleteProduct(id);
          showPlatformAlert('Product deleted', `"${name}" and any stored images were removed.`);
        } catch (error) {
          showPlatformAlert('Deletion failed', error instanceof Error ? error.message : 'Product could not be deleted. Retry after checking your connection and permissions.');
        }
      },
      true,
    );
  };

  // Access-denied screen — rendered after all hooks so hook order stays stable.
  if (!isSeller) {
    return (
      <View style={[{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }, { backgroundColor: colors.background }]}>
        <Feather name="lock" size={40} color={colors.mutedForeground} />
        <Text style={{ fontSize: 17, fontFamily: 'Inter_700Bold', color: colors.foreground, marginTop: 16 }}>Seller area</Text>
        <Text style={{ fontSize: 13, fontFamily: 'Inter_400Regular', color: colors.mutedForeground, textAlign: 'center', marginTop: 8 }}>
          This section is only accessible to authorised sellers.
        </Text>
        <Pressable onPress={() => router.replace('/(tabs)')} style={{ marginTop: 20, backgroundColor: colors.moss, paddingHorizontal: 20, paddingVertical: 11, borderRadius: 14 }}>
          <Text style={{ color: '#FFFFFF', fontFamily: 'Inter_700Bold', fontSize: 13 }}>Go back</Text>
        </Pressable>
      </View>
    );
  }



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

      {/* Date filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {DATE_FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setDateFilter(f)}
            style={[
              styles.filterChip,
              {
                backgroundColor: dateFilter === f ? colors.moss : colors.card,
                borderColor: dateFilter === f ? colors.moss : colors.border,
              },
            ]}
          >
            <Text style={[styles.filterChipText, { color: dateFilter === f ? '#FFFFFF' : colors.mutedForeground }]}>{f}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Metrics cards */}
      <View style={styles.metrics}>
        <View style={[styles.metric, { backgroundColor: colors.moss }]}>
          <Text style={styles.metricLabel}>NET PROFIT</Text>
          <Text style={styles.metricValue}>{formatPrice(filteredAnalytics.profit)}</Text>
          <Text style={styles.metricFoot}>
            {filteredAnalytics.marginPercent}% margin · {filteredAnalytics.ordersCount} order{filteredAnalytics.ordersCount === 1 ? '' : 's'}
          </Text>
        </View>
        <View style={[styles.metric, { backgroundColor: colors.butter }]}>
          <Text style={[styles.metricLabel, { color: colors.moss }]}>REVENUE</Text>
          <Text style={[styles.metricValue, { color: colors.moss }]}>{formatPrice(filteredAnalytics.revenue)}</Text>
          <Text style={[styles.metricFoot, { color: colors.moss }]}>Cost: {formatPrice(filteredAnalytics.cost)}</Text>
        </View>
      </View>

      {/* Order status pills */}
      <View style={styles.statRow}>
        <View style={[styles.statPill, { backgroundColor: colors.coralSoft }]}>
          <Feather name="clock" size={12} color={colors.coral} />
          <Text style={[styles.statText, { color: colors.coral }]}>{filteredAnalytics.activeCount} active</Text>
        </View>
        <View style={[styles.statPill, { backgroundColor: colors.mossSoft }]}>
          <Feather name="check-circle" size={12} color={colors.moss} />
          <Text style={[styles.statText, { color: colors.moss }]}>{filteredAnalytics.deliveredCount} delivered</Text>
        </View>
        {analytics.lowStockCount > 0 ? (
          <View style={[styles.statPill, { backgroundColor: '#FFF8E1' }]}>
            <Feather name="alert-triangle" size={12} color="#F59E0B" />
            <Text style={[styles.statText, { color: '#F59E0B' }]}>{analytics.lowStockCount} out of stock</Text>
          </View>
        ) : null}
        {analytics.disabledCount > 0 ? (
          <View style={[styles.statPill, { backgroundColor: '#F5F5F5' }]}>
            <Feather name="eye-off" size={12} color="#9E9E9E" />
            <Text style={[styles.statText, { color: '#9E9E9E' }]}>{analytics.disabledCount} hidden</Text>
          </View>
        ) : null}
      </View>

      {/* Quick actions */}
      <View style={styles.quickRow}>
        <Pressable onPress={() => router.push('/seller-add-product')} style={[styles.quickAction, { backgroundColor: colors.coral }]} testID="add-product">
          <Feather name="plus" size={16} color="#FFFFFF" />
          <Text style={styles.quickActionText}>Add product</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/seller-orders')} style={[styles.quickAction, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]} testID="view-orders">
          <Feather name="package" size={16} color={colors.moss} />
          <Text style={[styles.quickActionText, { color: colors.moss }]}>Fulfil orders</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/seller-categories' as any)} style={[styles.quickAction, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]} testID="manage-categories">
          <Feather name="tag" size={16} color={colors.moss} />
          <Text style={[styles.quickActionText, { color: colors.moss }]}>Categories</Text>
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
      {products.map((product) => {
        const margin = product.price - product.baseCost;
        const isLoss = margin < 0;
        const isLowStock = !product.inStock;
        const prodImages = getProductImages(product);
        return (
          <View key={product.id} style={[styles.productRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {prodImages.length ? (
              <Image source={prodImages[0]} style={styles.productThumbnail} />
            ) : (
              <View style={[styles.productDot, { backgroundColor: isLowStock ? colors.coralSoft : colors.mossSoft }]}>
                <Feather name="package" size={16} color={isLowStock ? colors.coral : colors.moss} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={[styles.productName, { color: colors.foreground }]} numberOfLines={1}>{product.name}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginVertical: 3 }}>
                {product.enabled === false ? (
                  <View style={{ backgroundColor: colors.destructive, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 8, fontFamily: 'Inter_700Bold' }}>UNLISTED</Text>
                  </View>
                ) : null}
                {product.featured ? (
                  <View style={{ backgroundColor: colors.coralSoft, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 }}>
                    <Text style={{ color: colors.coral, fontSize: 8, fontFamily: 'Inter_700Bold' }}>FEATURED</Text>
                  </View>
                ) : null}
                {product.isNew ? (
                  <View style={{ backgroundColor: colors.mossSoft, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 }}>
                    <Text style={{ color: colors.moss, fontSize: 8, fontFamily: 'Inter_700Bold' }}>NEW</Text>
                  </View>
                ) : null}
                {isLowStock ? (
                  <View style={{ backgroundColor: '#FFF8E1', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 }}>
                    <Text style={{ color: '#F59E0B', fontSize: 8, fontFamily: 'Inter_700Bold' }}>OUT OF STOCK</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.productMeta, { color: colors.mutedForeground }]}>
                Cost {formatPrice(product.baseCost)} → Sell {formatPrice(product.price)} · Margin{' '}
                <Text style={{ color: isLoss ? colors.destructive : colors.mutedForeground }}>
                  {formatPrice(margin)}
                </Text>
              </Text>
              <Text style={[styles.markupTag, { color: isLoss ? colors.destructive : colors.moss }]}>
                {product.markupType === 'manual'
                  ? `Manual price: ${formatPrice(product.price)}${isLoss ? ' (Loss!)' : ''}`
                  : product.markupType === 'percent'
                  ? `+${product.markupValue}% markup`
                  : `+${formatPrice(product.markupValue)} markup`}
              </Text>
            </View>
            <View style={styles.productActions}>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 8, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground, marginBottom: 2 }}>
                  {product.inStock ? 'Stock' : 'Out'}
                </Text>
                <Switch
                  value={product.inStock}
                  onValueChange={() => toggleStock(product.id)}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={product.inStock ? colors.moss : colors.mutedForeground}
                />
              </View>
              <View style={{ alignItems: 'center', marginTop: 6 }}>
                <Text style={{ fontSize: 8, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground, marginBottom: 2 }}>
                  {product.enabled !== false ? 'Active' : 'Hidden'}
                </Text>
                <Switch
                  value={product.enabled !== false}
                  onValueChange={() => toggleEnabled(product.id)}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={product.enabled !== false ? colors.moss : colors.mutedForeground}
                />
              </View>
              <Pressable onPress={() => router.push({ pathname: '/seller-add-product', params: { id: product.id } })} hitSlop={8} style={{ marginTop: 8 }}>
                <Feather name="edit-3" size={16} color={colors.moss} />
              </Pressable>
              <Pressable
                disabled={!!deletingProductId}
                onPress={() => confirmDelete(product.id, product.name)}
                hitSlop={8}
                style={{ marginTop: 10, opacity: deletingProductId ? 0.5 : 1 }}
              >
                {deletingProductId === product.id
                  ? <ActivityIndicator size="small" color={colors.destructive} />
                  : <Feather name="trash-2" size={16} color={colors.destructive} />}
              </Pressable>
            </View>
          </View>
        );
      })}
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
  filterRow: { paddingTop: 14, paddingBottom: 2, gap: 8 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  filterChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  metrics: { flexDirection: 'row', gap: 11, marginTop: 14 },
  metric: { flex: 1, minHeight: 131, borderRadius: 20, padding: 15, justifyContent: 'space-between' },
  metricLabel: { color: '#DCEBE5', fontSize: 9, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  metricValue: { color: '#FFFFFF', fontSize: 22, fontFamily: 'Inter_700Bold' },
  metricFoot: { color: '#DCEBE5', fontSize: 10, fontFamily: 'Inter_400Regular' },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  statText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  quickRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  quickAction: { flex: 1, height: 48, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  quickActionText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 17, padding: 13, marginTop: 15 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 16, fontFamily: 'Inter_500Medium' },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 10 },
  sectionTitle: { fontSize: 19, fontFamily: 'Inter_700Bold' },
  productRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderRadius: 17, borderWidth: 1, padding: 12, marginBottom: 9 },
  productThumbnail: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#E5E7EB' },
  productDot: { width: 39, height: 39, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  productName: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  productMeta: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 4 },
  markupTag: { fontSize: 10, fontFamily: 'Inter_700Bold', marginTop: 4 },
  productActions: { alignItems: 'center' },
});
