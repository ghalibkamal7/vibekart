import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice, OrderStatus } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

const statuses: OrderStatus[] = ['Placed', 'Processing', 'Shipped', 'Delivered'];

function OrderCard({ orderId }: { orderId: string }) {
  const colors = useColors();
  const { orders, updateOrderStatus, setTrackingId } = useStore();
  const order = orders.find((o) => o.id === orderId)!;
  const [tracking, setTracking] = useState(order.trackingId ?? '');

  const nextStatus = () => {
    const idx = statuses.indexOf(order.status);
    if (idx < statuses.length - 1) updateOrderStatus(order.id, statuses[idx + 1]);
  };

  const sourceUrls = Array.from(new Set(order.items.map((item) => item.sourceUrl).filter(Boolean))) as string[];

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.topRow}>
        <View>
          <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
          <Text style={[styles.date, { color: colors.mutedForeground }]}>{order.date} · {order.paymentMethod}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: colors.coralSoft }]}>
          <Text style={[styles.statusText, { color: colors.coral }]}>{order.status}</Text>
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
          <Text style={[styles.moneyValue, { color: colors.foreground }]}>{formatPrice(order.costTotal)}</Text>
        </View>
        <View>
          <Text style={[styles.moneyLabel, { color: colors.mutedForeground }]}>Profit</Text>
          <Text style={[styles.moneyValue, { color: colors.moss }]}>{formatPrice(order.profitTotal)}</Text>
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

      {order.status !== 'Delivered' ? (
        <Pressable onPress={nextStatus} style={[styles.advanceButton, { backgroundColor: colors.moss }]}>
          <Text style={styles.advanceText}>
            Mark as {statuses[statuses.indexOf(order.status) + 1]}
          </Text>
          <Feather name="arrow-right" size={15} color="#FFFFFF" />
        </Pressable>
      ) : null}
    </View>
  );
}

export default function SellerOrdersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { orders } = useStore();

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 14, paddingBottom: 100 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="arrow-left" size={19} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Order fulfilment</Text>
        <View style={{ width: 42 }} />
      </View>
      {!orders.length ? (
        <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="inbox" size={26} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No orders yet</Text>
        </View>
      ) : (
        orders.map((order) => <OrderCard key={order.id} orderId={order.id} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  empty: { alignItems: 'center', gap: 10, padding: 36, borderRadius: 20, borderWidth: 1, marginTop: 30 },
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
  advanceButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 14, marginTop: 12 },
  advanceText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
});
