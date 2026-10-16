import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdminAuditLog,
  canCancelOrder,
  canTransitionOrderStatus,
  CategoryItem,
  computeDisplayPrice,
  defaultCategoryItems,
  defaultPaymentSettings,
  defaultProducts,
  defaultStoreSettings,
  getAssignedProductCount,
  NewProductInput,
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

import {
  confirmPhoneOtp,
  fetchUserProfile,
  requestPhoneOtp,
  signIn as firebaseSignIn,
  signInWithGoogle as firebaseSignInWithGoogle,
  signOutUser,
  signUp as firebaseSignUp,
  subscribeToAuthState,
  UserProfile,
  UserRole,
} from '@/services/firebase/auth';
import { sanitizeAuditLogPayload } from '@/services/firebase/audit';
import { isFirebaseConfigured } from '@/services/firebase/config';
import { updatePaymentQrViaWorker } from '@/services/cloudinary/upload';
import {
  createAuditLogRemote,
  createCategoryRemote,
  createManualUpiOrderRemote,
  createProduct,
  confirmPaymentAttemptViaWorker,
  editProduct,
  fetchAuditLogsRemote,
  fetchPaymentSettingsRemote,
  fetchSellerProducts,
  fetchStoreSettingsRemote,
  fetchUsersRemote,
  removeCategoryRemote,
  deleteProductViaWorker,
  confirmManualUpiOrderPaymentRemote,
  rejectManualUpiOrderPaymentRemote,
  setOrderTrackingId as setOrderTrackingIdRemote,
  setProductEnabled as setProductEnabledRemote,
  setProductFeatured as setProductFeaturedRemote,
  setProductStock as setProductStockRemote,
  subscribeToPaymentAttempts,
  subscribeToCategories,
  subscribeToOrders,
  subscribeToProducts,
  updateCategoryRemote,
  updateOrderStatusRemote,
  updatePaymentSettingsRemote,
  updateStoreSettingsRemote,
  updateUserRoleRemote,
  updateUserStatusRemote,
  reviewPaymentAttemptViaWorker,
  submitManualUpiOrderUtrRemote,
  submitPaymentDetailsViaWorker,
} from '@/services/firebase/firestore';

type CartLine = {
  product: Product;
  quantity: number;
  option?: string;
  priceAtAdd: number;
  costAtAdd: number;
};

export type AuthUser =
  | { isGuest: true }
  | { isGuest: false; uid: string; email: string; name: string; phone?: string; role: UserRole }
  | null;

type FirestoreListenerStatus = 'loading' | 'ready' | 'error';
type FirestoreListenerState = {
  status: FirestoreListenerStatus;
  error: string | null;
  retryAction: string | null;
};

