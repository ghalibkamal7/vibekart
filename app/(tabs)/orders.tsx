import { Feather } from '@expo/vector-icons';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

const statusColor = (status: string, colors: ReturnType<typeof useColors>) => {
  if (status === 'Delivered') return { bg: colors.mossSoft, fg: colors.moss };
  if (status === 'Shipped') return { bg: colors.mossSoft, fg: colors.moss };
  return { bg: colors.coralSoft, fg: colors.coral };
};

export default function OrdersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { orders } = useStore();
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: 120 }]}>
      <Text style={[styles.kicker, { color: colors.coral }]}>YOUR VIBES, ON THE WAY</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>Orders</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>A calm little place to keep an eye on your deliveries.</Text>
      {!orders.length ? (
        <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.mossSoft }]}>
            <Feather name="package" size={25} color={colors.moss} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No orders yet</Text>
          <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>Your next favourite thing will show up here.</Text>
        </View>
      ) : (
        orders.map((order) => {
          const sc = statusColor(order.status, colors);
          return (
            <View key={order.id} style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.orderTop}>
                <View>
                  <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
                  <Text style={[styles.orderDate, { color: colors.mutedForeground }]}>{order.date} · {order.items.length} item{order.items.length > 1 ? 's' : ''}</Text>
                </View>
                <View style={[styles.status, { backgroundColor: sc.bg }]}>
                  <Text style={[styles.statusText, { color: sc.fg }]}>{order.status}</Text>
                </View>
              </View>
              <Text style={[styles.orderProduct, { color: colors.foreground }]} numberOfLines={1}>{order.items.map((item) => item.name).join(' · ')}</Text>
              {order.trackingId ? (
                <View style={styles.trackingRow}>
                  <Feather name="truck" size={13} color={colors.moss} />
                  <Text style={[styles.trackingText, { color: colors.moss }]}>Tracking ID: {order.trackingId}</Text>
                </View>
              ) : null}
              <View style={styles.orderBottom}>
                <Text style={[styles.orderTotal, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                <Text style={[styles.paymentTag, { color: colors.mutedForeground }]}>{order.paymentMethod}</Text>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7 },
  title: { fontSize: 34, fontFamily: 'Inter_700Bold', letterSpacing: -1.5, marginTop: 8 },
  subtitle: { fontSize: 13, lineHeight: 20, fontFamily: 'Inter_400Regular', marginTop: 8, maxWidth: 310 },
  empty: { alignItems: 'center', padding: 30, borderWidth: 1, borderRadius: 22, marginTop: 34 },
  emptyIcon: { width: 58, height: 58, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 17, fontFamily: 'Inter_700Bold', marginTop: 15 },
  emptyBody: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 6, textAlign: 'center' },
  orderCard: { borderWidth: 1, borderRadius: 22, padding: 17, marginTop: 16 },
  orderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  orderId: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  orderDate: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
  status: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10 },
  statusText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  orderProduct: { fontSize: 13, fontFamily: 'Inter_500Medium', marginTop: 22 },
  trackingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  trackingText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  orderBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#E8DDD0' },
  orderTotal: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  paymentTag: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
});
