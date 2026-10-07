import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { computeDisplayPrice, defaultProducts, NewProductInput, Order, OrderStatus, Product } from '@/data/store';

import {
  confirmPhoneOtp,
  fetchUserProfile,
  requestPhoneOtp,
  signIn as firebaseSignIn,
  signOutUser,
  signUp as firebaseSignUp,
  subscribeToAuthState,
  UserRole,
} from '@/services/firebase/auth';
import { isFirebaseConfigured } from '@/services/firebase/config';
import {
  createOrder,
  createProduct,
  editProduct,
  fetchSellerProducts,
  removeProduct,
  setOrderTrackingId as setOrderTrackingIdRemote,
  setProductStock as setProductStockRemote,
  subscribeToOrders,
  subscribeToProducts,
  updateOrderStatusRemote,
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

  // analytics (seller side)
  analytics: {
    totalRevenue: number;
    totalCost: number;
    totalProfit: number;
    ordersCount: number;
    deliveredCount: number;
  };

  // auth
  authUser: AuthUser;
  authLoaded: boolean;
  authError: string | null;
  signUpEmail: (params: { email: string; password: string; name: string; phone?: string }) => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  sendPhoneOtp: (phone: string) => Promise<void>;
  verifyPhoneOtp: (phone: string, otp: string) => Promise<void>;
  continueAsGuest: () => void;
  logout: () => Promise<void>;
};

const StoreContext = createContext<StoreContextValue | null>(null);

const STORAGE_KEYS = {
  cart: 'vibekart-cart',
  orders: 'vibekart-orders',
  favorites: 'vibekart-favorites',
  products: 'vibekart-products',
  auth: 'vibekart-auth',
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [products, setProducts] = useState<Product[]>(defaultProducts);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const isCloudMode = isFirebaseConfigured && !!authUser && !authUser.isGuest;

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
            name: profile?.name ?? '',
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
      setProducts(saved ? (JSON.parse(saved) as Product[]) : defaultProducts);
    });
  }, [isCloudMode, authUser && !authUser.isGuest ? authUser.role : null]);

  useEffect(() => {
    if (!isCloudMode) AsyncStorage.setItem(STORAGE_KEYS.products, JSON.stringify(products));
  }, [products, isCloudMode]);

  const addProduct: StoreContextValue['addProduct'] = async (input) => {
    if (isCloudMode) {
      const id = await createProduct(input);
      await refreshSellerProducts();
      return id;
    }
    const price = computeDisplayPrice(input.baseCost, input.markupType, input.markupValue);
    const product: Product = {
      id: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Date.now().toString().slice(-4)}`,
      name: input.name,
      subtitle: input.subtitle,
      description: input.description,
      category: input.category,
      image: input.image ?? defaultProducts[0].image,
      rating: 4.5,
      reviews: 0,
      colors: input.colors.length ? input.colors : ['Standard'],
      sizes: input.sizes,
      inStock: true,
      baseCost: input.baseCost,
      markupType: input.markupType,
      markupValue: input.markupValue,
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
        const price = computeDisplayPrice(merged.baseCost, merged.markupType, merged.markupValue);
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
      const id = await createOrder({
        customerUid: authUser.uid,
        items,
        total,
        // Placeholders only — the customer client cannot read real cost data
        // (see firestore.rules). The reconcileOrderCost Cloud Function
        // overwrites these with authoritative values right after creation.
        costTotal: 0,
        profitTotal: 0,
        customerName: details.customerName,
        customerPhone: details.customerPhone,
        customerAddress: details.customerAddress,
        paymentMethod: details.paymentMethod,
      });
      setCart([]);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return {
        id,
        items,
        total,
        costTotal: 0,
        profitTotal: 0,
        status: 'Placed',
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
    if (isCloudMode) {
      await updateOrderStatusRemote(orderId, status);
      return;
    }
    setOrders((current) => current.map((order) => (order.id === orderId ? { ...order, status } : order)));
  };

  const setTrackingId: StoreContextValue['setTrackingId'] = async (orderId, trackingId) => {
    if (isCloudMode) {
      await setOrderTrackingIdRemote(orderId, trackingId);
      return;
    }
    setOrders((current) => current.map((order) => (order.id === orderId ? { ...order, trackingId } : order)));
  };

  // ---------------- analytics ----------------

  const analytics = useMemo(() => {
    const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);
    const totalCost = orders.reduce((sum, order) => sum + order.costTotal, 0);
    return {
      totalRevenue,
      totalCost,
      totalProfit: totalRevenue - totalCost,
      ordersCount: orders.length,
      deliveredCount: orders.filter((order) => order.status === 'Delivered').length,
    };
  }, [orders]);

  const value = useMemo<StoreContextValue>(
    () => ({
      isCloudMode,
      products,
      addProduct,
      updateProduct,
      deleteProduct,
      toggleStock,
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
      analytics,
      authUser,
      authLoaded,
      authError,
      signUpEmail,
      signInEmail,
      sendPhoneOtp,
      verifyPhoneOtp,
      continueAsGuest,
      logout,
    }),
    [isCloudMode, products, cart, orders, favorites, analytics, authUser, authLoaded, authError],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside StoreProvider');
  return context;
}
