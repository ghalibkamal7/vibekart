import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ALLOWED_STATUS_TRANSITIONS, formatPrice, Order, OrderStatus } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { fetchSellerOrderPrivateData } from '@/services/firebase/firestore';

type FilterGroup = 'All' | 'Active' | 'Delivered' | 'Cancelled';

const FILTER_OPTIONS: FilterGroup[] = ['All', 'Active', 'Delivered', 'Cancelled'];

function matchesFilter(order: Order, filter: FilterGroup): boolean {
  if (filter === 'All') return true;
  if (filter === 'Active') return !['Delivered', 'Cancelled'].includes(order.status);
  return order.status === filter;
}

function statusPillColors(
  status: OrderStatus,
  colors: ReturnType<typeof useColors>,
): { bg: string; fg: string } {
  switch (status) {
    case 'Delivered':
      return { bg: colors.mossSoft, fg: colors.moss };
    case 'Shipped':
      return { bg: '#E8F5E9', fg: '#388E3C' };
    case 'Confirmed':
      return { bg: '#EEF4FF', fg: '#4A6CF7' };
    case 'Processing':
      return { bg: '#FFF8E1', fg: '#F59E0B' };
    case 'Cancelled':
      return { bg: '#F5F5F5', fg: '#9E9E9E' };
    default:
      return { bg: colors.coralSoft, fg: colors.coral };
  }
}

