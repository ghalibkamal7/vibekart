import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  AdminAuditLog,
  canCancelOrder,
  canTransitionOrderStatus,
  CategoryItem,
  computeDisplayPrice,
  defaultCategoryItems,
  defaultProducts,
  defaultStoreSettings,
  getAssignedProductCount,
  NewProductInput,
  normalizeSlug,
  Order,
  OrderStatus,
  Product,
  StoreSettings,
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
import { isFirebaseConfigured } from '@/services/firebase/config';
import {
  createAuditLogRemote,
  createCategoryRemote,
  createOrder,
  createOrderViaWorker,
  createProduct,
  editProduct,
  fetchAuditLogsRemote,
  fetchSellerProducts,
  fetchStoreSettingsRemote,
  fetchUsersRemote,
  removeCategoryRemote,
  removeProduct,
  setOrderTrackingId as setOrderTrackingIdRemote,
  setProductEnabled as setProductEnabledRemote,
  setProductFeatured as setProductFeaturedRemote,
  setProductStock as setProductStockRemote,
  subscribeToCategories,
  subscribeToOrders,
  subscribeToProducts,
  updateCategoryRemote,
  updateOrderStatusRemote,
  updateStoreSettingsRemote,
  updateUserRoleRemote,
  updateUserStatusRemote,
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

type StoreContextValue = {
  // mode
  isCloudMode: boolean; // true once Firebase is configured AND a real (non-guest) user is signed in

  // catalogue
  products: Product[];
  addProduct: (input: NewProductInput) => Promise<string>;
  updateProduct: (id: string, patch: Partial<NewProductInput>) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
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
  }) => Promise<Order | null>;

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
  users: 'vibekart-users',
  auditLogs: 'vibekart-audit-logs',
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [products, setProducts] = useState<Product[]>(defaultProducts);
  const [categories, setCategories] = useState<CategoryItem[]>(defaultCategoryItems);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [storeSettings, setStoreSettings] = useState<StoreSettings>(defaultStoreSettings);
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
      if (authUser && !authUser.isGuest && authUser.role === 'seller') {
        refreshSellerProducts();
        return;
      }
      const unsubscribe = subscribeToProducts(setProducts, (error) =>
        console.warn('[products]', error.message),
      );
      return unsubscribe;
    }

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
        } catch {
          setProducts(defaultProducts);
        }
      } else {
        setProducts(defaultProducts);
      }
    });
  }, [isCloudMode, authUser && !authUser.isGuest ? authUser.role : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.products, JSON.stringify(products));
  }, [products, isCloudMode]);

  // ---------------- categories ----------------
  useEffect(() => {
    if (isCloudMode) {
      const unsubscribe = subscribeToCategories(
        (remoteCategories) => {
          if (remoteCategories.length > 0) {
            setCategories(remoteCategories);
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
              } catch (seedErr) {
                console.warn('[categories] failed to seed default categories', seedErr);
              }
            })();
          } else {
            setCategories(defaultCategoryItems);
          }
        },
        (error) => {
          console.warn('[categories] listener error', error.message);
          setCategories(defaultCategoryItems);
        },
      );
      return unsubscribe;
    }

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
            return;
          }
        } catch {
          // fallback below
        }
      }
      setCategories(defaultCategoryItems);
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
      rating: 4.5,
      reviews: 0,
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
    if (isCloudMode) {
      const target = products.find((product) => product.id === id);
      await removeProduct(id);
      await refreshSellerProducts();
     
      return;
    }
    setProducts((current) => current.filter((product) => product.id !== id));
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
      const uidFilter = authUser.role === 'seller' ? undefined : authUser.uid;
      const unsubscribe = subscribeToOrders(setOrders, (error) => console.warn('[orders]', error.message), uidFilter);
      return unsubscribe;
    }

    AsyncStorage.getItem(STORAGE_KEYS.orders).then((saved) => {
      setOrders(saved ? (JSON.parse(saved) as Order[]) : []);
    });
  }, [isCloudMode, authUser && !authUser.isGuest ? `${authUser.role}:${authUser.uid}` : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.orders, JSON.stringify(orders));
  }, [orders, isCloudMode]);

  const placeOrder: StoreContextValue['placeOrder'] = async (details) => {
    // Enforce online-only payment — COD is no longer accepted
    if (details.paymentMethod !== 'UPI') {
      throw new Error('Only online payment (UPI) is accepted. Cash on delivery is no longer available.');
    }
    if (!cart.length) return null;
    const items = cart.map((line) => ({
      productId: line.product.id,
      name: line.product.name,
      option: line.option,
      quantity: line.quantity,
      unitPrice: line.priceAtAdd,
      unitCost: line.costAtAdd,
      sourceUrl: line.product.sourceUrl,
    }));
    const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const costTotal = items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0);

    if (isCloudMode && authUser && !authUser.isGuest) {
      const idempotencyKey = `idemp-${authUser.uid}-${Date.now().toString()}`;
      const workerUrl = process.env.EXPO_PUBLIC_OTP_WORKER_URL?.replace(/\/+$/, '');

      if (workerUrl) {
        // Secure, server-authoritative flow via Cloudflare Worker
        const order = await createOrderViaWorker({
          items: cart.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
            option: line.option,
          })),
          customerName: details.customerName,
          customerPhone: details.customerPhone,
          customerAddress: details.customerAddress,
          paymentMethod: details.paymentMethod,
          idempotencyKey,
        });
        setCart([]);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return order;
      }

      // Safe client creation without leaking supplier costs
      const customerSafeItems = items.map((it) => ({
        productId: it.productId,
        name: it.name,
        option: it.option,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      }));
      const id = await createOrder({
        customerUid: authUser.uid,
        items: customerSafeItems,
        total,
        customerName: details.customerName,
        customerPhone: details.customerPhone,
        customerAddress: details.customerAddress,
        paymentMethod: details.paymentMethod,
        idempotencyKey,
      });
      setCart([]);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return {
        id,
        items: customerSafeItems,
        total,
        status: 'Placed',
        paymentStatus: 'Selected',
        date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        ...details,
      } as Order;
    }

    const order: Order = {
      id: `VK-${Date.now().toString().slice(-6)}`,
      items,
      total,
      costTotal,
      profitTotal: total - costTotal,
      status: 'Placed',
      date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      customerName: details.customerName,
      customerPhone: details.customerPhone,
      customerAddress: details.customerAddress,
      paymentMethod: details.paymentMethod,
    };
    setOrders((current) => [order, ...current]);
    setCart([]);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return order;
  };

  const updateOrderStatus: StoreContextValue['updateOrderStatus'] = async (orderId, status) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found.');
    if (!canTransitionOrderStatus(order.status, status)) {
      throw new Error(`Cannot transition from "${order.status}" to "${status}".`);
    }
    if (isCloudMode) {
      await updateOrderStatusRemote(orderId, status);
      return;
    }
    setOrders((current) => current.map((o) => (o.id === orderId ? { ...o, status } : o)));
  };

  const cancelOrder: StoreContextValue['cancelOrder'] = async (orderId) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found.');
    if (!canCancelOrder(order.status)) {
      throw new Error(`Orders in "${order.status}" status cannot be cancelled. Contact support if needed.`);
    }
    if (isCloudMode) {
      await updateOrderStatusRemote(orderId, 'Cancelled');
      return;
    }
    setOrders((current) => current.map((o) => (o.id === orderId ? { ...o, status: 'Cancelled' } : o)));
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
      if (isAdmin) {
        fetchUsersRemote().then(setUsersList).catch(() => {});
        fetchAuditLogsRemote().then(setAuditLogs).catch(() => {});
      }
    } else {
      AsyncStorage.getItem(STORAGE_KEYS.settings).then((saved) => {
        if (saved) setStoreSettings(JSON.parse(saved));
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
    setStoreSettings(merged);
    if (isCloudMode) {
      await updateStoreSettingsRemote(patch);
    } else {
      await AsyncStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(merged));
    }
    await logAdminActivity('Update Store Settings', `Updated settings: ${Object.keys(patch).join(', ')}`);
  };

  const logAdminActivity: StoreContextValue['logAdminActivity'] = async (action, details, targetId) => {
    const adminEmail = authUser && !authUser.isGuest ? authUser.email : 'admin@vibekart.in';
    const adminUid = authUser && !authUser.isGuest ? authUser.uid : 'admin-local';
    if (isCloudMode) {
      await createAuditLogRemote({ adminEmail, adminUid, action, details, targetId });
      const logs = await fetchAuditLogsRemote();
      setAuditLogs(logs);
    } else {
      const newLog: AdminAuditLog = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        adminEmail,
        adminUid,
        action,
        details,
        targetId,
      };
      setAuditLogs((curr) => {
        const next = [newLog, ...curr.slice(0, 49)];
        AsyncStorage.setItem(STORAGE_KEYS.auditLogs, JSON.stringify(next));
        return next;
      });
    }
  };

  // ---------------- analytics ----------------

  const analytics = useMemo(() => {
    // Exclude cancelled orders from financial metrics
    const activeOrders = orders.filter((o) => o.status !== 'Cancelled');
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.total, 0);
    const totalCost = activeOrders.reduce((sum, o) => sum + (o.costTotal ?? 0), 0);
    const totalProfit = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 1000) / 10 : 0;
    return {
      totalRevenue,
      totalCost,
      totalProfit,
      marginPercent,
      ordersCount: orders.length,
      activeOrdersCount: orders.filter((o) => !['Delivered', 'Cancelled'].includes(o.status)).length,
      deliveredCount: orders.filter((o) => o.status === 'Delivered').length,
      cancelledCount: orders.filter((o) => o.status === 'Cancelled').length,
      lowStockCount: products.filter((p) => !p.inStock).length,
      disabledCount: products.filter((p) => p.enabled === false).length,
    };
  }, [orders, products]);

  const value = useMemo<StoreContextValue>(
    () => ({
      isCloudMode,
      products,
      addProduct,
      updateProduct,
      deleteProduct,
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
      favorites,
      cartCount: cart.reduce((sum, line) => sum + line.quantity, 0),
      cartTotal: cart.reduce((sum, line) => sum + line.priceAtAdd * line.quantity, 0),
      addToCart,
      removeFromCart,
      toggleFavorite,
      isFavorite: (productId: string) => favorites.includes(productId),
      placeOrder,
      updateOrderStatus,
      setTrackingId,
      cancelOrder,
      analytics,
      isAdmin,
      storeSettings,
      updateStoreSettings,
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
      products,
      categories,
      cart,
      orders,
      favorites,
      analytics,
      isAdmin,
      storeSettings,
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
