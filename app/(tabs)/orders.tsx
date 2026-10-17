import { Feather } from '@expo/vector-icons';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canCancelOrder, formatPrice, OrderStatus } from '@/data/store';
import {
  getCustomerOrderStatusLabel,
  PRODUCT_REQUEST_STATUS_DESCRIPTION,
} from '@/data/customer-order-presentation';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { confirmPlatformAction, showPlatformAlert } from '@/utils/platformDialogs';

const LEGACY_PAYMENT_UI_ENABLED = false;

function statusStyle(
  status: OrderStatus,
  colors: ReturnType<typeof useColors>,
): { bg: string; fg: string } {
  switch (status) {
    case 'New':
      return { bg: colors.coralSoft, fg: colors.coral };
    case 'Ordered on Meesho':
      return { bg: '#EEF4FF', fg: '#4A6CF7' };
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
  const { orders, paymentAttempts, submitPaymentDetails, submitManualOrderUtr, cancelOrder } = useStore();
  const [utrInputs, setUtrInputs] = useState<Record<string, string>>({});
  const [submittingAttemptId, setSubmittingAttemptId] = useState<string | null>(null);
  const [submittingOrderId, setSubmittingOrderId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const paidOrders = orders.filter((order) => order.paymentStatus === 'Paid');
  const requestOrders = orders.filter((order) => order.requestType === 'meesho_manual');
  const pendingManualOrders = orders.filter(
    (order) =>
      order.paymentMethod === 'UPI' &&
      !['Paid', 'Failed'].includes(order.paymentStatus ?? 'Selected') &&
      order.status !== 'Cancelled',
  );
  const unresolvedAttempts = paymentAttempts.filter((attempt) => attempt.status !== 'Paid');

  const handleCancel = (orderId: string) => {
    confirmPlatformAction(
      'Cancel order?',
      'This action cannot be undone. Are you sure you want to cancel this order?',
      'Yes, cancel',
      async () => {
        if (cancellingOrderId) return;
        setCancellingOrderId(orderId);
        try {
          await cancelOrder(orderId);
          showPlatformAlert('Order cancelled', 'Your order has been cancelled. No refund is implied by this status.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to cancel order.';
          showPlatformAlert('Cannot cancel', msg);
        } finally {
          setCancellingOrderId(null);
        }
      },
      true,
    );
  };

  const handleSubmitPaymentDetails = async (attemptId: string, existingUtr?: string) => {
    const customerUtr = (utrInputs[attemptId] ?? existingUtr ?? '').trim();
    if (!customerUtr) {
      showPlatformAlert('UTR required', 'Enter the UTR/reference number from your payment app. You can leave the attempt pending until you find it.');
      return;
    }
    setSubmittingAttemptId(attemptId);
    try {
      await submitPaymentDetails(attemptId, customerUtr);
      showPlatformAlert('Submitted', 'Payment details submitted. Your payment is awaiting verification.');
    } catch (err) {
      showPlatformAlert('Submission failed', err instanceof Error ? err.message : 'Could not submit payment details.');
    } finally {
      setSubmittingAttemptId(null);
    }
  };

  const handleSubmitOrderUtr = async (orderId: string, existingUtr?: string) => {
    const customerUtr = (utrInputs[orderId] ?? existingUtr ?? '').trim();
    if (!customerUtr) {
      showPlatformAlert('UTR required', 'Enter the UTR/reference number from your UPI payment receipt.');
      return;
    }
    setSubmittingOrderId(orderId);
    try {
      await submitManualOrderUtr(orderId, customerUtr);
      showPlatformAlert('Submitted', 'Your UTR is saved as unverified. Payment remains pending until an administrator checks the merchant account.');
    } catch (err) {
      showPlatformAlert('Submission failed', err instanceof Error ? err.message : 'Could not submit the UTR.');
    } finally {
      setSubmittingOrderId(null);
    }
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: 120 }]}>
      <Text style={[styles.kicker, { color: colors.coral }]}>YOUR VIBES, ON THE WAY</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>Orders</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>A calm little place to keep an eye on your deliveries.</Text>
      {requestOrders.length > 0 ? (
        <View style={styles.attemptSection}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Product requests ({requestOrders.length})</Text>
          {requestOrders.map((order) => {
            const sc = statusStyle(order.status, colors);
            return (
              <View key={order.id} style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.orderTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
                    <Text style={[styles.orderDate, { color: colors.mutedForeground }]}>
                      Request submitted {order.createdAt ? new Date(order.createdAt).toLocaleString() : order.date}
                    </Text>
                  </View>
                  <View style={[styles.status, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.fg }]}>{getCustomerOrderStatusLabel(order.status)}</Text>
                  </View>
                </View>
                <Text style={[styles.orderProduct, { color: colors.foreground }]}>
                  {order.items.map((item) => `${item.name} × ${item.quantity}`).join(' · ')}
                </Text>
                <Text style={[styles.attemptHelp, { color: colors.mutedForeground, marginTop: 8 }]}>
                  Delivery to: {order.customerAddress}
                </Text>
                <Text style={[styles.attemptHelp, { color: colors.mutedForeground }]}>
                  {PRODUCT_REQUEST_STATUS_DESCRIPTION}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {LEGACY_PAYMENT_UI_ENABLED && pendingManualOrders.length > 0 ? (
        <View style={styles.attemptSection}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Pending UPI Orders ({pendingManualOrders.length})</Text>
          <Text style={[styles.attemptHelp, { color: colors.mutedForeground }]}>
            Orders stay unpaid until an administrator verifies the actual merchant-account credit. A submitted UTR is not proof of payment.
          </Text>
          {pendingManualOrders.map((order) => {
            const value = utrInputs[order.id] ?? order.customerUtr ?? '';
            return (
              <View key={order.id} style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.orderTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
                    <Text style={[styles.orderDate, { color: colors.mutedForeground }]}>{order.date} · {order.items.length} item{order.items.length === 1 ? '' : 's'}</Text>
                  </View>
                  <View style={[styles.status, { backgroundColor: '#FFF8E1' }]}>
                    <Text style={[styles.statusText, { color: '#D97706' }]}>Awaiting payment review</Text>
                  </View>
                </View>
                <Text style={[styles.orderProduct, { color: colors.foreground }]} numberOfLines={2}>
                  {order.items.map((item) => `${item.name} × ${item.quantity}`).join(' · ')}
                </Text>
                <Text style={[styles.orderTotal, { color: colors.foreground, marginTop: 12 }]}>{formatPrice(order.total)}</Text>
                <TextInput
                  value={value}
                  onChangeText={(text) => setUtrInputs((current) => ({ ...current, [order.id]: text }))}
                  placeholder="UPI transaction reference / UTR"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  maxLength={100}
                  style={[styles.utrInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                />
                <Pressable
                  disabled={!value.trim() || submittingOrderId === order.id}
                  onPress={() => handleSubmitOrderUtr(order.id, order.customerUtr)}
                  style={[styles.submitButton, { backgroundColor: value.trim() ? colors.moss : colors.muted }]}
                >
                  {submittingOrderId === order.id ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.submitButtonText}>
                      {order.customerUtr ? 'Update unverified UTR' : 'Submit UTR'}
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
      {LEGACY_PAYMENT_UI_ENABLED && unresolvedAttempts.length > 0 ? (
        <View style={styles.attemptSection}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Pending Payments ({unresolvedAttempts.length})</Text>
          <Text style={[styles.attemptHelp, { color: colors.mutedForeground }]}>
            These are payment attempts, not orders. An order appears here only after the merchant confirms the payment.
          </Text>
          {unresolvedAttempts.map((attempt) => {
            const canSubmit = ['Pending', 'Submitted'].includes(attempt.status);
            const value = utrInputs[attempt.id] ?? attempt.customerUtr ?? '';
            return (
              <View key={attempt.id} style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.orderTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>{attempt.id}</Text>
                    <Text style={[styles.orderDate, { color: colors.mutedForeground }]}>
                      Expires {new Date(attempt.expiresAt).toLocaleString()}
                    </Text>
                  </View>
                  <View style={[styles.status, { backgroundColor: attempt.status === 'Submitted' ? '#FFF8E1' : colors.coralSoft }]}>
                    <Text style={[styles.statusText, { color: attempt.status === 'Submitted' ? '#D97706' : colors.coral }]}>
                      {attempt.status === 'Submitted' ? 'Awaiting verification' : attempt.status}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.orderProduct, { color: colors.foreground }]} numberOfLines={2}>
                  {attempt.items.map((item) => `${item.name} × ${item.quantity}`).join(' · ')}
                </Text>
                <View style={[styles.orderBottom, { borderTopColor: colors.border }]}>
                  <View>
                    <Text style={[styles.orderTotal, { color: colors.foreground }]}>{formatPrice(attempt.total)}</Text>
                    {attempt.deliveryCharge !== undefined ? (
                      <Text style={[styles.refText, { color: colors.mutedForeground }]}>
                        Delivery: {attempt.deliveryCharge ? formatPrice(attempt.deliveryCharge) : 'No charge'}
                      </Text>
                    ) : null}
                    {attempt.deliveryMinDays !== undefined && attempt.deliveryMaxDays !== undefined ? (
                      <Text style={[styles.refText, { color: colors.mutedForeground }]}>
                        Estimated delivery: {attempt.deliveryMinDays}–{attempt.deliveryMaxDays} working days
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.paymentTag, { color: colors.mutedForeground }]}>UPI · {attempt.id.slice(-8)}</Text>
                </View>
                {canSubmit ? (
                  <>
                    <Text style={[styles.attemptHelp, { color: colors.mutedForeground }]}>
                      {attempt.customerUtr ? 'Submitted UTR (unverified)' : 'Paid but cannot find the UTR? Leave this pending and return later.'}
                    </Text>
                    <TextInput
                      value={value}
                      onChangeText={(text) => setUtrInputs((current) => ({ ...current, [attempt.id]: text }))}
                      placeholder="UPI transaction reference / UTR"
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="none"
                      maxLength={100}
                      style={[styles.utrInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    />
                    <Pressable
                      disabled={!value.trim() || submittingAttemptId === attempt.id}
                      onPress={() => handleSubmitPaymentDetails(attempt.id, attempt.customerUtr)}
                      style={[styles.submitButton, { backgroundColor: value.trim() ? colors.moss : colors.muted }]}
                    >
                      {submittingAttemptId === attempt.id ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <Text style={styles.submitButtonText}>
                          {attempt.customerUtr ? 'Update payment details' : 'Submit payment details'}
                        </Text>
                      )}
                    </Pressable>
                  </>
                ) : (
                  <Text style={[styles.attemptHelp, { color: colors.coral }]}>
                    {attempt.rejectionReason || `Payment attempt ${attempt.status.toLowerCase()}.`}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
      {!requestOrders.length && !paidOrders.length ? (
        <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.mossSoft }]}>
            <Feather name="package" size={25} color={colors.moss} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No requests or orders yet</Text>
          <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>Product requests you submit will appear here with their current status.</Text>
        </View>
      ) : (
        paidOrders.map((order) => {
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
                  <Text style={[styles.statusText, { color: sc.fg }]}>{getCustomerOrderStatusLabel(order.status)}</Text>
                </View>
              </View>
              <Text style={[styles.orderProduct, { color: colors.foreground }]} numberOfLines={1}>{order.items.map((item) => item.name).join(' · ')}</Text>
              {order.trackingId ? (
                <View style={styles.trackingRow}>
                  <Feather name="truck" size={13} color={colors.moss} />
                  <Text style={[styles.trackingText, { color: colors.moss }]}>Tracking ID: {order.trackingId}</Text>
                </View>
              ) : null}
              {order.status === 'Cancelled' && order.cancellationReason ? (
                <Text style={[styles.attemptHelp, { color: colors.mutedForeground }]}>
                  Cancellation: {order.cancellationReason}
                </Text>
              ) : null}
              <View style={[styles.orderBottom, { borderTopColor: colors.border }]}>
                <View>
                  <View>
                    <Text style={[styles.orderTotal, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                    {order.deliveryCharge !== undefined ? (
                      <Text style={[styles.refText, { color: colors.mutedForeground }]}>
                        Delivery: {order.deliveryCharge ? formatPrice(order.deliveryCharge) : 'No charge'}
                      </Text>
                    ) : null}
                    {order.deliveryMinDays !== undefined && order.deliveryMaxDays !== undefined ? (
                      <Text style={[styles.refText, { color: colors.mutedForeground }]}>
                        Estimated delivery: {order.deliveryMinDays}–{order.deliveryMaxDays} working days
                      </Text>
                    ) : null}
                  </View>
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
                  disabled={!!cancellingOrderId}
                  onPress={() => handleCancel(order.id)}
                  style={[styles.cancelButton, { borderColor: colors.coral, opacity: cancellingOrderId ? 0.5 : 1 }]}
                >
                  {cancellingOrderId === order.id
                    ? <ActivityIndicator size="small" color={colors.coral} />
                    : <Feather name="x-circle" size={14} color={colors.coral} />}
                  <Text style={[styles.cancelText, { color: colors.coral }]}>
                    {cancellingOrderId === order.id ? 'Cancelling…' : 'Cancel order'}
                  </Text>
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
  attemptSection: { marginTop: 28 },
  sectionTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  attemptHelp: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular', marginTop: 8 },
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
  utrInput: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, marginTop: 10, fontSize: 12 },
  submitButton: { minHeight: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 9 },
  submitButtonText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  cancelButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 9, borderRadius: 12, borderWidth: 1 },
  cancelText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});
