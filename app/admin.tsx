import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ALLOWED_STATUS_TRANSITIONS,
  buildUpiQrUrl,
  buildUpiUri,
  canCancelOrder,
  canTransitionOrderStatus,
  CategoryItem,
  defaultPaymentSettings,
  formatPrice,
  getAssignedProductCount,
  getCategoryDisplayName,
  normalizeSlug,
  Order,
  OrderStatus,
  PaymentAttempt,
  PaymentSettings,
  Product,
  StoreSettings,
  validateStoreSettings,
  validateCategoryName,
} from '@/data/store';
import { useColors } from '@/hooks/useColors';
import { confirmPlatformAction, showPlatformAlert } from '@/utils/platformDialogs';
import { useStore } from '@/context/StoreContext';
import { fetchSellerOrderPrivateData } from '@/services/firebase/firestore';
import { uploadImageToCloudinary } from '@/services/cloudinary/upload';

type AdminTab = 'dashboard' | 'products' | 'categories' | 'orders' | 'pendingPayments' | 'users' | 'payments' | 'settings';

export default function AdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    products,
    categories,
    orders,
    paymentAttempts,
    analytics,
    isAdmin,
    isCloudMode,
    deletingProductId,
    authUser,
    toggleStock,
    toggleEnabled,
    toggleFeatured,
    deleteProduct,
    addCategory,
    updateCategory,
    deleteCategory,
    toggleCategoryEnabled,
    updateOrderStatus,
    verifyPaymentAttempt,
    reviewPaymentAttempt,
    verifyManualUpiOrderPayment,
    rejectManualUpiOrderPayment,
    setTrackingId,
    cancelOrder,
    usersList,
    changeUserRole,
    changeUserStatus,
    storeSettings,
    updateStoreSettings,
    paymentSettings,
    updatePaymentSettings,
    auditLogs,
    logAdminActivity,
  } = useStore();

  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');

  // Products Tab State
  const [productSearch, setProductSearch] = useState('');
  const [productCatFilter, setProductCatFilter] = useState('All');

  // Categories Tab State
  const [newCatName, setNewCatName] = useState('');
  const [newCatIcon, setNewCatIcon] = useState('tag');
  const [addingCat, setAddingCat] = useState(false);
  const [catError, setCatError] = useState('');
  const [catSuccess, setCatSuccess] = useState('');
  const [updatingCategoryId, setUpdatingCategoryId] = useState<string | null>(null);

  // Orders Tab State
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<'All' | OrderStatus>('All');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [orderTrackingInputs, setOrderTrackingInputs] = useState<Record<string, string>>({});
  const [manualUtrInputs, setManualUtrInputs] = useState<Record<string, string>>({});
  const [reviewingPaymentId, setReviewingPaymentId] = useState<string | null>(null);
  const [paymentView, setPaymentView] = useState<'Open' | 'History'>('Open');
  const [orderPrivates, setOrderPrivates] = useState<
    Record<string, { costTotal?: number; profitTotal?: number; items?: any[] }>
  >({});

  // Users Tab State
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState<'All' | 'customer' | 'seller' | 'admin'>('All');

  // Store Settings Tab State
  const [settingsForm, setSettingsForm] = useState<StoreSettings>(storeSettings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSuccess, setSettingsSuccess] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  // Payment Settings Tab State
  const [paymentForm, setPaymentForm] = useState<PaymentSettings>(paymentSettings);
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [uploadingQr, setUploadingQr] = useState(false);

  // Sync settingsForm when storeSettings changes
  React.useEffect(() => {
    setSettingsForm(storeSettings);
  }, [storeSettings]);

  // Sync paymentForm when paymentSettings changes
  React.useEffect(() => {
    setPaymentForm(paymentSettings);
  }, [paymentSettings]);

  // Load private order data on order expand
  const handleToggleExpandOrder = async (orderId: string) => {
    if (expandedOrderId === orderId) {
      setExpandedOrderId(null);
      return;
    }
    setExpandedOrderId(orderId);
    if (!orderPrivates[orderId]) {
      const priv = await fetchSellerOrderPrivateData(orderId);
      if (priv) {
        setOrderPrivates((prev) => ({ ...prev, [orderId]: priv }));
      }
    }
  };

  // ---------------- Guarded Access Check ----------------
  if (!isAdmin) {
    return (
      <View style={[styles.guardScreen, { backgroundColor: colors.background }]}>
        <View style={[styles.guardIconWrap, { backgroundColor: colors.coralSoft }]}>
          <Feather name="shield-off" size={42} color={colors.coral} />
        </View>
        <Text style={[styles.guardTitle, { color: colors.foreground }]}>Access Restricted</Text>
        <Text style={[styles.guardBody, { color: colors.mutedForeground }]}>
          You must be signed in with an authorized Administrator account to view this panel.
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)')}
          style={[styles.guardButton, { backgroundColor: colors.moss }]}
        >
          <Feather name="arrow-left" size={16} color="#FFFFFF" />
          <Text style={styles.guardButtonText}>Return to storefront</Text>
        </Pressable>
      </View>
    );
  }

  // ---------------- Filtered Data Computations ----------------

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesSearch =
        !productSearch.trim() ||
        p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
        p.subtitle.toLowerCase().includes(productSearch.toLowerCase());
      const matchesCategory =
        productCatFilter === 'All' ||
        p.category.toLowerCase() === productCatFilter.toLowerCase();
      return matchesSearch && matchesCategory;
    });
  }, [products, productSearch, productCatFilter]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (o.paymentStatus !== 'Paid') return false;
      const matchesSearch =
        !orderSearch.trim() ||
        o.id.toLowerCase().includes(orderSearch.toLowerCase()) ||
        o.customerName.toLowerCase().includes(orderSearch.toLowerCase()) ||
        o.customerPhone.includes(orderSearch.trim());
      const matchesStatus =
        orderStatusFilter === 'All' || o.status === orderStatusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [orders, orderSearch, orderStatusFilter]);

  const pendingAttempts = paymentAttempts.filter((attempt) => ['Pending', 'Submitted'].includes(attempt.status));
  const paymentAttemptHistory = paymentAttempts.filter((attempt) =>
    ['Rejected', 'Cancelled', 'Expired'].includes(attempt.status),
  );
  const pendingManualUpiOrders = orders.filter((order) =>
    order.paymentMethod === 'UPI' &&
    order.paymentStatus !== 'Paid' &&
    order.paymentStatus !== 'Failed' &&
    order.status !== 'Cancelled',
  );
  const closedManualUpiOrders = orders.filter((order) =>
    order.paymentMethod === 'UPI' &&
    order.paymentStatus !== 'Paid' &&
    (order.paymentStatus === 'Failed' || order.status === 'Cancelled'),
  );

  const filteredUsers = useMemo(() => {
    return usersList.filter((u) => {
      const matchesSearch =
        !userSearch.trim() ||
        u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
        (u.phone && u.phone.includes(userSearch.trim()));
      const matchesRole =
        userRoleFilter === 'All' || u.role === userRoleFilter;
      return matchesSearch && matchesRole;
    });
  }, [usersList, userSearch, userRoleFilter]);

  // Handle Add Category
  const handleAddCategory = async () => {
    if (addingCat) return;
    setCatError('');
    setCatSuccess('');
    const validation = validateCategoryName(newCatName, categories);
    if (!validation.valid) {
      setCatError(validation.error || 'Invalid category name.');
      return;
    }
    setAddingCat(true);
    try {
      const categoryName = newCatName.trim();
      await addCategory({ name: categoryName, icon: newCatIcon });
      setNewCatName('');
      setCatSuccess(`"${categoryName}" was added.`);
      try {
        await logAdminActivity('Add Category', `Created category "${categoryName}"`);
      } catch (err) {
        setCatError(`Category was added, but its audit entry could not be saved: ${err instanceof Error ? err.message : 'Unknown error.'}`);
      }
    } catch (err: any) {
      setCatError(err?.message || 'Failed to add category.');
    } finally {
      setAddingCat(false);
    }
  };

  // Handle Delete Category
  const handleDeleteCategory = (cat: CategoryItem) => {
    const assigned = getAssignedProductCount(cat, products);
    if (assigned > 0) {
      showPlatformAlert(
        'Cannot Delete Category',
        `"${cat.name}" has ${assigned} product${assigned > 1 ? 's' : ''} assigned to it. Please reassign or delete those products before removing this category.`,
      );
      return;
    }
    confirmPlatformAction(
      'Delete Category?',
      `Are you sure you want to permanently delete "${cat.name}"?`,
      'Delete',
      async () => {
        try {
          await deleteCategory(cat.id);
          await logAdminActivity('Delete Category', `Deleted category "${cat.name}" (${cat.id})`, cat.id);
        } catch (err: any) {
          showPlatformAlert('Error', err?.message || 'Failed to delete category.');
        }
      },
      true,
    );
  };

  const handleToggleCategoryEnabled = async (category: CategoryItem) => {
    if (updatingCategoryId) return;
    setUpdatingCategoryId(category.id);
    setCatError('');
    setCatSuccess('');
    try {
      await toggleCategoryEnabled(category.id);
    } catch (err: any) {
      setCatError(err?.message || 'Failed to update category status.');
    } finally {
      setUpdatingCategoryId(null);
    }
  };

  // Handle Delete Product
  const handleDeleteProduct = (p: Product) => {
    confirmPlatformAction(
      'Delete Product?',
      `Are you sure you want to permanently remove "${p.name}" from the store?`,
      'Delete',
      async () => {
        if (deletingProductId) return;
        try {
          await deleteProduct(p.id);
          await logAdminActivity('Delete Product', `Deleted product "${p.name}" (${p.id})`, p.id);
          showPlatformAlert('Product deleted', `"${p.name}" and its stored images were removed.`);
        } catch (err: any) {
          showPlatformAlert('Error', err?.message || 'Failed to delete product.');
        }
      },
      true,
    );
  };

  // Handle Order Status Advance
  const handleAdvanceOrderStatus = async (order: Order, nextStatus: OrderStatus) => {
    try {
      await updateOrderStatus(order.id, nextStatus);
      await logAdminActivity('Update Order Status', `Updated order ${order.id} to ${nextStatus}`, order.id);
    } catch (err: any) {
      showPlatformAlert('Transition Error', err?.message || 'Cannot advance order status.');
    }
  };

  // Handle Order Cancel
  const handleAdminCancelOrder = (order: Order) => {
    if (!canCancelOrder(order.status) && order.status !== 'Processing') {
      showPlatformAlert('Cannot Cancel', `Orders in "${order.status}" status cannot be cancelled.`);
      return;
    }
    confirmPlatformAction(
      'Cancel Order?',
      `Are you sure you want to cancel order ${order.id}?`,
      'Yes, Cancel',
      async () => {
        if (cancellingOrderId) return;
        setCancellingOrderId(order.id);
        try {
          await cancelOrder(order.id);
          await logAdminActivity('Cancel Order', `Cancelled order ${order.id}`, order.id);
          showPlatformAlert('Order cancelled', `Order ${order.id} was cancelled. This action does not issue a refund.`);
        } catch (err: any) {
          showPlatformAlert('Error', err?.message || 'Failed to cancel order.');
        } finally {
          setCancellingOrderId(null);
        }
      },
      true,
    );
  };

  // Handle Save Settings
  const handleSaveSettings = async () => {
    const validationError = validateStoreSettings(settingsForm);
    if (validationError) {
      showPlatformAlert('Check delivery settings', validationError);
      return;
    }
    setSavingSettings(true);
    setSettingsSuccess(false);
    try {
      await updateStoreSettings(settingsForm);
      setSettingsSuccess(true);
      setTimeout(() => setSettingsSuccess(false), 3000);
    } catch (err: any) {
      showPlatformAlert('Error', err?.message || 'Failed to save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  // Handle Save Payment Settings
  const handleSavePaymentSettings = async () => {
    setSavingPayment(true);
    setPaymentSuccess(false);
    try {
      await updatePaymentSettings(paymentForm);
      setPaymentSuccess(true);
      setTimeout(() => setPaymentSuccess(false), 3000);
    } catch (err: any) {
      showPlatformAlert('Error', err?.message || 'Failed to save payment settings.');
    } finally {
      setSavingPayment(false);
    }
  };

  // Handle Pick and Upload QR image via Cloudinary
  const handlePickQrImage = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });
      if (!res.canceled && res.assets?.[0]?.uri) {
        setUploadingQr(true);
        const uploadResult = await uploadImageToCloudinary(res.assets[0].uri, 'vibekart/payment');
        setPaymentForm((prev) => ({
          ...prev,
          qrImageUrl: uploadResult.url,
          qrImagePublicId: uploadResult.publicId,
        }));
      }
    } catch (err: any) {
      showPlatformAlert('Upload Failed', err?.message || 'Could not upload QR image to Cloudinary.');
    } finally {
      setUploadingQr(false);
    }
  };

  const handleVerifyPaymentAttempt = (attempt: PaymentAttempt) => {
    confirmPlatformAction(
      'Verify & confirm payment?',
      `Before continuing, check the merchant's Google Pay/PhonePe/bank transaction history. Confirm that the actual credit matches ${formatPrice(attempt.total)} and the submitted reference "${attempt.customerUtr ?? 'Not available'}". Customer-submitted details are unverified and are not proof of payment.`,
      'I verified the actual credit',
      async () => {
        setReviewingPaymentId(attempt.id);
        try {
          await verifyPaymentAttempt(attempt.id);
          const auditError = await savePaymentReviewAudit(
            'Confirm Payment',
            `Verified payment attempt ${attempt.id}`,
            attempt.id,
          );
          showPaymentReviewOutcome(
            'Payment confirmed',
            'A paid order is now available in Orders and fulfillment.',
            auditError,
          );
        } catch (err) {
          showPlatformAlert('Verification failed', err instanceof Error ? err.message : 'Could not confirm payment.');
        } finally {
          setReviewingPaymentId(null);
        }
      },
    );
  };

  const handleReviewPaymentAttempt = (action: 'reject' | 'cancel' | 'expire', attempt: PaymentAttempt) => {
    const label = action === 'reject' ? 'Reject payment' : action === 'expire' ? 'Expire attempt' : 'Cancel attempt';
    const reason = action === 'reject'
      ? 'Payment was not found in the merchant account after review.'
      : action === 'expire'
        ? 'Attempt manually expired after merchant-account reconciliation.'
        : 'Attempt cancelled by admin after merchant-account reconciliation.';
    confirmPlatformAction(
      `${label}?`,
      'Review the merchant transaction history first. Do not cancel or expire an attempt if a payment may have succeeded and still needs reconciliation.',
      label,
      async () => {
        setReviewingPaymentId(attempt.id);
        try {
          await reviewPaymentAttempt(action, attempt.id, reason);
          const auditError = await savePaymentReviewAudit(label, `${label} ${attempt.id}: ${reason}`, attempt.id);
          showPaymentReviewOutcome(`${label} complete`, `Payment attempt ${attempt.id} was updated.`, auditError);
        } catch (err) {
          showPlatformAlert('Update failed', err instanceof Error ? err.message : 'Could not update payment attempt.');
        } finally {
          setReviewingPaymentId(null);
        }
      },
      true,
    );
  };

  const savePaymentReviewAudit = async (action: string, details: string, targetId: string) => {
    try {
      await logAdminActivity(action, details, targetId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown audit logging error.';
    }
  };

  const showPaymentReviewOutcome = (title: string, message: string, auditError: string | null) => {
    showPlatformAlert(
      auditError ? `${title} — audit log failed` : title,
      auditError ? `${message}\n\nThe payment action succeeded, but its audit entry could not be saved: ${auditError}` : message,
    );
  };

  const handleVerifyManualUpiOrder = (order: Order) => {
    const customerUtr = (manualUtrInputs[order.id] ?? order.customerUtr ?? '').trim();
    if (!customerUtr) {
      showPlatformAlert('Reference required', 'Enter the transaction reference that you independently matched to the actual merchant-account credit.');
      return;
    }
    confirmPlatformAction(
      'Verify manual UPI payment?',
      `Check the actual merchant-account credit for ${formatPrice(order.total)} and reference "${customerUtr}". Customer-submitted data alone is not proof.`,
      'I verified the actual credit',
      async () => {
        setReviewingPaymentId(order.id);
        try {
          await verifyManualUpiOrderPayment(order.id, customerUtr);
          showPlatformAlert('Payment confirmed', 'The order is now paid and eligible for fulfillment.');
        } catch (err) {
          showPlatformAlert('Verification failed', err instanceof Error ? err.message : 'Could not confirm payment.');
        } finally {
          setReviewingPaymentId(null);
        }
      },
    );
  };

  const handleRejectManualUpiOrder = (order: Order) => {
    confirmPlatformAction(
      'Reject manual UPI payment?',
      'Use this only after checking the merchant account and determining that the payment was not received. This will cancel the unpaid order.',
      'Reject and cancel',
      async () => {
        setReviewingPaymentId(order.id);
        try {
          await rejectManualUpiOrderPayment(order.id, 'Payment was not found in merchant account after review.');
          showPlatformAlert('Payment rejected', 'The unpaid order was cancelled.');
        } catch (err) {
          showPlatformAlert('Update failed', err instanceof Error ? err.message : 'Could not reject payment.');
        } finally {
          setReviewingPaymentId(null);
        }
      },
      true,
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {/* ---------------- Top App Header ---------------- */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <Pressable onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
            <Feather name="arrow-left" size={18} color={colors.foreground} />
          </Pressable>
          <View>
            <View style={styles.headerTitleRow}>
              <Text style={[styles.headerTitle, { color: colors.foreground }]}>Admin Panel</Text>
              <View style={[styles.roleBadge, { backgroundColor: '#4A6CF7' }]}>
                <Text style={styles.roleBadgeText}>ADMIN</Text>
              </View>
            </View>
            <Text style={[styles.headerSubtitle, { color: colors.mutedForeground }]}>
              {storeSettings.storeName} Management Console
            </Text>
          </View>
        </View>

        <Pressable
          onPress={() => router.push('/(tabs)')}
          style={[styles.storefrontBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name="external-link" size={14} color={colors.moss} />
          <Text style={[styles.storefrontBtnText, { color: colors.moss }]}>View Store</Text>
        </Pressable>
      </View>

      {/* ---------------- Responsive Navigation Bar ---------------- */}
      <View style={[styles.tabBarWrap, { borderBottomColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
          {(
            [
              { key: 'dashboard', label: 'Dashboard', icon: 'grid' },
              { key: 'products', label: `Products (${products.length})`, icon: 'package' },
              { key: 'categories', label: `Categories (${categories.length})`, icon: 'tag' },
              { key: 'orders', label: `Orders (${orders.filter((order) => order.paymentStatus === 'Paid').length})`, icon: 'shopping-bag' },
              { key: 'pendingPayments', label: `Pending Payments (${pendingAttempts.length + pendingManualUpiOrders.length})`, icon: 'credit-card' },
              { key: 'users', label: `Users & Sellers (${usersList.length})`, icon: 'users' },
              { key: 'payments', label: 'Payment Settings', icon: 'credit-card' },
              { key: 'settings', label: 'Store Settings', icon: 'settings' },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={[
                  styles.tabItem,
                  active && { borderBottomColor: colors.moss, borderBottomWidth: 3 },
                ]}
              >
                <Feather
                  name={tab.icon as any}
                  size={16}
                  color={active ? colors.moss : colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.tabLabel,
                    { color: active ? colors.moss : colors.mutedForeground, fontFamily: active ? 'Inter_700Bold' : 'Inter_500Medium' },
                  ]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* ---------------- Tab Content ---------------- */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 18, paddingBottom: 120 }}
      >
        {/* ==================== 1. DASHBOARD TAB ==================== */}
        {activeTab === 'dashboard' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Operational Overview</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Real-time store metrics computed from authoritative orders and product records.
            </Text>

            {/* Metrics Grid */}
            <View style={styles.kpiGrid}>
              <View style={[styles.kpiCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.kpiIcon, { backgroundColor: colors.mossSoft }]}>
                  <Feather name="trending-up" size={18} color={colors.moss} />
                </View>
                <Text style={[styles.kpiVal, { color: colors.foreground }]}>{formatPrice(analytics.totalRevenue)}</Text>
                <Text style={[styles.kpiLabel, { color: colors.mutedForeground }]}>Gross Sales</Text>
                <Text style={[styles.kpiSub, { color: colors.moss }]}>Non-cancelled orders</Text>
              </View>

              <View style={[styles.kpiCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.kpiIcon, { backgroundColor: '#EEF4FF' }]}>
                  <Feather name="pie-chart" size={18} color="#4A6CF7" />
                </View>
                <Text style={[styles.kpiVal, { color: '#4A6CF7' }]}>{formatPrice(analytics.totalProfit)}</Text>
                <Text style={[styles.kpiLabel, { color: colors.mutedForeground }]}>Estimated Margin</Text>
                <Text style={[styles.kpiSub, { color: colors.mutedForeground }]}>
                  {analytics.marginPercent}% avg margin
                </Text>
              </View>

              <View style={[styles.kpiCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.kpiIcon, { backgroundColor: colors.coralSoft }]}>
                  <Feather name="shopping-bag" size={18} color={colors.coral} />
                </View>
                <Text style={[styles.kpiVal, { color: colors.foreground }]}>{analytics.ordersCount}</Text>
                <Text style={[styles.kpiLabel, { color: colors.mutedForeground }]}>Total Orders</Text>
                <Text style={[styles.kpiSub, { color: colors.coral }]}>
                  {analytics.activeOrdersCount} pending / active
                </Text>
              </View>

              <View style={[styles.kpiCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.kpiIcon, { backgroundColor: '#FFF8E1' }]}>
                  <Feather name="package" size={18} color="#F59E0B" />
                </View>
                <Text style={[styles.kpiVal, { color: colors.foreground }]}>{products.length}</Text>
                <Text style={[styles.kpiLabel, { color: colors.mutedForeground }]}>Catalogue Items</Text>
                <Text style={[styles.kpiSub, { color: '#F59E0B' }]}>
                  {analytics.lowStockCount} out of stock
                </Text>
              </View>
            </View>

            {/* Quick Actions */}
            <Text style={[styles.subSectionTitle, { color: colors.foreground, marginTop: 22 }]}>Quick Controls</Text>
            <View style={styles.quickRow}>
              <Pressable
                onPress={() => router.push('/seller-add-product')}
                style={[styles.actionBtn, { backgroundColor: colors.coral }]}
              >
                <Feather name="plus" size={16} color="#FFFFFF" />
                <Text style={styles.actionBtnText}>Add Product</Text>
              </Pressable>
              <Pressable
                onPress={() => setActiveTab('categories')}
                style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
              >
                <Feather name="tag" size={16} color={colors.moss} />
                <Text style={[styles.actionBtnText, { color: colors.moss }]}>Manage Categories</Text>
              </Pressable>
              <Pressable
                onPress={() => setActiveTab('orders')}
                style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
              >
                <Feather name="truck" size={16} color={colors.moss} />
                <Text style={[styles.actionBtnText, { color: colors.moss }]}>Fulfil Orders</Text>
              </Pressable>
            </View>

            {/* Recent Orders Overview */}
            <Text style={[styles.subSectionTitle, { color: colors.foreground, marginTop: 24 }]}>Recent Orders</Text>
            {orders.slice(0, 5).map((order) => (
              <View
                key={order.id}
                style={[styles.summaryRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.summaryTitle, { color: colors.foreground }]}>{order.id}</Text>
                  <Text style={[styles.summarySub, { color: colors.mutedForeground }]}>
                    {order.customerName} · {order.items.length} items · {order.date}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={[styles.summaryPrice, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                  <View
                    style={[
                      styles.statusTag,
                      {
                        backgroundColor:
                          order.status === 'Delivered'
                            ? colors.mossSoft
                            : order.status === 'Cancelled'
                            ? '#F5F5F5'
                            : colors.coralSoft,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusTagText,
                        {
                          color:
                            order.status === 'Delivered'
                              ? colors.moss
                              : order.status === 'Cancelled'
                              ? '#9E9E9E'
                              : colors.coral,
                        },
                      ]}
                    >
                      {order.status}
                    </Text>
                  </View>
                </View>
              </View>
            ))}

            {/* Recent Audit Logs */}
            <Text style={[styles.subSectionTitle, { color: colors.foreground, marginTop: 26 }]}>
              Administrative Activity Logs
            </Text>
            {auditLogs.length === 0 ? (
              <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                <Feather name="file-text" size={24} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No administrative actions logged yet.
                </Text>
              </View>
            ) : (
              auditLogs.slice(0, 8).map((log) => (
                <View
                  key={log.id}
                  style={[styles.auditRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={[styles.auditDot, { backgroundColor: '#4A6CF7' }]} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.auditHeader}>
                      <Text style={[styles.auditAction, { color: colors.foreground }]}>{log.action}</Text>
                      <Text style={[styles.auditTime, { color: colors.mutedForeground }]}>
                        {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                    <Text style={[styles.auditDetails, { color: colors.mutedForeground }]}>{log.details}</Text>
                    <Text style={[styles.auditUser, { color: colors.mutedForeground }]}>By {log.adminEmail}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* ==================== 2. PRODUCTS TAB ==================== */}
        {activeTab === 'products' && (
          <View>
            <View style={styles.rowBetween}>
              <View>
                <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Product Catalogue</Text>
                <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
                  Create, configure pricing formulas, and manage stock & visibility.
                </Text>
              </View>
              <Pressable
                onPress={() => router.push('/seller-add-product')}
                style={[styles.primaryAddBtn, { backgroundColor: colors.coral }]}
              >
                <Feather name="plus" size={16} color="#FFFFFF" />
                <Text style={styles.primaryAddBtnText}>Add Product</Text>
              </Pressable>
            </View>

            {/* Search & Filter Bar */}
            <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="search" size={16} color={colors.mutedForeground} />
              <TextInput
                value={productSearch}
                onChangeText={setProductSearch}
                placeholder="Search products by title..."
                placeholderTextColor={colors.mutedForeground}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {productSearch ? (
                <Pressable onPress={() => setProductSearch('')}>
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>

            {/* Category Filter Chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipRow}>
              {['All', ...categories.map((c) => c.name)].map((cat) => (
                <Pressable
                  key={cat}
                  onPress={() => setProductCatFilter(cat)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: productCatFilter === cat ? colors.moss : colors.card,
                      borderColor: productCatFilter === cat ? colors.moss : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: productCatFilter === cat ? '#FFFFFF' : colors.foreground }]}>
                    {cat}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Products List */}
            {filteredProducts.length === 0 ? (
              <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                <Feather name="package" size={32} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.foreground }]}>No products match your filter.</Text>
              </View>
            ) : (
              filteredProducts.map((p) => {
                const margin = p.price - p.baseCost;
                const isLoss = margin < 0;
                return (
                  <View key={p.id} style={[styles.prodCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <View style={styles.prodHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.prodName, { color: colors.foreground }]}>{p.name}</Text>
                        <Text style={[styles.prodCategory, { color: colors.coral }]}>
                          {getCategoryDisplayName(p.category, categories).toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                          onPress={() => router.push({ pathname: '/seller-add-product', params: { id: p.id } })}
                          style={[styles.iconAction, { backgroundColor: colors.mossSoft }]}
                        >
                          <Feather name="edit-2" size={15} color={colors.moss} />
                        </Pressable>
                        <Pressable
                          disabled={!!deletingProductId}
                          onPress={() => handleDeleteProduct(p)}
                          style={[styles.iconAction, { backgroundColor: '#FEE2E2', opacity: deletingProductId ? 0.5 : 1 }]}
                        >
                          {deletingProductId === p.id
                            ? <ActivityIndicator size="small" color={colors.destructive} />
                            : <Feather name="trash-2" size={15} color={colors.destructive} />}
                        </Pressable>
                      </View>
                    </View>

                    {/* Price & Margin Matrix */}
                    <View style={[styles.priceMatrix, { borderTopColor: colors.border, borderBottomColor: colors.border }]}>
                      <View>
                        <Text style={[styles.matrixLabel, { color: colors.mutedForeground }]}>Supplier Cost</Text>
                        <Text style={[styles.matrixVal, { color: colors.foreground }]}>{formatPrice(p.baseCost)}</Text>
                      </View>
                      <View>
                        <Text style={[styles.matrixLabel, { color: colors.mutedForeground }]}>Sell Price</Text>
                        <Text style={[styles.matrixVal, { color: colors.foreground }]}>{formatPrice(p.price)}</Text>
                      </View>
                      <View>
                        <Text style={[styles.matrixLabel, { color: colors.mutedForeground }]}>Est. Margin</Text>
                        <Text style={[styles.matrixVal, { color: isLoss ? colors.destructive : colors.moss }]}>
                          {formatPrice(margin)} {isLoss ? '(Loss!)' : ''}
                        </Text>
                      </View>
                    </View>

                    {/* Toggles Row */}
                    <View style={styles.togglesRow}>
                      <View style={styles.toggleItem}>
                        <Text style={[styles.toggleLabel, { color: colors.mutedForeground }]}>In Stock</Text>
                        <Switch
                          value={p.inStock}
                          onValueChange={() => toggleStock(p.id)}
                          trackColor={{ false: colors.border, true: colors.mossSoft }}
                          thumbColor={p.inStock ? colors.moss : colors.mutedForeground}
                        />
                      </View>
                      <View style={styles.toggleItem}>
                        <Text style={[styles.toggleLabel, { color: colors.mutedForeground }]}>Active</Text>
                        <Switch
                          value={p.enabled !== false}
                          onValueChange={() => toggleEnabled(p.id)}
                          trackColor={{ false: colors.border, true: colors.mossSoft }}
                          thumbColor={p.enabled !== false ? colors.moss : colors.mutedForeground}
                        />
                      </View>
                      <View style={styles.toggleItem}>
                        <Text style={[styles.toggleLabel, { color: colors.mutedForeground }]}>Featured</Text>
                        <Switch
                          value={p.featured ?? false}
                          onValueChange={() => toggleFeatured(p.id)}
                          trackColor={{ false: colors.border, true: colors.coralSoft }}
                          thumbColor={p.featured ? colors.coral : colors.mutedForeground}
                        />
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* ==================== 3. CATEGORIES TAB ==================== */}
        {activeTab === 'categories' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Category Management</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Organize catalog structure. Categories in use cannot be deleted without reassigning products.
            </Text>

            {/* Add Category Form */}
            <View style={[styles.cardBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardBoxTitle, { color: colors.foreground }]}>Add New Category</Text>
              <View style={styles.formRow}>
                <TextInput
                  value={newCatName}
                  onChangeText={(t) => {
                    setNewCatName(t);
                    setCatError('');
                  }}
                  placeholder="e.g. Living, Lighting, Kitchen"
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.formInput, { flex: 1, backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                />
                <Pressable
                  disabled={addingCat || !newCatName.trim()}
                  onPress={handleAddCategory}
                  style={[
                    styles.formBtn,
                    { backgroundColor: newCatName.trim() ? colors.coral : colors.muted },
                  ]}
                >
                  {addingCat ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <>
                      <Feather name="plus" size={16} color="#FFFFFF" />
                      <Text style={styles.formBtnText}>Add</Text>
                    </>
                  )}
                </Pressable>
              </View>
              {catError ? <Text style={styles.errorText}>{catError}</Text> : null}
              {catSuccess ? <Text style={[styles.errorText, { color: colors.moss }]}>{catSuccess}</Text> : null}
            </View>

            {/* Categories List */}
            <Text style={[styles.subSectionTitle, { color: colors.foreground, marginTop: 20 }]}>
              Existing Categories ({categories.length})
            </Text>
            {categories.map((cat) => {
              const assigned = getAssignedProductCount(cat, products);
              return (
                <View
                  key={cat.id}
                  style={[styles.catRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={[styles.catIconWrap, { backgroundColor: colors.mossSoft }]}>
                    <Feather name={(cat.icon ?? 'tag') as any} size={18} color={colors.moss} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.catName, { color: colors.foreground }]}>{cat.name}</Text>
                    <Text style={[styles.catMeta, { color: colors.mutedForeground }]}>
                      Slug: /{cat.slug} · {assigned} assigned product{assigned === 1 ? '' : 's'}
                    </Text>
                  </View>

                  <View style={styles.catActions}>
                    <Switch
                      value={cat.enabled}
                      disabled={!!updatingCategoryId}
                      onValueChange={() => handleToggleCategoryEnabled(cat)}
                      trackColor={{ false: colors.border, true: colors.mossSoft }}
                      thumbColor={cat.enabled ? colors.moss : colors.mutedForeground}
                    />
                    <Pressable
                      onPress={() => handleDeleteCategory(cat)}
                      style={[styles.deleteIconBtn, { backgroundColor: '#FEE2E2' }]}
                    >
                      <Feather name="trash-2" size={14} color={colors.destructive} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* ==================== 4. ORDERS TAB ==================== */}
        {activeTab === 'orders' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Order Management</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Authoritative order tracking, fulfillment and private supplier cost insights.
            </Text>

            {/* Search Box */}
            <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="search" size={16} color={colors.mutedForeground} />
              <TextInput
                value={orderSearch}
                onChangeText={setOrderSearch}
                placeholder="Search by Order ID or customer phone..."
                placeholderTextColor={colors.mutedForeground}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {orderSearch ? (
                <Pressable onPress={() => setOrderSearch('')}>
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>

            {/* Status Filter Chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipRow}>
              {(['All', 'Placed', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'] as const).map(
                (st) => (
                  <Pressable
                    key={st}
                    onPress={() => setOrderStatusFilter(st)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: orderStatusFilter === st ? colors.moss : colors.card,
                        borderColor: orderStatusFilter === st ? colors.moss : colors.border,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: orderStatusFilter === st ? '#FFFFFF' : colors.foreground }]}>
                      {st}
                    </Text>
                  </Pressable>
                ),
              )}
            </ScrollView>

            {/* Orders List */}
            {filteredOrders.length === 0 ? (
              <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                <Feather name="inbox" size={32} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.foreground }]}>No orders match your filter.</Text>
              </View>
            ) : (
              filteredOrders.map((order) => {
                const isExpanded = expandedOrderId === order.id;
                const priv = orderPrivates[order.id];
                const costTotal = priv?.costTotal ?? order.costTotal ?? 0;
                const profitTotal = priv?.profitTotal ?? order.profitTotal ?? (order.total - costTotal);
                const trackingValue = orderTrackingInputs[order.id] ?? (order.trackingId ?? '');
                const nextStatuses: OrderStatus[] = (ALLOWED_STATUS_TRANSITIONS[order.status] ?? []).filter(
                  (s) => s !== 'Cancelled',
                );

                return (
                  <View key={order.id} style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Pressable onPress={() => handleToggleExpandOrder(order.id)} style={styles.orderTopRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.orderId, { color: colors.foreground }]}>{order.id}</Text>
                        <Text style={[styles.orderCustomer, { color: colors.mutedForeground }]}>
                          {order.customerName} · {order.customerPhone} · {order.date}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Text style={[styles.orderTotal, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                        <View style={[styles.statusTag, { backgroundColor: colors.mossSoft }]}>
                          <Text style={[styles.statusTagText, { color: colors.moss }]}>{order.status}</Text>
                        </View>
                      </View>
                    </Pressable>

                    {/* Expandable Details */}
                    {isExpanded && (
                      <View style={[styles.orderExpanded, { borderTopColor: colors.border }]}>
                        {/* Address */}
                        <Text style={[styles.detailHeading, { color: colors.foreground }]}>Delivery Address:</Text>
                        <Text style={[styles.detailText, { color: colors.mutedForeground }]}>{order.customerAddress}</Text>
                        {order.status === 'Cancelled' && order.cancellationReason ? (
                          <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                            Cancellation: {order.cancellationReason}
                          </Text>
                        ) : null}
                        {order.deliveryCharge !== undefined ? (
                          <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                            Delivery charge: {order.deliveryCharge ? formatPrice(order.deliveryCharge) : 'No charge'}
                          </Text>
                        ) : null}
                        {order.deliveryMinDays !== undefined && order.deliveryMaxDays !== undefined ? (
                          <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                            Estimated delivery: {order.deliveryMinDays}–{order.deliveryMaxDays} working days
                          </Text>
                        ) : null}

                        {/* Items */}
                        <Text style={[styles.detailHeading, { color: colors.foreground, marginTop: 10 }]}>Purchased Items:</Text>
                        {order.items.map((item, idx) => (
                          <Text key={idx} style={[styles.itemText, { color: colors.foreground }]}>
                            • {item.name} {item.option ? `(${item.option})` : ''} × {item.quantity} — {formatPrice(item.unitPrice * item.quantity)}
                          </Text>
                        ))}

                        {/* Financial Audit */}
                        <View style={[styles.financialRow, { backgroundColor: colors.background }]}>
                          <View>
                            <Text style={[styles.finLabel, { color: colors.mutedForeground }]}>Customer Total</Text>
                            <Text style={[styles.finVal, { color: colors.foreground }]}>{formatPrice(order.total)}</Text>
                          </View>
                          <View>
                            <Text style={[styles.finLabel, { color: colors.mutedForeground }]}>Supplier Cost</Text>
                            <Text style={[styles.finVal, { color: colors.foreground }]}>{formatPrice(costTotal)}</Text>
                          </View>
                          <View>
                            <Text style={[styles.finLabel, { color: colors.mutedForeground }]}>Est. Profit</Text>
                            <Text style={[styles.finVal, { color: colors.moss }]}>{formatPrice(profitTotal)}</Text>
                          </View>
                        </View>

                        {/* Payment Details & Verification Section */}
                        <View style={[styles.paymentAuditBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={[styles.detailHeading, { color: colors.foreground }]}>Payment Verification</Text>
                            <View
                              style={[
                                styles.paymentBadge,
                                {
                                  backgroundColor:
                                    order.paymentStatus === 'Paid'
                                      ? colors.mossSoft
                                      : order.paymentStatus === 'Failed'
                                      ? colors.coralSoft
                                      : '#FFF8E1',
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.paymentBadgeText,
                                  {
                                    color:
                                      order.paymentStatus === 'Paid'
                                        ? colors.moss
                                        : order.paymentStatus === 'Failed'
                                        ? colors.coral
                                        : '#D97706',
                                  },
                                ]}
                              >
                                {order.paymentStatus === 'Paid'
                                  ? 'Paid (Verified)'
                                  : order.paymentStatus === 'Failed'
                                  ? 'Payment Failed'
                                  : 'Pending Verification'}
                              </Text>
                            </View>
                          </View>

                          <View style={{ marginTop: 6, gap: 2 }}>
                            <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
                              Method: {order.paymentMethod}
                            </Text>
                            {order.paymentReference ? (
                              <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
                                System UPI Ref: {order.paymentReference}
                              </Text>
                            ) : null}
                            {order.customerUtr ? (
                              <Text style={[styles.detailText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                                Verified transaction reference: {order.customerUtr}
                              </Text>
                            ) : (
                              <Text style={[styles.detailText, { color: colors.mutedForeground, fontStyle: 'italic' }]}>
                                Customer UTR: None submitted
                              </Text>
                            )}
                            {order.bankRrn ? (
                              <Text style={[styles.detailText, { color: colors.moss }]}>
                                Bank Settlement RRN: {order.bankRrn}
                              </Text>
                            ) : null}
                          </View>

                          <Text style={[styles.detailText, { color: colors.moss, marginTop: 10 }]}>
                            Payment verified by an authorized administrator.
                          </Text>
                        </View>

                        {/* Tracking Input */}
                        <View style={styles.trackingRow}>
                          <TextInput
                            value={trackingValue}
                            onChangeText={(t) => setOrderTrackingInputs((prev) => ({ ...prev, [order.id]: t }))}
                            placeholder="Enter delivery tracking ID..."
                            placeholderTextColor={colors.mutedForeground}
                            style={[styles.trackingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                          />
                          <Pressable
                            onPress={async () => {
                              await setTrackingId(order.id, trackingValue.trim());
                              await logAdminActivity('Set Tracking ID', `Order ${order.id} tracking: ${trackingValue.trim()}`, order.id);
                              showPlatformAlert('Saved', 'Tracking ID updated successfully.');
                            }}
                            style={[styles.trackingSaveBtn, { backgroundColor: colors.moss }]}
                          >
                            <Feather name="check" size={14} color="#FFFFFF" />
                          </Pressable>
                        </View>

                        {/* Status Transition Buttons */}
                        <View style={styles.transitionBtnRow}>
                          {nextStatuses.map((st) => (
                            <Pressable
                              key={st}
                              onPress={() => handleAdvanceOrderStatus(order, st)}
                              style={[styles.advanceBtn, { backgroundColor: colors.moss }]}
                            >
                              <Text style={styles.advanceBtnText}>Mark as {st}</Text>
                              <Feather name="arrow-right" size={14} color="#FFFFFF" />
                            </Pressable>
                          ))}
                          {ALLOWED_STATUS_TRANSITIONS[order.status]?.includes('Cancelled') && (
                            <Pressable
                              disabled={cancellingOrderId === order.id}
                              onPress={() => handleAdminCancelOrder(order)}
                              style={[styles.cancelBtn, { borderColor: colors.destructive, opacity: cancellingOrderId ? 0.5 : 1 }]}
                            >
                              {cancellingOrderId === order.id
                                ? <ActivityIndicator size="small" color={colors.destructive} />
                                : <Feather name="x-circle" size={14} color={colors.destructive} />}
                              <Text style={[styles.cancelBtnText, { color: colors.destructive }]}>
                                {cancellingOrderId === order.id ? 'Cancelling…' : 'Cancel Order'}
                              </Text>
                            </Pressable>
                          )}
                        </View>
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* ==================== 5. USERS & SELLERS TAB ==================== */}
        {activeTab === 'users' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Users & Sellers Directory</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Inspect accounts, manage seller roles and control platform access permissions.
            </Text>

            {/* Search Box */}
            <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="search" size={16} color={colors.mutedForeground} />
              <TextInput
                value={userSearch}
                onChangeText={setUserSearch}
                placeholder="Search user by name or email..."
                placeholderTextColor={colors.mutedForeground}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {userSearch ? (
                <Pressable onPress={() => setUserSearch('')}>
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>

            {/* Role Filter Chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChipRow}>
              {(['All', 'seller', 'customer', 'admin'] as const).map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setUserRoleFilter(r)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: userRoleFilter === r ? colors.moss : colors.card,
                      borderColor: userRoleFilter === r ? colors.moss : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: userRoleFilter === r ? '#FFFFFF' : colors.foreground }]}>
                    {r === 'All' ? 'All Roles' : `${r.toUpperCase()}S`}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* User Cards */}
            {filteredUsers.length === 0 ? (
              <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                <Feather name="users" size={32} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.foreground }]}>No users found.</Text>
              </View>
            ) : (
              filteredUsers.map((u) => {
                const isCurrentSelf = authUser && !authUser.isGuest && authUser.uid === u.uid;
                const isSuspended = u.status === 'suspended';

                return (
                  <View key={u.uid} style={[styles.userCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <View style={styles.userTop}>
                      <View style={[styles.avatarCircle, { backgroundColor: colors.mossSoft }]}>
                        <Feather name="user" size={18} color={colors.moss} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={[styles.userName, { color: colors.foreground }]}>{u.name}</Text>
                          {isCurrentSelf && <Text style={[styles.youTag, { color: colors.moss }]}>[You]</Text>}
                        </View>
                        <Text style={[styles.userEmail, { color: colors.mutedForeground }]}>{u.email}</Text>
                        {u.phone ? <Text style={[styles.userPhone, { color: colors.mutedForeground }]}>{u.phone}</Text> : null}
                      </View>

                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <View
                          style={[
                            styles.rolePill,
                            {
                              backgroundColor:
                                u.role === 'admin'
                                  ? '#EEF4FF'
                                  : u.role === 'seller'
                                  ? colors.coralSoft
                                  : colors.background,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.rolePillText,
                              {
                                color:
                                  u.role === 'admin'
                                    ? '#4A6CF7'
                                    : u.role === 'seller'
                                    ? colors.coral
                                    : colors.mutedForeground,
                              },
                            ]}
                          >
                            {u.role.toUpperCase()}
                          </Text>
                        </View>
                        {isSuspended ? (
                          <View style={[styles.suspendedBadge, { backgroundColor: '#FEE2E2' }]}>
                            <Text style={{ color: colors.destructive, fontSize: 9, fontFamily: 'Inter_700Bold' }}>
                              SUSPENDED
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    </View>

                    {/* Action Buttons for Role & Status */}
                    {!isCurrentSelf && (
                      <View style={[styles.userActionRow, { borderTopColor: colors.border }]}>
                        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                          {u.role !== 'seller' && (
                            <Pressable
                              onPress={() => changeUserRole(u.uid, 'seller')}
                              style={[styles.smallActionBtn, { borderColor: colors.coral }]}
                            >
                              <Text style={[styles.smallActionBtnText, { color: colors.coral }]}>Make Seller</Text>
                            </Pressable>
                          )}
                          {u.role !== 'admin' && (
                            <Pressable
                              onPress={() => confirmPlatformAction(
                                'Grant Admin Privilege?',
                                `Promote ${u.name} (${u.email}) to Administrator? They will have full control over the store.`,
                                'Promote',
                                async () => {
                                  try {
                                    await changeUserRole(u.uid, 'admin');
                                  } catch (err) {
                                    showPlatformAlert('Promotion failed', err instanceof Error ? err.message : 'Could not change this user role.');
                                  }
                                },
                                true,
                              )}
                              style={[styles.smallActionBtn, { borderColor: '#4A6CF7' }]}
                            >
                              <Text style={[styles.smallActionBtnText, { color: '#4A6CF7' }]}>Make Admin</Text>
                            </Pressable>
                          )}
                          {u.role !== 'customer' && (
                            <Pressable
                              onPress={() => changeUserRole(u.uid, 'customer')}
                              style={[styles.smallActionBtn, { borderColor: colors.border }]}
                            >
                              <Text style={[styles.smallActionBtnText, { color: colors.mutedForeground }]}>
                                Make Customer
                              </Text>
                            </Pressable>
                          )}
                        </View>

                        {/* Suspend Toggle */}
                        <Pressable
                          onPress={() => changeUserStatus(u.uid, isSuspended ? 'active' : 'suspended')}
                          style={[
                            styles.suspendBtn,
                            { backgroundColor: isSuspended ? colors.mossSoft : '#FEE2E2' },
                          ]}
                        >
                          <Text
                            style={[
                              styles.suspendBtnText,
                              { color: isSuspended ? colors.moss : colors.destructive },
                            ]}
                          >
                            {isSuspended ? 'Reactivate' : 'Suspend'}
                          </Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* ==================== 6. PENDING PAYMENTS TAB ==================== */}
        {activeTab === 'pendingPayments' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Pending Payments</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Manual UPI orders are created with payment pending. Verify actual merchant-account credit before marking paid; submitted UTRs are customer-provided and unverified. Separate payment attempts are an optional Worker-backed flow.
            </Text>
            {!isCloudMode ? (
              <Text style={[styles.sectionSub, { color: colors.coral }]}>
                Sign in as an administrator to review payments. Demo mode cannot confirm or reject real payments.
              </Text>
            ) : null}
            <View style={styles.paymentViewRow}>
              {(['Open', 'History'] as const).map((view) => {
                const active = paymentView === view;
                const count = view === 'Open'
                  ? pendingAttempts.length + pendingManualUpiOrders.length
                  : paymentAttemptHistory.length + closedManualUpiOrders.length;
                return (
                  <Pressable
                    key={view}
                    onPress={() => setPaymentView(view)}
                    style={[
                      styles.paymentViewChip,
                      { backgroundColor: active ? colors.moss : colors.card, borderColor: active ? colors.moss : colors.border },
                    ]}
                  >
                    <Text style={[styles.paymentViewChipText, { color: active ? '#FFFFFF' : colors.foreground }]}>
                      {view} ({count})
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {paymentView === 'Open' ? (
              <>
                {pendingAttempts.map((attempt) => {
                  const expired = Date.parse(attempt.expiresAt) <= Date.now();
                  return (
                    <View key={attempt.id} style={[styles.paymentReviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <View style={styles.paymentReviewHeader}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.orderId, { color: colors.foreground }]}>{attempt.id}</Text>
                          <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
                            {attempt.customerName} · {attempt.customerPhone}{attempt.customerEmail ? ` · ${attempt.customerEmail}` : ''}
                          </Text>
                        </View>
                        <View style={[styles.paymentBadge, { backgroundColor: attempt.status === 'Submitted' ? '#FFF8E1' : colors.coralSoft }]}>
                          <Text style={[styles.paymentBadgeText, { color: attempt.status === 'Submitted' ? '#D97706' : colors.coral }]}>
                            {attempt.status}
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.detailText, { color: colors.foreground, marginTop: 8 }]}>
                        Attempt ID: {attempt.id} · Order ID: Not created
                      </Text>
                      <Text style={[styles.detailText, { color: colors.foreground, marginTop: 4 }]}>
                        Items: {attempt.items.map((item) => `${item.name} × ${item.quantity}`).join(' · ')}
                      </Text>
                      <Text style={[styles.detailText, { color: colors.foreground, marginTop: 4 }]}>
                        Payable: {formatPrice(attempt.total)} · Method: {attempt.paymentMethod}
                      </Text>
                      <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                        Created: {new Date(attempt.createdAt).toLocaleString()} · Expires: {new Date(attempt.expiresAt).toLocaleString()}
                      </Text>
                      <Text style={[styles.detailText, { color: attempt.customerUtr ? '#D97706' : colors.mutedForeground, marginTop: 4 }]}>
                        Submitted UTR (unverified): {attempt.customerUtr || 'Not submitted'}
                      </Text>
                      <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                        Payer UPI ID / name / bank: Not available
                      </Text>
                      {attempt.submittedAt ? (
                        <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                          Submitted: {new Date(attempt.submittedAt).toLocaleString()}
                        </Text>
                      ) : null}
                      <View style={styles.paymentActionRow}>
                        {attempt.status === 'Submitted' ? (
                          <>
                            <Pressable
                              disabled={!isCloudMode || reviewingPaymentId === attempt.id}
                              onPress={() => handleVerifyPaymentAttempt(attempt)}
                              style={[styles.smallVerifyBtn, { backgroundColor: colors.moss }]}
                            >
                              <Feather name="check-circle" size={12} color="#FFFFFF" />
                              <Text style={styles.smallVerifyBtnText}>Verify & Confirm Payment</Text>
                            </Pressable>
                            <Pressable
                              disabled={!isCloudMode || reviewingPaymentId === attempt.id}
                              onPress={() => handleReviewPaymentAttempt('reject', attempt)}
                              style={[styles.smallVerifyBtn, { backgroundColor: '#EF4444' }]}
                            >
                              <Feather name="x-circle" size={12} color="#FFFFFF" />
                              <Text style={styles.smallVerifyBtnText}>Reject Payment</Text>
                            </Pressable>
                          </>
                        ) : null}
                        {expired ? (
                          <Pressable
                            disabled={!isCloudMode || reviewingPaymentId === attempt.id}
                            onPress={() => handleReviewPaymentAttempt('expire', attempt)}
                            style={[styles.smallVerifyBtn, { backgroundColor: '#6B7280' }]}
                          >
                            <Feather name="clock" size={12} color="#FFFFFF" />
                            <Text style={styles.smallVerifyBtnText}>Expire after review</Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          disabled={!isCloudMode || reviewingPaymentId === attempt.id}
                          onPress={() => handleReviewPaymentAttempt('cancel', attempt)}
                          style={[styles.smallVerifyBtn, { backgroundColor: '#6B7280' }]}
                        >
                          <Feather name="slash" size={12} color="#FFFFFF" />
                          <Text style={styles.smallVerifyBtnText}>Cancel after review</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}

                {pendingManualUpiOrders.map((order) => (
                  <View key={`legacy-${order.id}`} style={[styles.paymentReviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>Unpaid UPI order · {order.id}</Text>
                    <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                      {order.customerName} · {order.customerPhone} · {order.items.map((item) => `${item.name} × ${item.quantity}`).join(' · ')}
                    </Text>
                    <Text style={[styles.detailText, { color: colors.foreground, marginTop: 4 }]}>
                      {formatPrice(order.total)} · {order.paymentMethod} · order is not paid
                    </Text>
                    <Text style={[styles.detailText, { color: '#D97706', marginTop: 4 }]}>
                      Customer-submitted UTR (unverified): {order.customerUtr || 'Not submitted'}
                    </Text>
                    <TextInput
                      value={manualUtrInputs[order.id] ?? order.customerUtr ?? ''}
                      onChangeText={(value) => setManualUtrInputs((current) => ({ ...current, [order.id]: value }))}
                      placeholder="Match this reference to actual account credit"
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="none"
                      maxLength={100}
                      style={[styles.legacyUtrInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    />
                    <View style={styles.paymentActionRow}>
                      <Pressable
                        disabled={!isCloudMode || reviewingPaymentId === order.id || !(manualUtrInputs[order.id] ?? order.customerUtr ?? '').trim()}
                        onPress={() => handleVerifyManualUpiOrder(order)}
                        style={[styles.smallVerifyBtn, { backgroundColor: colors.moss, opacity: reviewingPaymentId === order.id ? 0.65 : 1 }]}
                      >
                        {reviewingPaymentId === order.id
                          ? <ActivityIndicator size="small" color="#FFFFFF" />
                          : <Feather name="check-circle" size={12} color="#FFFFFF" />}
                        <Text style={styles.smallVerifyBtnText}>
                          {reviewingPaymentId === order.id ? 'Reviewing…' : 'Verify & Confirm Payment'}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={!isCloudMode || reviewingPaymentId === order.id}
                        onPress={() => handleRejectManualUpiOrder(order)}
                        style={[styles.smallVerifyBtn, { backgroundColor: '#EF4444', opacity: reviewingPaymentId === order.id ? 0.65 : 1 }]}
                      >
                        {reviewingPaymentId === order.id
                          ? <ActivityIndicator size="small" color="#FFFFFF" />
                          : <Feather name="x-circle" size={12} color="#FFFFFF" />}
                        <Text style={styles.smallVerifyBtnText}>
                          {reviewingPaymentId === order.id ? 'Reviewing…' : 'Reject and cancel'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
                {!pendingAttempts.length && !pendingManualUpiOrders.length ? (
                  <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                    <Feather name="check-circle" size={30} color={colors.moss} />
                    <Text style={[styles.emptyText, { color: colors.foreground }]}>No payments need review.</Text>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                {paymentAttemptHistory.map((attempt) => (
                  <View key={attempt.id} style={[styles.paymentReviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>{attempt.id} · {attempt.status}</Text>
                    <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                      {attempt.customerName} · {attempt.customerPhone} · {formatPrice(attempt.total)}
                    </Text>
                    <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                      {attempt.rejectionReason || 'No additional review note.'}
                    </Text>
                  </View>
                ))}
                {closedManualUpiOrders.map((order) => (
                  <View key={`legacy-history-${order.id}`} style={[styles.paymentReviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.orderId, { color: colors.foreground }]}>Legacy {order.paymentStatus || 'Unpaid'} · {order.id}</Text>
                    <Text style={[styles.detailText, { color: colors.mutedForeground, marginTop: 4 }]}>
                      {order.customerName} · {order.customerPhone} · {formatPrice(order.total)}
                    </Text>
                  </View>
                ))}
                {!paymentAttemptHistory.length && !closedManualUpiOrders.length ? (
                  <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                    <Feather name="archive" size={30} color={colors.mutedForeground} />
                    <Text style={[styles.emptyText, { color: colors.foreground }]}>No rejected, cancelled, or expired attempts.</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        )}

        {/* ==================== 7. PAYMENT SETTINGS TAB ==================== */}
        {activeTab === 'payments' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>UPI & Google Pay Settings</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Configure your store's UPI VPA, QR code, and customer payment instructions for self-service checkout.
            </Text>

            <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {/* Enable / Disable Manual UPI */}
              <View style={[styles.switchRow, { borderTopWidth: 0, paddingTop: 0 }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Enable UPI Payments</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>
                    When active, customers can pay using Google Pay, PhonePe, or any UPI app at checkout.
                  </Text>
                </View>
                <Switch
                  value={paymentForm.enabled}
                  onValueChange={(v) => setPaymentForm((prev) => ({ ...prev, enabled: v }))}
                  trackColor={{ false: colors.border, true: colors.moss }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* Merchant Display Name */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 16 }]}>
                Merchant / Business Display Name
              </Text>
              <TextInput
                value={paymentForm.merchantName}
                onChangeText={(t) => setPaymentForm((prev) => ({ ...prev, merchantName: t }))}
                placeholder="e.g. VibeKart Official"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.settingInput,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />

              {/* Merchant UPI ID (VPA) */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 14 }]}>
                Merchant UPI ID (VPA)
              </Text>
              <TextInput
                value={paymentForm.merchantVpa}
                onChangeText={(t) => setPaymentForm((prev) => ({ ...prev, merchantVpa: t.trim().toLowerCase() }))}
                placeholder="e.g. merchant@icici or store@upi"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                style={[
                  styles.settingInput,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />

              {/* Auto-generate UPI QR toggle */}
              <View style={[styles.switchRow, { marginTop: 16 }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Auto-Generate UPI QR Code</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>
                    Automatically create a standard UPI payment QR from your VPA and Merchant Name.
                  </Text>
                </View>
                <Switch
                  value={paymentForm.autoGenerateQr}
                  onValueChange={(v) => setPaymentForm((prev) => ({ ...prev, autoGenerateQr: v }))}
                  trackColor={{ false: colors.border, true: colors.moss }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* Custom QR Upload via Cloudinary */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 16 }]}>
                Custom Merchant QR Code Image (Cloudinary)
              </Text>
              <Text style={[styles.switchSub, { color: colors.mutedForeground, marginTop: 2, marginBottom: 8 }]}>
                Upload your official QR code image provided by Google Pay for Business, PhonePe, or your bank.
              </Text>

              {paymentForm.qrImageUrl ? (
                <View style={[styles.qrPreviewBox, { borderColor: colors.border, backgroundColor: colors.background }]}>
                  <Image source={{ uri: paymentForm.qrImageUrl }} style={styles.qrImage} resizeMode="contain" />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Text style={[styles.qrTitle, { color: colors.foreground }]}>Custom QR Active</Text>
                    <Text style={[styles.qrSub, { color: colors.mutedForeground }]}>
                      This image will be displayed to customers during checkout.
                    </Text>
                    <Pressable
                      onPress={() => setPaymentForm((prev) => ({ ...prev, qrImageUrl: '', qrImagePublicId: '' }))}
                      style={[styles.smallDangerBtn, { borderColor: colors.destructive }]}
                    >
                      <Feather name="trash-2" size={13} color={colors.destructive} />
                      <Text style={[styles.smallDangerBtnText, { color: colors.destructive }]}>Remove Image</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  disabled={uploadingQr}
                  onPress={handlePickQrImage}
                  style={[styles.uploadQrBtn, { backgroundColor: colors.background, borderColor: colors.border }]}
                >
                  {uploadingQr ? (
                    <ActivityIndicator size="small" color={colors.coral} />
                  ) : (
                    <>
                      <Feather name="upload-cloud" size={20} color={colors.coral} />
                      <Text style={[styles.uploadQrBtnText, { color: colors.coral }]}>Upload Custom QR Code</Text>
                    </>
                  )}
                </Pressable>
              )}

              {/* Dynamic QR Preview if autoGenerateQr or VPA is present */}
              {paymentForm.autoGenerateQr && paymentForm.merchantVpa ? (
                <View style={[styles.generatedQrBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Feather name="smartphone" size={14} color={colors.moss} />
                    <Text style={[styles.qrTitle, { color: colors.foreground }]}>Standard UPI QR Preview</Text>
                  </View>
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <Image
                      source={{ uri: buildUpiQrUrl(paymentForm.merchantVpa, paymentForm.merchantName) }}
                      style={{ width: 160, height: 160, borderRadius: 10 }}
                      resizeMode="contain"
                    />
                    <Text style={[styles.qrSub, { color: colors.mutedForeground, marginTop: 8, textAlign: 'center' }]}>
                      URI: {buildUpiUri(paymentForm.merchantVpa, paymentForm.merchantName)}
                    </Text>
                  </View>
                  <View style={[styles.disclaimerBox, { backgroundColor: '#FFFBEB', borderColor: '#F59E0B' }]}>
                    <Feather name="alert-circle" size={13} color="#D97706" />
                    <Text style={[styles.disclaimerText, { color: '#92400E' }]}>
                      Visual Payment Prompt: Generating or displaying a UPI QR code does not verify transaction completion or imply merchant verification by Google Pay or your bank. Payments must be verified manually by the admin.
                    </Text>
                  </View>
                </View>
              ) : null}

              {/* Payment Instructions */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 16 }]}>
                Customer Payment Instructions
              </Text>
              <TextInput
                value={paymentForm.instructions}
                onChangeText={(t) => setPaymentForm((prev) => ({ ...prev, instructions: t }))}
                multiline
                numberOfLines={3}
                placeholder="Enter step-by-step instructions for customers..."
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.settingInput,
                  {
                    minHeight: 74,
                    textAlignVertical: 'top',
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    color: colors.foreground,
                  },
                ]}
              />

              {/* Success Notification */}
              {paymentSuccess && (
                <View style={styles.successNote}>
                  <Feather name="check-circle" size={15} color={colors.moss} />
                  <Text style={[styles.successNoteText, { color: colors.moss }]}>Payment settings saved successfully!</Text>
                </View>
              )}

              {/* Save Button */}
              <Pressable
                disabled={savingPayment}
                onPress={handleSavePaymentSettings}
                style={[styles.saveBtn, { backgroundColor: colors.moss, marginTop: 18 }]}
              >
                {savingPayment ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Feather name="save" size={16} color="#FFFFFF" />
                    <Text style={styles.saveBtnText}>Save Payment Settings</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )}

        {/* ==================== 7. SETTINGS TAB ==================== */}
        {activeTab === 'settings' && (
          <View>
            <Text style={[styles.sectionHeading, { color: colors.foreground }]}>Store & Homepage Settings</Text>
            <Text style={[styles.sectionSub, { color: colors.mutedForeground }]}>
              Customize customer-facing branding, operational banners and maintenance status.
            </Text>

            <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {/* Store Name */}
              <Text style={[styles.settingLabel, { color: colors.foreground }]}>Store Brand Name</Text>
              <TextInput
                value={settingsForm.storeName}
                onChangeText={(t) => setSettingsForm((prev) => ({ ...prev, storeName: t }))}
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />

              {/* Support Email */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 14 }]}>Support Contact Email</Text>
              <TextInput
                value={settingsForm.supportEmail}
                onChangeText={(t) => setSettingsForm((prev) => ({ ...prev, supportEmail: t }))}
                keyboardType="email-address"
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />

              {/* Support Phone */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 14 }]}>Support Phone Number</Text>
              <TextInput
                value={settingsForm.supportPhone ?? ''}
                onChangeText={(t) => setSettingsForm((prev) => ({ ...prev, supportPhone: t }))}
                keyboardType="phone-pad"
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />

              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 22 }]}>Delivery policy</Text>
              <Text style={[styles.settingHint, { color: colors.mutedForeground }]}>
                Delivery totals are estimates until checkout. The Worker recalculates the charge from these settings when it creates a payment attempt.
              </Text>
              <View style={[styles.switchRow, { borderTopColor: colors.border, marginTop: 10 }]}>
                <View>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Enable threshold-based free delivery</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>Orders at or above the minimum pay no delivery charge</Text>
                </View>
                <Switch
                  value={settingsForm.freeDeliveryEnabled}
                  onValueChange={(value) => setSettingsForm((prev) => ({ ...prev, freeDeliveryEnabled: value }))}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={settingsForm.freeDeliveryEnabled ? colors.moss : colors.mutedForeground}
                />
              </View>
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Free-delivery minimum (₹)</Text>
              <TextInput
                value={String(settingsForm.freeDeliveryThreshold)}
                onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, freeDeliveryThreshold: value === '' ? 0 : Number(value) }))}
                keyboardType="number-pad"
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Delivery charge below minimum (₹)</Text>
              <TextInput
                value={String(settingsForm.deliveryCharge)}
                onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, deliveryCharge: value === '' ? 0 : Number(value) }))}
                keyboardType="number-pad"
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />
              <View style={styles.deliveryDaysRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Estimated minimum days</Text>
                  <TextInput
                    value={String(settingsForm.deliveryMinDays)}
                    onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, deliveryMinDays: value === '' ? 0 : Number(value) }))}
                    keyboardType="number-pad"
                    style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Estimated maximum days</Text>
                  <TextInput
                    value={String(settingsForm.deliveryMaxDays)}
                    onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, deliveryMaxDays: value === '' ? 0 : Number(value) }))}
                    keyboardType="number-pad"
                    style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                  />
                </View>
              </View>
              <View style={[styles.switchRow, { borderTopColor: colors.border, marginTop: 12 }]}>
                <View>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Show delivery promotion</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>The eligibility threshold is always shown with the claim</Text>
                </View>
                <Switch
                  value={settingsForm.deliveryPromotionActive}
                  onValueChange={(value) => setSettingsForm((prev) => ({ ...prev, deliveryPromotionActive: value }))}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={settingsForm.deliveryPromotionActive ? colors.moss : colors.mutedForeground}
                />
              </View>
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Promotion text</Text>
              <TextInput
                value={settingsForm.deliveryPromotionText}
                onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, deliveryPromotionText: value }))}
                maxLength={100}
                style={[styles.settingInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 12 }]}>Customer delivery instructions</Text>
              <TextInput
                value={settingsForm.deliveryInstructions}
                onChangeText={(value) => setSettingsForm((prev) => ({ ...prev, deliveryInstructions: value }))}
                multiline
                maxLength={500}
                style={[styles.settingInput, { minHeight: 64, textAlignVertical: 'top', backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
              />

              {/* Announcement Banner */}
              <Text style={[styles.settingLabel, { color: colors.foreground, marginTop: 14 }]}>
                Announcement Banner Text
              </Text>
              <TextInput
                value={settingsForm.announcement}
                onChangeText={(t) => setSettingsForm((prev) => ({ ...prev, announcement: t }))}
                multiline
                numberOfLines={3}
                style={[
                  styles.settingInput,
                  { minHeight: 70, textAlignVertical: 'top', backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />

              {/* Announcement Switch */}
              <View style={[styles.switchRow, { borderTopColor: colors.border, marginTop: 16 }]}>
                <View>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Show Announcement Banner</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>Display at the top of the storefront</Text>
                </View>
                <Switch
                  value={settingsForm.announcementActive}
                  onValueChange={(v) => setSettingsForm((prev) => ({ ...prev, announcementActive: v }))}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={settingsForm.announcementActive ? colors.moss : colors.mutedForeground}
                />
              </View>

              {/* Maintenance Mode Switch */}
              <View style={[styles.switchRow, { borderTopColor: colors.border, marginTop: 14 }]}>
                <View>
                  <Text style={[styles.switchTitle, { color: colors.foreground }]}>Maintenance Mode</Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>Temporarily restrict customer ordering</Text>
                </View>
                <Switch
                  value={settingsForm.maintenanceMode}
                  onValueChange={(v) => setSettingsForm((prev) => ({ ...prev, maintenanceMode: v }))}
                  trackColor={{ false: colors.border, true: '#FEE2E2' }}
                  thumbColor={settingsForm.maintenanceMode ? colors.destructive : colors.mutedForeground}
                />
              </View>

              {/* Save Button */}
              {settingsSuccess ? (
                <View style={styles.successNote}>
                  <Feather name="check-circle" size={16} color={colors.moss} />
                  <Text style={[styles.successNoteText, { color: colors.moss }]}>Settings updated successfully!</Text>
                </View>
              ) : null}

              <Pressable
                disabled={savingSettings}
                onPress={handleSaveSettings}
                style={[styles.saveBtn, { backgroundColor: colors.moss, marginTop: 20 }]}
              >
                {savingSettings ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Feather name="save" size={16} color="#FFFFFF" />
                    <Text style={styles.saveBtnText}>Save Store Settings</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  guardScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  guardIconWrap: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  guardTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  guardBody: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', maxWidth: 280, lineHeight: 19, marginBottom: 24 },
  guardButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14 },
  guardButtonText: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Inter_700Bold' },

  header: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 19, fontFamily: 'Inter_700Bold' },
  roleBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  roleBadgeText: { color: '#FFFFFF', fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
  headerSubtitle: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  storefrontBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  storefrontBtnText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },

  tabBarWrap: { borderBottomWidth: 1 },
  tabBar: { flexDirection: 'row', paddingHorizontal: 14, gap: 16 },
  tabItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12, paddingHorizontal: 6 },
  tabLabel: { fontSize: 12 },

  sectionHeading: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  sectionSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 4, marginBottom: 16 },
  subSectionTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', marginBottom: 10 },

  // KPI Grid
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  kpiCard: { width: '48%', borderRadius: 16, borderWidth: 1, padding: 14, gap: 4 },
  kpiIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  kpiVal: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  kpiLabel: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  kpiSub: { fontSize: 10, fontFamily: 'Inter_400Regular' },

  quickRow: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1, height: 44, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  actionBtnText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },

  summaryRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 14, borderWidth: 1, marginBottom: 8 },
  summaryTitle: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  summarySub: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  summaryPrice: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  statusTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusTagText: { fontSize: 9, fontFamily: 'Inter_700Bold' },

  auditRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, marginBottom: 8 },
  auditDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  auditHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  auditAction: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  auditTime: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  auditDetails: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  auditUser: { fontSize: 10, fontFamily: 'Inter_500Medium', marginTop: 4 },

  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  primaryAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12 },
  primaryAddBtnText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },

  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 44, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },

  filterChipRow: { gap: 8, paddingBottom: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },

  prodCard: { padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 10 },
  prodHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  prodName: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  prodCategory: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.8, marginTop: 2 },
  iconAction: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  priceMatrix: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, marginTop: 10 },
  matrixLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  matrixVal: { fontSize: 13, fontFamily: 'Inter_700Bold', marginTop: 2 },
  togglesRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  toggleItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toggleLabel: { fontSize: 11, fontFamily: 'Inter_500Medium' },

  cardBox: { padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 16 },
  cardBoxTitle: { fontSize: 13, fontFamily: 'Inter_700Bold', marginBottom: 10 },
  formRow: { flexDirection: 'row', gap: 8 },
  formInput: { height: 42, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, fontSize: 13, fontFamily: 'Inter_400Regular' },
  formBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, borderRadius: 12 },
  formBtnText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_700Bold' },
  errorText: { color: '#EF4444', fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 6 },

  catRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, marginBottom: 8 },
  catIconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  catName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  catMeta: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2 },
  catActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deleteIconBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  orderCard: { padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 10 },
  orderTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderId: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  orderCustomer: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  orderTotal: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  orderExpanded: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  detailHeading: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  detailText: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  itemText: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 3 },
  financialRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, borderRadius: 10, marginTop: 10 },
  finLabel: { fontSize: 9, fontFamily: 'Inter_400Regular' },
  finVal: { fontSize: 12, fontFamily: 'Inter_700Bold', marginTop: 2 },
  trackingRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  trackingInput: { flex: 1, height: 38, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, fontSize: 11, fontFamily: 'Inter_400Regular' },
  trackingSaveBtn: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  transitionBtnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  advanceBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  advanceBtnText: { color: '#FFFFFF', fontSize: 11, fontFamily: 'Inter_700Bold' },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  cancelBtnText: { fontSize: 11, fontFamily: 'Inter_700Bold' },

  userCard: { padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 10 },
  userTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatarCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  userName: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  youTag: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  userEmail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  userPhone: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 1 },
  rolePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  rolePillText: { fontSize: 9, fontFamily: 'Inter_700Bold' },
  suspendedBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  userActionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTopWidth: 1 },
  smallActionBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  smallActionBtnText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  suspendBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  suspendBtnText: { fontSize: 10, fontFamily: 'Inter_700Bold' },

  settingsCard: { padding: 16, borderRadius: 16, borderWidth: 1 },
  settingLabel: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  settingHint: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular', marginTop: 6 },
  settingInput: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 6 },
  deliveryDaysRow: { flexDirection: 'row', gap: 10 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, borderTopWidth: 1 },
  switchTitle: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  switchSub: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 2 },
  successNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  successNoteText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 14 },
  saveBtnText: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Inter_700Bold' },

  paymentAuditBox: { padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 10 },
  paymentBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  paymentBadgeText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  smallVerifyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  smallVerifyBtnText: { color: '#FFFFFF', fontSize: 11, fontFamily: 'Inter_700Bold' },
  paymentViewRow: { flexDirection: 'row', gap: 8, marginTop: 15 },
  paymentViewChip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8 },
  paymentViewChipText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  paymentReviewCard: { padding: 14, borderRadius: 14, borderWidth: 1, marginTop: 12 },
  paymentReviewHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  paymentActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  legacyUtrInput: { minHeight: 43, borderWidth: 1, borderRadius: 10, paddingHorizontal: 11, marginTop: 10, fontSize: 12 },
  qrPreviewBox: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 8 },
  qrImage: { width: 90, height: 90, borderRadius: 8 },
  qrTitle: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  qrSub: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  smallDangerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, alignSelf: 'flex-start', marginTop: 4 },
  smallDangerBtnText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  uploadQrBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', marginTop: 8 },
  uploadQrBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  generatedQrBox: { padding: 12, borderRadius: 12, borderWidth: 1, marginTop: 14 },
  disclaimerBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, marginTop: 10 },
  disclaimerText: { flex: 1, fontSize: 10, fontFamily: 'Inter_400Regular', lineHeight: 14 },

  emptyBox: { alignItems: 'center', justifyContent: 'center', padding: 32, borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', gap: 8, marginVertical: 12 },
  emptyText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});