type StoreContextValue = {
  // mode
  isCloudMode: boolean; // true once Firebase is configured AND a real (non-guest) user is signed in
  dataLoadState: {
    products: FirestoreListenerState;
    categories: FirestoreListenerState;
    orders: FirestoreListenerState;
    paymentAttempts: FirestoreListenerState;
  };

  // catalogue
  products: Product[];
  addProduct: (input: NewProductInput) => Promise<string>;
  updateProduct: (id: string, patch: Partial<NewProductInput>) => Promise<void>;
  deleteProduct: (id: string) => Promise<boolean>;
  deletingProductId: string | null;
  toggleStock: (id: string) => Promise<void>;
  toggleEnabled: (id: string) => Promise<void>;
  toggleFeatured: (id: string) => Promise<void>;

  // categories
  categories: CategoryItem[];
  addCategory: (input: { name: string; icon?: string }) => Promise<string>;
  updateCategory: (id: string, patch: Partial<Pick<CategoryItem, 'name' | 'icon' | 'enabled'>>) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  toggleCategoryEnabled: (id: string) => Promise<void>;

  // cart / orders (customer side) — cart/favorites always stay on-device
  cart: CartLine[];
  orders: Order[];
  paymentAttempts: PaymentAttempt[];
  favorites: string[];
  cartCount: number;
  cartTotal: number;
  addToCart: (product: Product, option?: string) => void;
  removeFromCart: (productId: string) => void;
  toggleFavorite: (productId: string) => void;
  isFavorite: (productId: string) => boolean;
  placeOrder: (details: {
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    paymentMethod: 'UPI' | 'COD';
    idempotencyKey: string;
  }) => Promise<Order>;
  submitManualOrderUtr: (orderId: string, customerUtr: string) => Promise<void>;
  submitPaymentDetails: (attemptId: string, customerUtr: string) => Promise<void>;
  verifyPaymentAttempt: (attemptId: string) => Promise<void>;
  reviewPaymentAttempt: (action: 'reject' | 'cancel' | 'expire', attemptId: string, reason: string) => Promise<void>;
  verifyManualUpiOrderPayment: (orderId: string, customerUtr: string) => Promise<void>;
  rejectManualUpiOrderPayment: (orderId: string, reason: string) => Promise<void>;

  // order fulfilment (seller side)
  updateOrderStatus: (orderId: string, status: OrderStatus) => Promise<void>;
  setTrackingId: (orderId: string, trackingId: string) => Promise<void>;
  cancelOrder: (orderId: string) => Promise<void>;

  // analytics (seller side)
  analytics: {
    totalRevenue: number;        // from non-cancelled orders only
    totalCost: number;           // estimated cost from non-cancelled orders
    totalProfit: number;         // totalRevenue - totalCost
    marginPercent: number;       // profit / revenue * 100 (0 if no revenue)
    ordersCount: number;         // all orders
    activeOrdersCount: number;   // Placed + Confirmed + Processing + Shipped
    deliveredCount: number;
    cancelledCount: number;
    lowStockCount: number;       // products with inStock = false
    disabledCount: number;       // products with enabled = false
  };

  // admin
  isAdmin: boolean;
  storeSettings: StoreSettings;
  updateStoreSettings: (patch: Partial<StoreSettings>) => Promise<void>;
  paymentSettings: PaymentSettings;
  updatePaymentSettings: (patch: Partial<PaymentSettings>) => Promise<void>;
  usersList: UserProfile[];
  refreshUsers: () => Promise<void>;
  changeUserRole: (uid: string, role: UserRole) => Promise<void>;
  changeUserStatus: (uid: string, status: 'active' | 'suspended') => Promise<void>;
  auditLogs: AdminAuditLog[];
  logAdminActivity: (action: string, details: string, targetId?: string) => Promise<void>;

  // auth
  authUser: AuthUser;
  authLoaded: boolean;
  authError: string | null;
  signUpEmail: (params: { email: string; password: string; name: string; phone?: string }) => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  sendPhoneOtp: (phone: string) => Promise<void>;
  verifyPhoneOtp: (phone: string, otp: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  continueAsGuest: () => void;
  logout: () => Promise<void>;
};

const StoreContext = createContext<StoreContextValue | null>(null);

const STORAGE_KEYS = {
  cart: 'vibekart-cart',
  orders: 'vibekart-orders',
  favorites: 'vibekart-favorites',
  products: 'vibekart-products',
  categories: 'vibekart-categories',
  auth: 'vibekart-auth',
  settings: 'vibekart-settings',
  paymentSettings: 'vibekart-payment-settings',
  users: 'vibekart-users',
  auditLogs: 'vibekart-audit-logs',
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [products, setProducts] = useState<Product[]>(defaultProducts);
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const deletingProductLock = useRef(false);
  const [dataLoadState, setDataLoadState] = useState<StoreContextValue['dataLoadState']>({
    products: { status: 'loading', error: null, retryAction: 'Reload products' },
    categories: { status: 'loading', error: null, retryAction: 'Reload categories' },
    orders: { status: 'loading', error: null, retryAction: 'Reload orders' },
    paymentAttempts: { status: 'loading', error: null, retryAction: 'Reload payment attempts' },
  });
  const updateDataLoadState = (
    key: keyof StoreContextValue['dataLoadState'],
    patch: Partial<FirestoreListenerState>,
  ) => {
    setDataLoadState((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  };
  const [categories, setCategories] = useState<CategoryItem[]>(defaultCategoryItems);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const cancellingOrderIds = useRef(new Set<string>());
  const [paymentAttempts, setPaymentAttempts] = useState<PaymentAttempt[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [storeSettings, setStoreSettings] = useState<StoreSettings>(defaultStoreSettings);
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings>(defaultPaymentSettings);
  const [usersList, setUsersList] = useState<UserProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);

  const isCloudMode = isFirebaseConfigured && !!authUser && !authUser.isGuest;
  const isAdmin = !isCloudMode || (authUser && !authUser.isGuest && authUser.role === 'admin');

  // ---------------- cart / favorites — always on-device ----------------

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEYS.cart),
      AsyncStorage.getItem(STORAGE_KEYS.favorites),
    ]).then(([savedCart, savedFavorites]) => {
      if (savedCart) setCart(JSON.parse(savedCart) as CartLine[]);
      if (savedFavorites) setFavorites(JSON.parse(savedFavorites) as string[]);
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
  }, [favorites]);

  // ---------------- auth ----------------
  // Cloud mode: Firebase Auth (email/password) is the source of truth.
  // Local demo mode (no Firebase config yet): only guest browsing works,
  // persisted locally so the choice survives an app restart.

  useEffect(() => {
    if (!isFirebaseConfigured) {
      AsyncStorage.getItem(STORAGE_KEYS.auth)
        .then((saved) => {
          if (saved) setAuthUser(JSON.parse(saved) as AuthUser);
        })
        .catch((error) => {
          // Corrupted/unreadable local storage shouldn't leave the app stuck
          // on a blank screen forever — fall back to "no session" and let
          // the person log in again.
          console.warn('[auth] failed to read local session', error);
        })
        .finally(() => setAuthLoaded(true));
      return;
    }

    const unsubscribe = subscribeToAuthState(async (firebaseUser) => {
      try {
        if (firebaseUser) {
          // fetchUserProfile does a Firestore read, which can reject (rules
          // not deployed yet, offline, permission issue, ...). That must
          // never leave a real, already-authenticated Firebase user stuck
          // with authLoaded stuck at false — fall back to a profile built
          // straight from the Firebase user record itself. Auth is still
          // real; only the extra Firestore profile data (name/phone/role)
          // is temporarily best-effort.
          let profile: Awaited<ReturnType<typeof fetchUserProfile>> = null;
          try {
            profile = await fetchUserProfile(firebaseUser.uid);
          } catch (profileError) {
            console.warn('[auth] failed to load user profile, using fallback', profileError);
          }
          setAuthUser({
            isGuest: false,
            uid: firebaseUser.uid,
            email: profile?.email ?? firebaseUser.email ?? '',
           name: profile?.name ?? firebaseUser.displayName ?? '',
            phone: profile?.phone,
            role: profile?.role ?? 'customer',
          });
        } else {
          let parsed: AuthUser = null;
          try {
            const saved = await AsyncStorage.getItem(STORAGE_KEYS.auth);
            parsed = saved ? (JSON.parse(saved) as AuthUser) : null;
          } catch (storageError) {
            console.warn('[auth] failed to read local guest session', storageError);
          }
          setAuthUser(parsed?.isGuest ? parsed : null);
        }
      } finally {
        // Whatever happened above, the auth-state check itself has
        // completed — the app must stop showing its loading state.
        setAuthLoaded(true);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    if (authUser?.isGuest) {
      AsyncStorage.setItem(STORAGE_KEYS.auth, JSON.stringify(authUser));
    } else if (!authUser) {
      AsyncStorage.removeItem(STORAGE_KEYS.auth);
    }
  }, [authUser, authLoaded]);

  const signUpEmail: StoreContextValue['signUpEmail'] = async (params) => {
    setAuthError(null);
    try {
      await firebaseSignUp({ ...params, role: 'customer' });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign up failed');
      throw error;
    }
  };

  const signInEmail: StoreContextValue['signInEmail'] = async (email, password) => {
    setAuthError(null);
    try {
      await firebaseSignIn(email, password);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign in failed');
      throw error;
    }
  };

  const sendPhoneOtp: StoreContextValue['sendPhoneOtp'] = async (phone) => {
    setAuthError(null);
    try {
      await requestPhoneOtp(phone);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'OTP bhejne me dikkat aayi');
      throw error;
    }
  };

  const verifyPhoneOtp: StoreContextValue['verifyPhoneOtp'] = async (phone, otp) => {
    setAuthError(null);
    try {
      await confirmPhoneOtp(phone, otp);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'OTP galat hai');
      throw error;
    }
  };

    // Unlike the email/OTP handlers this deliberately does not write to
  // authError: the login screen shows Google errors right under the Google
  // button (it catches the thrown, already-friendly error itself) instead
  // of under the unrelated email form fields.
  const signInWithGoogle: StoreContextValue['signInWithGoogle'] = async () => {
    await firebaseSignInWithGoogle();
  };

  const continueAsGuest = () => setAuthUser({ isGuest: true });

  const logout = async () => {
    if (isFirebaseConfigured && authUser && !authUser.isGuest) {
      await signOutUser();
    } else {
      setAuthUser(null);
    }
  };

  // ---------------- catalogue ----------------
  // Cloud mode: sellers get a one-shot fetch (public + private cost merged,
  // refreshed after every mutation); customers get a realtime public-only
  // listener. Local demo mode: AsyncStorage, same as before.

  const refreshSellerProducts = async () => {
    setProducts(await fetchSellerProducts());
  };

  useEffect(() => {
    if (isCloudMode) {
      updateDataLoadState('products', { status: 'loading', error: null, retryAction: 'Reload products' });
      if (authUser && !authUser.isGuest && authUser.role === 'seller') {
        refreshSellerProducts()
          .then(() => updateDataLoadState('products', { status: 'ready', error: null, retryAction: null }))
          .catch((error) => {
            const message = error instanceof Error ? error.message : 'Could not refresh products.';
            console.warn('[products] failed to refresh seller catalogue', message);
            updateDataLoadState('products', {
              status: 'error',
              error: message,
              retryAction: 'Reload products',
            });
          });
        return;
      }
      const unsubscribe = subscribeToProducts(
        (remoteProducts) => {
          setProducts(remoteProducts);
          updateDataLoadState('products', { status: 'ready', error: null, retryAction: null });
        },
        (error) => {
          const message = error instanceof Error ? error.message : 'Could not load products.';
          console.warn('[products]', message);
          updateDataLoadState('products', {
            status: 'error',
            error: message,
            retryAction: 'Reload products',
          });
        },
      );
      return unsubscribe;
    }

    updateDataLoadState('products', { status: 'loading', error: null, retryAction: 'Reload products' });
    AsyncStorage.getItem(STORAGE_KEYS.products).then((saved) => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Product[];
          setProducts(
            parsed.map((p) => ({
              ...p,
              enabled: p.enabled ?? true,
              featured: p.featured ?? false,
              isNew: p.isNew ?? false,
              inStock: p.inStock ?? true,
            })),
          );
          updateDataLoadState('products', { status: 'ready', error: null, retryAction: null });
        } catch {
          setProducts(defaultProducts);
          updateDataLoadState('products', { status: 'ready', error: null, retryAction: null });
        }
      } else {
        setProducts(defaultProducts);
        updateDataLoadState('products', { status: 'ready', error: null, retryAction: null });
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not load local products.';
      console.warn('[products] local-cache read failed', message);
      setProducts(defaultProducts);
      updateDataLoadState('products', {
        status: 'error',
        error: message,
        retryAction: 'Reload products',
      });
    });
  }, [isCloudMode, authUser && !authUser.isGuest ? authUser.role : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.products, JSON.stringify(products));
  }, [products, isCloudMode]);

  // ---------------- categories ----------------
  useEffect(() => {
    if (isCloudMode) {
      updateDataLoadState('categories', { status: 'loading', error: null, retryAction: 'Reload categories' });
      const unsubscribe = subscribeToCategories(
        (remoteCategories) => {
          if (remoteCategories.length > 0) {
            setCategories(remoteCategories);
            updateDataLoadState('categories', { status: 'ready', error: null, retryAction: null });
          } else if (authUser && !authUser.isGuest && authUser.role === 'seller') {
            (async () => {
              try {
                for (const cat of defaultCategoryItems) {
                  await createCategoryRemote({
                    id: cat.id,
                    name: cat.name,
                    slug: cat.slug,
                    icon: cat.icon,
                    enabled: cat.enabled,
                  });
                }
                updateDataLoadState('categories', { status: 'ready', error: null, retryAction: null });
              } catch (seedErr) {
                const message = seedErr instanceof Error ? seedErr.message : 'Failed to seed default categories.';
                console.warn('[categories] failed to seed default categories', seedErr);
                updateDataLoadState('categories', {
                  status: 'error',
                  error: message,
                  retryAction: 'Reload categories',
                });
              }
            })();
          } else {
            setCategories(defaultCategoryItems);
            updateDataLoadState('categories', { status: 'ready', error: null, retryAction: null });
          }
        },
        (error) => {
          const message = error instanceof Error ? error.message : 'Could not load categories.';
          console.warn('[categories] listener error', message);
          setCategories(defaultCategoryItems);
          updateDataLoadState('categories', {
            status: 'error',
            error: message,
            retryAction: 'Reload categories',
          });
        },
      );
      return unsubscribe;
    }

    updateDataLoadState('categories', { status: 'loading', error: null, retryAction: 'Reload categories' });
    AsyncStorage.getItem(STORAGE_KEYS.categories).then((saved) => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as CategoryItem[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCategories(
              parsed.map((c) => ({
                id: c.id,
                name: c.name,
                slug: c.slug || normalizeSlug(c.name),
                icon: c.icon || 'tag',
                enabled: c.enabled !== false,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              })),
            );
            updateDataLoadState('categories', { status: 'ready', error: null, retryAction: null });
            return;
          }
        } catch {
          // fallback below
        }
      }
      setCategories(defaultCategoryItems);
      updateDataLoadState('categories', { status: 'ready', error: null, retryAction: null });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not load local categories.';
      console.warn('[categories] local-cache read failed', message);
      setCategories(defaultCategoryItems);
      updateDataLoadState('categories', {
        status: 'error',
        error: message,
        retryAction: 'Reload categories',
      });
    });
  }, [isCloudMode, authUser && !authUser.isGuest ? authUser.role : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(categories));
  }, [categories, isCloudMode]);

  const addProduct: StoreContextValue['addProduct'] = async (input) => {
    if (isCloudMode) {
      const id = await createProduct(input);
      await refreshSellerProducts();
      return id;
    }
    const price = computeDisplayPrice(input.baseCost, input.markupType, input.markupValue, input.manualPrice);
    const product: Product = {
      id: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Date.now().toString().slice(-4)}`,
      name: input.name,
      subtitle: input.subtitle,
      description: input.description,
      category: input.category,
      image: input.image ?? defaultProducts[0].image,
      imageUrls: input.imageUrls,
      imagePublicIds: input.imagePublicIds,
      colors: input.colors.length ? input.colors : ['Standard'],
      sizes: input.sizes,
      inStock: input.inStock ?? true,
      enabled: input.enabled ?? true,
      featured: input.featured ?? false,
      isNew: input.isNew ?? false,
      baseCost: input.baseCost,
      markupType: input.markupType,
      markupValue: input.markupValue,
      manualPrice: input.manualPrice,
      originalPrice: input.originalPrice,
      sourceUrl: input.sourceUrl,
      sourceCode: input.sourceCode,
      price,
    };
    setProducts((current) => [product, ...current]);
    return product.id;
  };

  const updateProduct: StoreContextValue['updateProduct'] = async (id, patch) => {
    if (isCloudMode) {
      await editProduct(id, patch);
      await refreshSellerProducts();
      return;
    }
    setProducts((current) =>
      current.map((product) => {
        if (product.id !== id) return product;
        const merged = { ...product, ...patch };
        const price = computeDisplayPrice(merged.baseCost, merged.markupType, merged.markupValue, merged.manualPrice);
        return { ...merged, price };
      }),
    );
  };

  const deleteProduct: StoreContextValue['deleteProduct'] = async (id) => {
    if (deletingProductLock.current) throw new Error('A product deletion is already in progress.');
    if (!products.some((product) => product.id === id)) throw new Error('Product is no longer in the catalogue.');
    deletingProductLock.current = true;
    setDeletingProductId(id);
    try {
      let cleanupPending = false;
      if (isCloudMode) {
        if (!authUser || authUser.isGuest || !['seller', 'admin'].includes(authUser.role)) {
          throw new Error('Only an authorized seller or administrator can delete products.');
        }
        cleanupPending = await deleteProductViaWorker(id);
      }
      setProducts((current) => current.filter((product) => product.id !== id));
      setCart((current) => current.filter((line) => line.product.id !== id));
      return cleanupPending;
    } finally {
      deletingProductLock.current = false;
      setDeletingProductId(null);
    }
  };

  const toggleStock: StoreContextValue['toggleStock'] = async (id) => {
    if (isCloudMode) {
      const target = products.find((product) => product.id === id);
      if (target) await setProductStockRemote(id, !target.inStock);
      await refreshSellerProducts();
      return;
    }
    setProducts((current) =>
      current.map((product) => (product.id === id ? { ...product, inStock: !product.inStock } : product)),
    );
  };

  const toggleEnabled: StoreContextValue['toggleEnabled'] = async (id) => {
    if (isCloudMode) {
      const target = products.find((product) => product.id === id);
      if (target) await setProductEnabledRemote(id, !(target.enabled ?? true));
      await refreshSellerProducts();
      return;
    }
    setProducts((current) =>
      current.map((product) =>
        product.id === id ? { ...product, enabled: !(product.enabled ?? true) } : product,
      ),
    );
  };

  const toggleFeatured: StoreContextValue['toggleFeatured'] = async (id) => {
    if (isCloudMode) {
      const target = products.find((product) => product.id === id);
      if (target) await setProductFeaturedRemote(id, !(target.featured ?? false));
      await refreshSellerProducts();
      return;
    }
    setProducts((current) =>
      current.map((product) =>
        product.id === id ? { ...product, featured: !(product.featured ?? false) } : product,
      ),
    );
  };

  // ---------------- category management ----------------

  const addCategory: StoreContextValue['addCategory'] = async ({ name, icon }) => {
    const validation = validateCategoryName(name, categories);
    if (!validation.valid) throw new Error(validation.error);
    const slug = normalizeSlug(name);
    const newItem: CategoryItem = {
      id: slug,
      name: name.trim(),
      slug,
      icon: icon || 'tag',
      enabled: true,
    };
    if (isCloudMode) {
      const id = await createCategoryRemote({ id: slug, name: name.trim(), slug, icon: icon || 'tag', enabled: true });
      return id;
    }
    setCategories((current) => {
      if (current.some((c) => c.id === newItem.id)) {
        const unique = `${slug}-${Date.now().toString().slice(-4)}`;
        return [...current, { ...newItem, id: unique }];
      }
      return [...current, newItem];
    });
    return newItem.id;
  };

  const updateCategory: StoreContextValue['updateCategory'] = async (id, patch) => {
    if (patch.name !== undefined) {
      const validation = validateCategoryName(patch.name, categories, id);
      if (!validation.valid) throw new Error(validation.error);
    }
    const updatedPatch: Partial<CategoryItem> = { ...patch };
    if (patch.name !== undefined) {
      updatedPatch.name = patch.name.trim();
      updatedPatch.slug = normalizeSlug(patch.name);
    }
    if (isCloudMode) {
      await updateCategoryRemote(id, updatedPatch);
      return;
    }
    setCategories((current) =>
      current.map((c) => (c.id === id ? { ...c, ...updatedPatch, updatedAt: new Date().toISOString() } : c)),
    );
  };

  const deleteCategory: StoreContextValue['deleteCategory'] = async (id) => {
    const target = categories.find((c) => c.id === id);
    if (!target) return;
    const count = getAssignedProductCount(target, products);
    if (count > 0) {
      throw new Error(
        `"${target.name}" has ${count} product${count > 1 ? 's' : ''} assigned to it. Reassign or delete those products first.`,
      );
    }
    if (isCloudMode) {
      await removeCategoryRemote(id);
      return;
    }
    setCategories((current) => current.filter((c) => c.id !== id));
  };

  const toggleCategoryEnabled: StoreContextValue['toggleCategoryEnabled'] = async (id) => {
    const target = categories.find((c) => c.id === id);
    if (!target) return;
    const newEnabled = !(target.enabled ?? true);
    if (isCloudMode) {
      await updateCategoryRemote(id, { enabled: newEnabled });
      return;
    }
    setCategories((current) =>
      current.map((c) => (c.id === id ? { ...c, enabled: newEnabled, updatedAt: new Date().toISOString() } : c)),
    );
  };

  // ---------------- cart ----------------

  const addToCart = (product: Product, option?: string) => {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id && line.option === option);
      if (existing) {
        return current.map((line) => (line === existing ? { ...line, quantity: line.quantity + 1 } : line));
      }
      return [...current, { product, option, quantity: 1, priceAtAdd: product.price, costAtAdd: product.baseCost }];
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const removeFromCart = (productId: string) => {
    setCart((current) =>
      current
        .map((line) => (line.product.id === productId ? { ...line, quantity: line.quantity - 1 } : line))
        .filter((line) => line.quantity > 0),
    );
  };

  const toggleFavorite = (productId: string) => {
    setFavorites((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId],
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // ---------------- orders ----------------

  useEffect(() => {
    if (isCloudMode && authUser && !authUser.isGuest) {
      updateDataLoadState('orders', { status: 'loading', error: null, retryAction: 'Reload orders' });
      updateDataLoadState('paymentAttempts', { status: 'loading', error: null, retryAction: 'Reload payment attempts' });
      const uidFilter = authUser.role === 'seller' || authUser.role === 'admin' ? undefined : authUser.uid;
      const unsubscribe = subscribeToOrders(
        (remoteOrders) => {
          setOrders(remoteOrders);
          updateDataLoadState('orders', { status: 'ready', error: null, retryAction: null });
        },
        (error) => {
          const message = error instanceof Error ? error.message : 'Could not load orders.';
          console.warn('[orders]', message);
          updateDataLoadState('orders', {
            status: 'error',
            error: message,
            retryAction: 'Reload orders',
          });
        },
        uidFilter,
      );
      const unsubscribeAttempts = subscribeToPaymentAttempts(
        (remoteAttempts) => {
          setPaymentAttempts(remoteAttempts);
          updateDataLoadState('paymentAttempts', { status: 'ready', error: null, retryAction: null });
        },
        (error) => {
          const message = error instanceof Error ? error.message : 'Could not load payment attempts.';
          console.warn('[payment attempts]', message);
          updateDataLoadState('paymentAttempts', {
            status: 'error',
            error: message,
            retryAction: 'Reload payment attempts',
          });
        },
        authUser.role === 'admin' ? undefined : authUser.uid,
      );
      return () => {
        unsubscribe();
        unsubscribeAttempts();
      };
    }

    setPaymentAttempts([]);
    updateDataLoadState('orders', { status: 'loading', error: null, retryAction: 'Reload orders' });
    AsyncStorage.getItem(STORAGE_KEYS.orders).then((saved) => {
      setOrders(saved ? (JSON.parse(saved) as Order[]) : []);
      updateDataLoadState('orders', { status: 'ready', error: null, retryAction: null });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not load local orders.';
      console.warn('[orders] local-cache read failed', message);
      setOrders([]);
      updateDataLoadState('orders', {
        status: 'error',
        error: message,
        retryAction: 'Reload orders',
      });
    });
    updateDataLoadState('paymentAttempts', { status: 'ready', error: null, retryAction: null });
  }, [isCloudMode, authUser && !authUser.isGuest ? `${authUser.role}:${authUser.uid}` : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.orders, JSON.stringify(orders));
  }, [orders, isCloudMode]);

  const placeOrder: StoreContextValue['placeOrder'] = async (details) => {
    if (details.paymentMethod !== 'UPI') {
      throw new Error('Only online payment (UPI) is accepted. Cash on delivery is no longer available.');
    }
    if (!isCloudMode || !authUser || authUser.isGuest) {
      throw new Error('Sign in with an account to place a manual UPI order.');
    }
    if (!cart.length) throw new Error('Your cart is empty.');
    const order = await createManualUpiOrderRemote({
      items: cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        option: line.option,
      })),
      customerName: details.customerName,
      customerPhone: details.customerPhone,
      customerAddress: details.customerAddress,
       idempotencyKey: details.idempotencyKey,
    });
    setCart([]);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return order;
  };

  const submitManualOrderUtr: StoreContextValue['submitManualOrderUtr'] = async (orderId, customerUtr) => {
    if (!isCloudMode || !authUser || authUser.isGuest) {
       throw new Error('Sign in with an account to submit your payment reference.');
    }
    await submitManualUpiOrderUtrRemote(orderId, customerUtr);
  };

  const submitPaymentDetails: StoreContextValue['submitPaymentDetails'] = async (attemptId, customerUtr) => {
    if (!isCloudMode || !authUser || authUser.isGuest) {
      throw new Error('Sign in with an account to submit payment details.');
    }
    const trimmedUtr = customerUtr.trim();
    if (!trimmedUtr) throw new Error('Enter the UTR/reference number from your payment app.');
    await submitPaymentDetailsViaWorker({ attemptId, customerUtr: trimmedUtr });
  };

  const verifyPaymentAttempt: StoreContextValue['verifyPaymentAttempt'] = async (attemptId) => {
    if (!isAdmin || !isCloudMode) throw new Error('Only an authenticated administrator can verify payments.');
    await confirmPaymentAttemptViaWorker(attemptId);
    setAuditLogs(await fetchAuditLogsRemote());
  };

  const reviewPaymentAttempt: StoreContextValue['reviewPaymentAttempt'] = async (action, attemptId, reason) => {
    if (!isAdmin || !isCloudMode) throw new Error('Only an authenticated administrator can review payments.');
    await reviewPaymentAttemptViaWorker(action, attemptId, reason);
    setAuditLogs(await fetchAuditLogsRemote());
  };

  const verifyManualUpiOrderPayment: StoreContextValue['verifyManualUpiOrderPayment'] = async (orderId, customerUtr) => {
    if (!isAdmin || !isCloudMode) throw new Error('Only an authenticated administrator can verify payments.');
    await confirmManualUpiOrderPaymentRemote(orderId, customerUtr.trim());
    setAuditLogs(await fetchAuditLogsRemote());
  };

  const rejectManualUpiOrderPayment: StoreContextValue['rejectManualUpiOrderPayment'] = async (orderId, reason) => {
    if (!isAdmin || !isCloudMode) throw new Error('Only an authenticated administrator can review payments.');
    await rejectManualUpiOrderPaymentRemote(orderId, reason);
    setAuditLogs(await fetchAuditLogsRemote());
  };

  const updateOrderStatus: StoreContextValue['updateOrderStatus'] = async (orderId, status) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found.');
    if (order.paymentStatus !== 'Paid') throw new Error('Only paid orders can enter fulfillment.');
    if (!canTransitionOrderStatus(order.status, status)) {
      throw new Error(`Cannot transition from "${order.status}" to "${status}".`);
    }
    if (status === 'Cancelled') {
      throw new Error('Use the cancellation action so the cancellation is recorded safely.');
    }
    if (isCloudMode) {
      await updateOrderStatusRemote(orderId, status);
      return;
    }
    setOrders((current) => current.map((o) => (o.id === orderId ? { ...o, status } : o)));
  };

  const cancelOrder: StoreContextValue['cancelOrder'] = async (orderId) => {
    if (cancellingOrderIds.current.has(orderId)) throw new Error('This order cancellation is already in progress.');
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found.');
    if (order.paymentStatus !== 'Paid') throw new Error('Only paid orders can be cancelled as orders.');
    const canSellerCancel = ['seller', 'admin'].includes(authUser && !authUser.isGuest ? authUser.role : '');
    const allowed = canSellerCancel
      ? canTransitionOrderStatus(order.status, 'Cancelled')
      : canCancelOrder(order.status);
    if (!allowed) {
      throw new Error(`Orders in "${order.status}" status cannot be cancelled. Contact support if needed.`);
    }
    cancellingOrderIds.current.add(orderId);
    try {
      if (isCloudMode) {
        await updateOrderStatusRemote(
          orderId,
          'Cancelled',
          canSellerCancel ? 'Cancelled by store staff' : 'Customer requested cancellation',
        );
        return;
      }
      setOrders((current) => current.map((o) => (
        o.id === orderId
          ? { ...o, status: 'Cancelled', cancellationReason: canSellerCancel ? 'Cancelled by store staff' : 'Customer requested cancellation', cancelledAt: new Date().toISOString() }
          : o
      )));
    } finally {
      cancellingOrderIds.current.delete(orderId);
    }
  };

  const setTrackingId: StoreContextValue['setTrackingId'] = async (orderId, trackingId) => {
    if (isCloudMode) {
      await setOrderTrackingIdRemote(orderId, trackingId);
      return;
    }
    setOrders((current) => current.map((order) => (order.id === orderId ? { ...order, trackingId } : order)));
  };

  // ---------------- admin methods ----------------

  useEffect(() => {
    if (isCloudMode) {
      fetchStoreSettingsRemote().then(setStoreSettings).catch(() => {});
      fetchPaymentSettingsRemote().then(setPaymentSettings).catch(() => {});
      if (isAdmin) {
        fetchUsersRemote().then(setUsersList).catch(() => {});
        fetchAuditLogsRemote().then(setAuditLogs).catch(() => {});
      }
    } else {
      AsyncStorage.getItem(STORAGE_KEYS.settings).then((saved) => {
        if (saved) {
          try {
            setStoreSettings({ ...defaultStoreSettings, ...JSON.parse(saved) });
          } catch {
            setStoreSettings(defaultStoreSettings);
          }
        }
      });
      AsyncStorage.getItem(STORAGE_KEYS.paymentSettings).then((saved) => {
        if (saved) setPaymentSettings(JSON.parse(saved));
      });
      AsyncStorage.getItem(STORAGE_KEYS.users).then((saved) => {
        if (saved) {
          setUsersList(JSON.parse(saved));
        } else {
          setUsersList([
            { uid: 'demo-admin', email: 'admin@vibekart.in', name: 'Store Owner', role: 'admin', status: 'active' },
            { uid: 'demo-seller', email: 'seller@vibekart.in', name: 'Studio Clay Co.', role: 'seller', status: 'active' },
            { uid: 'demo-cust-1', email: 'aarav@example.com', name: 'Aarav Sharma', role: 'customer', status: 'active' },
            { uid: 'demo-cust-2', email: 'priya@example.com', name: 'Priya Patel', role: 'customer', status: 'active' },
          ]);
        }
      });
      AsyncStorage.getItem(STORAGE_KEYS.auditLogs).then((saved) => {
        if (saved) setAuditLogs(JSON.parse(saved));
      });
    }
  }, [isCloudMode, isAdmin]);

  const refreshUsers: StoreContextValue['refreshUsers'] = async () => {
    if (isCloudMode) {
      const list = await fetchUsersRemote();
      setUsersList(list);
    }
  };

  const changeUserRole: StoreContextValue['changeUserRole'] = async (uid, role) => {
    if (authUser && !authUser.isGuest && authUser.uid === uid) {
      throw new Error('Administrators cannot change their own role.');
    }
    if (isCloudMode) {
      await updateUserRoleRemote(uid, role);
      await refreshUsers();
    } else {
      setUsersList((curr) => {
        const next = curr.map((u) => (u.uid === uid ? { ...u, role } : u));
        AsyncStorage.setItem(STORAGE_KEYS.users, JSON.stringify(next));
        return next;
      });
    }
    await logAdminActivity('Update Role', `Changed role for user ${uid} to ${role}`, uid);
  };

  const changeUserStatus: StoreContextValue['changeUserStatus'] = async (uid, status) => {
    if (authUser && !authUser.isGuest && authUser.uid === uid) {
      throw new Error('Administrators cannot suspend their own account.');
    }
    if (isCloudMode) {
      await updateUserStatusRemote(uid, status);
      await refreshUsers();
    } else {
      setUsersList((curr) => {
        const next = curr.map((u) => (u.uid === uid ? { ...u, status } : u));
        AsyncStorage.setItem(STORAGE_KEYS.users, JSON.stringify(next));
        return next;
      });
    }
    await logAdminActivity('Update Account Status', `Set status to ${status} for user ${uid}`, uid);
  };

  const updateStoreSettings: StoreContextValue['updateStoreSettings'] = async (patch) => {
    const merged = { ...storeSettings, ...patch };
    const validationError = validateStoreSettings(merged);
    if (validationError) throw new Error(validationError);
    if (isCloudMode) {
      await updateStoreSettingsRemote(patch);
    } else {
      await AsyncStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(merged));
    }
    setStoreSettings(merged);
    await logAdminActivity('Update Store Settings', `Updated settings: ${Object.keys(patch).join(', ')}`);
  };

  const updatePaymentSettings: StoreContextValue['updatePaymentSettings'] = async (patch) => {
    if (!isAdmin) throw new Error('Only administrators can update payment settings.');
    const merged = { ...paymentSettings, ...patch };
    setPaymentSettings(merged);
    await AsyncStorage.setItem(STORAGE_KEYS.paymentSettings, JSON.stringify(merged));
    if (isCloudMode) {
      const hasQrPatch = Object.prototype.hasOwnProperty.call(patch, 'qrImageUrl') ||
        Object.prototype.hasOwnProperty.call(patch, 'qrImagePublicId');
      if (hasQrPatch) {
        await updatePaymentQrViaWorker(merged.qrImageUrl ?? '', merged.qrImagePublicId ?? '');
      }
      const { qrImageUrl: _qrImageUrl, qrImagePublicId: _qrImagePublicId, ...otherSettings } = patch;
      if (Object.keys(otherSettings).length) await updatePaymentSettingsRemote(otherSettings);
    }
    await logAdminActivity('Update Payment Settings', `Updated payment config: ${Object.keys(patch).join(', ')}`);
  };

  const logAdminActivity: StoreContextValue['logAdminActivity'] = async (action, details, targetId) => {
    const adminEmail = authUser && !authUser.isGuest ? authUser.email : 'admin@vibekart.in';
    const adminUid = authUser && !authUser.isGuest ? authUser.uid : 'admin-local';
    if (isCloudMode) {
      await createAuditLogRemote(sanitizeAuditLogPayload({ adminEmail, adminUid, action, details, targetId }));
      const logs = await fetchAuditLogsRemote();
      setAuditLogs(logs);
    } else {
      const newLog: AdminAuditLog = sanitizeAuditLogPayload({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        adminEmail,
        adminUid,
        action,
        details,
        targetId,
      }) as AdminAuditLog;
      setAuditLogs((curr) => {
        const next = [newLog, ...curr.slice(0, 49)];
        AsyncStorage.setItem(STORAGE_KEYS.auditLogs, JSON.stringify(next));
        return next;
      });
    }
  };

  // ---------------- analytics ----------------

  const analytics = useMemo(() => {
    const paidOrders = orders.filter((o) => o.paymentStatus === 'Paid');
    const activeOrders = paidOrders.filter((o) => o.status !== 'Cancelled');
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.total, 0);
    const totalCost = activeOrders.reduce((sum, o) => sum + (o.costTotal ?? 0), 0);
    const totalProfit = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 1000) / 10 : 0;
    return {
      totalRevenue,
      totalCost,
      totalProfit,
      marginPercent,
      ordersCount: paidOrders.length,
      activeOrdersCount: paidOrders.filter((o) => !['Delivered', 'Cancelled'].includes(o.status)).length,
      deliveredCount: paidOrders.filter((o) => o.status === 'Delivered').length,
      cancelledCount: paidOrders.filter((o) => o.status === 'Cancelled').length,
      lowStockCount: products.filter((p) => !p.inStock).length,
      disabledCount: products.filter((p) => p.enabled === false).length,
    };
  }, [orders, products]);

  const value = useMemo<StoreContextValue>(
    () => ({
      isCloudMode,
      dataLoadState,
      products,
      addProduct,
      updateProduct,
      deleteProduct,
      deletingProductId,
      toggleStock,
      toggleEnabled,
      toggleFeatured,
      categories,
      addCategory,
      updateCategory,
      deleteCategory,
      toggleCategoryEnabled,
      cart,
      orders,
      paymentAttempts,
      favorites,
      cartCount: cart.reduce((sum, line) => sum + line.quantity, 0),
      cartTotal: cart.reduce((sum, line) => sum + line.priceAtAdd * line.quantity, 0),
      addToCart,
      removeFromCart,
      toggleFavorite,
      isFavorite: (productId: string) => favorites.includes(productId),
      placeOrder,
      submitManualOrderUtr,
      submitPaymentDetails,
      verifyPaymentAttempt,
      reviewPaymentAttempt,
      verifyManualUpiOrderPayment,
      rejectManualUpiOrderPayment,
      updateOrderStatus,
      setTrackingId,
      cancelOrder,
      analytics,
      isAdmin,
      storeSettings,
      updateStoreSettings,
      paymentSettings,
      updatePaymentSettings,
      usersList,
      refreshUsers,
      changeUserRole,
      changeUserStatus,
      auditLogs,
      logAdminActivity,
      authUser,
      authLoaded,
      authError,
      signUpEmail,
      signInEmail,
      sendPhoneOtp,
      verifyPhoneOtp,
      signInWithGoogle,
      continueAsGuest,
      logout,
    }),
    [
      isCloudMode,
      dataLoadState,
      products,
      categories,
      cart,
      orders,
      paymentAttempts,
      favorites,
      analytics,
      isAdmin,
      storeSettings,
      paymentSettings,
      usersList,
      auditLogs,
      authUser,
      authLoaded,
      authError,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside StoreProvider');
  return context;
}