function OrderCard({ orderId }: { orderId: string }) {
  const colors = useColors();
  const { orders, updateOrderStatus, setTrackingId } = useStore();
  const order = orders.find((o) => o.id === orderId)!;
  const [tracking, setTracking] = useState(order.trackingId ?? '');
  const [privateData, setPrivateData] = useState<{
    costTotal?: number;
    profitTotal?: number;
    items?: Array<{ productId: string; unitCost?: number; sourceUrl?: string }>;
  } | null>(null);

  React.useEffect(() => {
    fetchSellerOrderPrivateData(order.id).then((data) => {
      if (data) setPrivateData(data);
    });
  }, [order.id]);

  const costTotal = privateData?.costTotal ?? order.costTotal ?? 0;
  const profitTotal = privateData?.profitTotal ?? order.profitTotal ?? (order.total - costTotal);
  const sc = statusPillColors(order.status, colors);

  // Allowed next statuses for this order, excluding 'Cancelled' (that's a separate action)
  const nextStatuses: OrderStatus[] = (ALLOWED_STATUS_TRANSITIONS[order.status] ?? []).filter(
    (s) => s !== 'Cancelled',
  );

  const handleAdvance = async (nextStatus: OrderStatus) => {
    try {
      await updateOrderStatus(order.id, nextStatus);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update status.';
      Alert.alert('Error', msg);
    }
  };

  const handleSellerCancel = async () => {
    const allowed = ALLOWED_STATUS_TRANSITIONS[order.status]?.includes('Cancelled');
    if (!allowed) {
      Alert.alert('Cannot cancel', `Orders in "${order.status}" status cannot be cancelled.`);
      return;
    }
    Alert.alert(
      'Cancel this order?',
      `Mark order ${order.id} as Cancelled? This will notify the customer and cannot be undone.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel order',
          style: 'destructive',
          onPress: async () => {
            try {
              await updateOrderStatus(order.id, 'Cancelled');
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Failed to cancel order.';
              Alert.alert('Error', msg);
            }
          },
        },
      ],
    );
  };

  const itemUrls = order.items.map((item) => item.sourceUrl).filter(Boolean) as string[];
  const privUrls = (privateData?.items?.map((it) => it.sourceUrl).filter(Boolean) || []) as string[];
  const sourceUrls = Array.from(new Set([...itemUrls, ...privUrls]));

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.topRow}>
        <View>
          <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
          <Text style={[styles.date, { color: colors.mutedForeground }]}>{order.date} · {order.paymentMethod}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: sc.bg }]}>
          <Text style={[styles.statusText, { color: sc.fg }]}>{order.status}</Text>
        </View>
      </View>

      <View style={styles.customerBlock}>
        <Text style={[styles.customerName, { color: colors.foreground }]}>{order.customerName}</Text>
        <Text style={[styles.customerDetail, { color: colors.mutedForeground }]}>{order.customerPhone}</Text>
        <Text style={[styles.customerDetail, { color: colors.mutedForeground }]}>{order.customerAddress}</Text>
      </View>

      {order.items.map((item, i) => (
        <Text key={i} style={[styles.itemLine, { color: colors.foreground }]}>
          • {item.name} {item.option ? `(${item.option})` : ''} × {item.quantity} — {formatPrice(item.unitPrice * item.quantity)}
        </Text>
      ))}

      <View style={[styles.moneyRow, { borderTopColor: colors.border }]}>
        <View>
          <Text style={[styles.moneyLabel, { color: colors.mutedForeground }]}>Revenue</Text>
          <Text style={[styles.moneyValue, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
        </View>
        <View>
          <Text style={[styles.moneyLabel, { color: colors.mutedForeground }]}>Supplier cost</Text>
          <Text style={[styles.moneyValue, { color: colors.foreground }]}>{formatPrice(costTotal)}</Text>
        </View>
        <View>
          <Text style={[styles.moneyLabel, { color: colors.mutedForeground }]}>Profit</Text>
          <Text style={[styles.moneyValue, { color: colors.moss }]}>{formatPrice(profitTotal)}</Text>
        </View>
      </View>

      {sourceUrls.length ? (
        <View style={[styles.fulfilNote, { backgroundColor: colors.coralSoft }]}>
          <Feather name="info" size={13} color={colors.coral} />
          <Text style={[styles.fulfilNoteText, { color: colors.foreground }]}>
            Fulfilment: place this order manually on Meesho using this address.
          </Text>
        </View>
      ) : null}
      {sourceUrls.map((url) => (
        <Pressable key={url} onPress={() => Linking.openURL(url)} style={styles.sourceLink}>
          <Feather name="external-link" size={13} color={colors.moss} />
          <Text style={[styles.sourceLinkText, { color: colors.moss }]} numberOfLines={1}>{url}</Text>
        </Pressable>
      ))}

      <View style={styles.trackingRow}>
        <TextInput
          value={tracking}
          onChangeText={setTracking}
          placeholder="Enter tracking ID"
          placeholderTextColor={colors.mutedForeground}
          style={[styles.trackingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
        />
        <Pressable onPress={() => setTrackingId(order.id, tracking.trim())} style={[styles.trackingSave, { backgroundColor: colors.mossSoft }]}>
          <Feather name="check" size={15} color={colors.moss} />
        </Pressable>
      </View>

      {/* Advance status buttons — only valid forward transitions shown */}
      {nextStatuses.map((nextStatus) => (
        <Pressable
          key={nextStatus}
          onPress={() => handleAdvance(nextStatus)}
          style={[styles.advanceButton, { backgroundColor: colors.moss }]}
        >
          <Text style={styles.advanceText}>Mark as {nextStatus}</Text>
          <Feather name="arrow-right" size={15} color="#FFFFFF" />
        </Pressable>
      ))}

      {/* Seller cancel — only if Cancelled is a valid transition */}
      {ALLOWED_STATUS_TRANSITIONS[order.status]?.includes('Cancelled') ? (
        <Pressable onPress={handleSellerCancel} style={[styles.cancelButton, { borderColor: colors.coral }]}>
          <Feather name="x-circle" size={13} color={colors.coral} />
          <Text style={[styles.cancelText, { color: colors.coral }]}>Cancel order</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function SellerOrdersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { orders } = useStore();
  const [filter, setFilter] = useState<FilterGroup>('Active');

  const paidOrders = orders.filter((order) => order.paymentStatus === 'Paid');
  const visible = paidOrders.filter((o) => matchesFilter(o, filter));

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 14, paddingBottom: 100 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="arrow-left" size={19} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Order fulfilment</Text>
        <View style={{ width: 42 }} />
      </View>

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {FILTER_OPTIONS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[
              styles.filterChip,
              {
                backgroundColor: filter === f ? colors.moss : colors.card,
                borderColor: filter === f ? colors.moss : colors.border,
              },
            ]}
          >
            <Text style={[styles.filterChipText, { color: filter === f ? '#FFFFFF' : colors.mutedForeground }]}>{f}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {!visible.length ? (
        <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="inbox" size={26} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            {paidOrders.length === 0 ? 'No paid orders yet' : `No ${filter.toLowerCase()} orders`}
          </Text>
        </View>
      ) : (
        visible.map((order) => <OrderCard key={order.id} orderId={order.id} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  filterRow: { paddingBottom: 12, gap: 8 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  filterChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  empty: { alignItems: 'center', gap: 10, padding: 36, borderRadius: 20, borderWidth: 1, marginTop: 18 },
  emptyTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  card: { borderWidth: 1, borderRadius: 20, padding: 15, marginBottom: 14 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  orderId: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  date: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  statusPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10 },
  statusText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  customerBlock: { marginTop: 14 },
  customerName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  customerDetail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  itemLine: { fontSize: 12, fontFamily: 'Inter_500Medium', marginTop: 10 },
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTopWidth: 1 },
  moneyLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  moneyValue: { fontSize: 13, fontFamily: 'Inter_700Bold', marginTop: 3 },
  fulfilNote: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 13, padding: 10, marginTop: 14 },
  fulfilNoteText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: 'Inter_500Medium' },
  sourceLink: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8 },
  sourceLinkText: { flex: 1, fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  trackingRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  trackingInput: { flex: 1, height: 44, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, fontSize: 12, fontFamily: 'Inter_400Regular' },
  trackingSave: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  advanceButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 14, marginTop: 10 },
  advanceText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  cancelButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, paddingVertical: 10, borderRadius: 14, borderWidth: 1 },
  cancelText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});
