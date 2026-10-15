import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canCancelOrder, formatPrice, OrderStatus } from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

function statusStyle(
  status: OrderStatus,
  colors: ReturnType<typeof useColors>,
): { bg: string; fg: string } {
  switch (status) {
    case 'Delivered':
      return { bg: colors.mossSoft, fg: colors.moss };
    case 'Shipped':
      return { bg: colors.mossSoft, fg: colors.moss };
    case 'Confirmed':
      return { bg: '#EEF4FF', fg: '#4A6CF7' };
    case 'Processing':
      return { bg: '#FFF8E1', fg: '#F59E0B' };
    case 'Cancelled':
      return { bg: '#F5F5F5', fg: '#9E9E9E' };
    default: // Placed
      return { bg: colors.coralSoft, fg: colors.coral };
  }
}

export default function OrdersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { orders, cancelOrder } = useStore();

  const handleCancel = (orderId: string) => {
    Alert.alert(
      'Cancel order?',
      'This action cannot be undone. Are you sure you want to cancel this order?',
      [
        { text: 'Keep order', style: 'cancel' },
        {
          text: 'Yes, cancel',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelOrder(orderId);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Failed to cancel order.';
              Alert.alert('Cannot cancel', msg);
            }
          },
        },
      ],
    );
  };

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
          const sc = statusStyle(order.status, colors);
          const cancellable = canCancelOrder(order.status);
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
              <View style={[styles.orderBottom, { borderTopColor: colors.border }]}>
                <View>
                  <Text style={[styles.orderTotal, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                  {order.paymentReference ? (
                    <Text style={[styles.refText, { color: colors.mutedForeground }]}>UPI Ref: {order.paymentReference}</Text>
                  ) : null}
                </View>
                <View style={styles.paymentStatusContainer}>
                  <Text style={[styles.paymentTag, { color: colors.mutedForeground }]}>{order.paymentMethod}</Text>
                  <View style={[
                    styles.paymentBadge,
                    {
                      backgroundColor:
                        order.paymentStatus === 'Paid'
                          ? colors.mossSoft
                          : order.paymentStatus === 'Failed'
                          ? colors.coralSoft
                          : '#FFF8E1',
                    },
                  ]}>
                    <Text style={[
                      styles.paymentBadgeText,
                      {
                        color:
                          order.paymentStatus === 'Paid'
                            ? colors.moss
                            : order.paymentStatus === 'Failed'
                            ? colors.coral
                            : '#D97706',
                      },
                    ]}>
                      {order.paymentStatus === 'Paid' ? 'Paid' : order.paymentStatus === 'Failed' ? 'Failed' : 'Payment Pending'}
                    </Text>
                  </View>
                </View>
              </View>
              {cancellable ? (
                <Pressable
                  onPress={() => handleCancel(order.id)}
                  style={[styles.cancelButton, { borderColor: colors.coral }]}
                >
                  <Feather name="x-circle" size={14} color={colors.coral} />
                  <Text style={[styles.cancelText, { color: colors.coral }]}>Cancel order</Text>
                </Pressable>
              ) : null}
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
  orderBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingTop: 14, borderTopWidth: 1 },
  orderTotal: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  refText: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2 },
  paymentStatusContainer: { alignItems: 'flex-end', gap: 4 },
  paymentTag: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  paymentBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  paymentBadgeText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  cancelButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 9, borderRadius: 12, borderWidth: 1 },
  cancelText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});
