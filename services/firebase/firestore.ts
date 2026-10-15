import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  DocumentData,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AdminAuditLog,
  CategoryItem,
  computeDisplayPrice,
  defaultPaymentSettings,
  defaultStoreSettings,
  NewProductInput,
  Order,
  PaymentAttempt,
  PaymentSettings,
  Product,
  StoreSettings,
} from '@/data/store';
import { auth, db } from './config';
import { UserProfile, UserRole } from './auth';

const PRODUCTS_COLLECTION = 'products';
const CATEGORIES_COLLECTION = 'categories';
const ORDERS_COLLECTION = 'orders';
const USERS_COLLECTION = 'users';
const SETTINGS_COLLECTION = 'settings';
const SETTINGS_DOC_ID = 'store';
export const PAYMENT_SETTINGS_DOC_ID = 'payment';
const AUDIT_LOGS_COLLECTION = 'audit_logs';
const PRIVATE_SUBCOLLECTION = 'private';
const PRIVATE_DOC_ID = 'data';

function requireDb() {
  if (!db) throw new Error('Firebase is not configured. See .env.example.');
  return db;
}

const PRIVATE_FIELDS = ['baseCost', 'markupType', 'markupValue', 'manualPrice', 'sourceUrl', 'sourceCode'] as const;
type PrivateFields = Pick<Product, 'baseCost' | 'markupType' | 'markupValue' | 'manualPrice' | 'sourceUrl' | 'sourceCode'>;

function splitProductInput(input: Partial<NewProductInput>) {
  const priv: Record<string, unknown> = {};
  const pub: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if ((PRIVATE_FIELDS as readonly string[]).includes(key)) priv[key] = value;
    else pub[key] = value;
  }
  // Explicit sanitization: ensure no private field ever lands in the public doc
  for (const field of PRIVATE_FIELDS) {
    delete pub[field];
  }
  return { pub, priv };
}

/**
 * Two-document model per product, enforced by firestore.rules (not just the
 * client): Firestore security rules can only allow/deny a READ at the whole
 * -document level, not per field — so hiding `baseCost` from customers while
 * showing it to sellers on the SAME document isn't actually possible with
 * rules alone. Splitting into a public doc + a seller-only private
 * sub-document is what makes "customer never sees cost" a real, enforced
 * guarantee instead of a client-side convention.
 *
 *   products/{id}                    -> public, readable by anyone signed in
 *   products/{id}/private/data       -> baseCost, markup fields, sourceUrl,
 *                                        sourceCode — readable & writable
 *                                        only by sellers
 */

// ---------------- Customer-facing reads (public fields only) ----------------

export function subscribeToProducts(onChange: (products: Product[]) => void, onError?: (error: Error) => void) {
  const database = requireDb();
  const q = query(collection(database, PRODUCTS_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const products = snapshot.docs.map((d) => toPublicProduct(d.id, d.data()));
      onChange(products);
    },
    (error) => onError?.(error as Error),
  );
}

function toPublicProduct(id: string, data: DocumentData): Product {
  // Explicit sanitization: baseCost/markup*/manualPrice/sourceUrl/sourceCode are
  // guaranteed absent — they live in the private sub-document a customer's rules
  // never permit reading.
  const sanitized = { ...data };
  for (const field of PRIVATE_FIELDS) {
    delete sanitized[field];
  }
  return {
    id,
    baseCost: 0,
    markupType: 'fixed',
    markupValue: 0,
    inStock: sanitized.inStock ?? true,
    enabled: sanitized.enabled ?? true,
    featured: sanitized.featured ?? false,
    isNew: sanitized.isNew ?? false,
    ...sanitized,
  } as Product;
}

// ---------------- Seller-facing reads (public + private merged) ----------------

export async function fetchSellerProducts(): Promise<Product[]> {
  const database = requireDb();
  const snapshot = await getDocs(query(collection(database, PRODUCTS_COLLECTION), orderBy('createdAt', 'desc')));
  const products = await Promise.all(
    snapshot.docs.map(async (d) => {
      const privateSnap = await getDoc(doc(database, PRODUCTS_COLLECTION, d.id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID));
      const priv = (privateSnap.exists() ? privateSnap.data() : {}) as Partial<PrivateFields>;
      return {
        id: d.id,
        inStock: d.data().inStock ?? true,
        enabled: d.data().enabled ?? true,
        featured: d.data().featured ?? false,
        isNew: d.data().isNew ?? false,
        ...d.data(),
        ...priv,
      } as Product;
    }),
  );
  return products;
}

// ---------------- Writes (seller only, enforced by firestore.rules) ----------------

export async function createProduct(input: NewProductInput): Promise<string> {
  const database = requireDb();
  const price = computeDisplayPrice(input.baseCost, input.markupType, input.markupValue, input.manualPrice);
  const { pub, priv } = splitProductInput(input);
  const docRef = await addDoc(collection(database, PRODUCTS_COLLECTION), {
    ...pub,
    price,
    inStock: input.inStock ?? true,
    enabled: input.enabled ?? true,
    featured: input.featured ?? false,
    isNew: input.isNew ?? false,
    rating: 4.5,
    reviews: 0,
    createdAt: serverTimestamp(),
  });
  await setDoc(doc(database, PRODUCTS_COLLECTION, docRef.id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID), priv);
  return docRef.id;
}

export async function editProduct(id: string, patch: Partial<NewProductInput>): Promise<void> {
  const database = requireDb();
  const { pub, priv } = splitProductInput(patch);
  if (Object.keys(pub).length) {
    await updateDoc(doc(database, PRODUCTS_COLLECTION, id), pub);
  }
  if (Object.keys(priv).length) {
    await setDoc(doc(database, PRODUCTS_COLLECTION, id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID), priv, { merge: true });
    // Price always depends on cost + markup or manual price, so recompute it on the public
    // doc whenever either changes — customers only ever read this field.
    const privateSnap = await getDoc(doc(database, PRODUCTS_COLLECTION, id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID));
    const merged = privateSnap.data() as PrivateFields;
    if (merged?.baseCost !== undefined) {
      const price = computeDisplayPrice(
        merged.baseCost,
        merged.markupType ?? 'fixed',
        merged.markupValue ?? 0,
        merged.manualPrice,
      );
      await updateDoc(doc(database, PRODUCTS_COLLECTION, id), { price });
    }
  }
}

export async function removeProduct(id: string): Promise<void> {
  const database = requireDb();
  await deleteDoc(doc(database, PRODUCTS_COLLECTION, id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID));
  await deleteDoc(doc(database, PRODUCTS_COLLECTION, id));
}

export async function setProductStock(id: string, inStock: boolean): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, PRODUCTS_COLLECTION, id), { inStock });
}

export async function setProductEnabled(id: string, enabled: boolean): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, PRODUCTS_COLLECTION, id), { enabled });
}

export async function setProductFeatured(id: string, featured: boolean): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, PRODUCTS_COLLECTION, id), { featured });
}

// ---------------- Orders ----------------
// The Worker creates orders only after an administrator verifies the UPI credit.

export async function fetchPaymentConfigViaWorker(): Promise<{
  gpayEnabled: boolean;
  status: 'CONFIGURED' | 'SETUP_PENDING';
  merchantName: string;
  merchantVpa: string | null;
  merchantMcc: string;
  environment: string;
  missing?: string[];
  message: string;
}> {
  const workerUrl = process.env.EXPO_PUBLIC_OTP_WORKER_URL?.replace(/\/+$/, '');
  if (!workerUrl) {
    return {
      gpayEnabled: false,
      status: 'SETUP_PENDING',
      merchantName: 'VibeKart',
      merchantVpa: null,
      merchantMcc: '5399',
      environment: 'TEST',
      missing: ['EXPO_PUBLIC_OTP_WORKER_URL'],
      message: 'Payment worker URL is not configured.',
    };
  }
  try {
    const response = await fetch(`${workerUrl}/payment/config`);
    if (!response.ok) {
      throw new Error(`Failed to load payment config (${response.status})`);
    }
    return await response.json();
  } catch (err: any) {
    return {
      gpayEnabled: false,
      status: 'SETUP_PENDING',
      merchantName: 'VibeKart',
      merchantVpa: null,
      merchantMcc: '5399',
      environment: 'TEST',
      message: err?.message || 'Payment service unreachable.',
    };
  }
}

export async function fetchSellerOrderPrivateData(orderId: string): Promise<{
  costTotal?: number;
  profitTotal?: number;
  items?: Array<{ productId: string; unitCost?: number; sourceUrl?: string; sourceCode?: string }>;
} | null> {
  const database = requireDb();
  try {
    const snap = await getDoc(doc(database, ORDERS_COLLECTION, orderId, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID));
    return snap.exists() ? (snap.data() as any) : null;
  } catch {
    return null;
  }
}

export function subscribeToOrders(
  onChange: (orders: Order[]) => void,
  onError?: (error: Error) => void,
  uidFilter?: string,
) {
  const database = requireDb();
  const constraints = uidFilter
    ? [where('customerUid', '==', uidFilter)]
    : [orderBy('createdAt', 'desc')];
  const q = query(collection(database, ORDERS_COLLECTION), ...constraints);
  return onSnapshot(
    q,
    (snapshot) => {
      const orders = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }) as Order & { customerUid?: string; createdAt?: string })
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      onChange(orders);
    },
    (error) => onError?.(error as Error),
  );
}

export async function updateOrderStatusRemote(id: string, status: Order['status']): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, ORDERS_COLLECTION, id), { status });
}

export async function setOrderTrackingId(id: string, trackingId: string): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, ORDERS_COLLECTION, id), { trackingId });
}

// ---------------- Categories ----------------

export function subscribeToCategories(
  onChange: (categories: CategoryItem[]) => void,
  onError?: (error: Error) => void,
) {
  const database = requireDb();
  const q = query(collection(database, CATEGORIES_COLLECTION));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name ?? '',
          slug: data.slug ?? '',
          icon: data.icon,
          enabled: data.enabled ?? true,
          createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? (typeof data.createdAt === 'string' ? data.createdAt : undefined),
          updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? (typeof data.updatedAt === 'string' ? data.updatedAt : undefined),
        } as CategoryItem;
      });
      onChange(items);
    },
    (error) => onError?.(error as Error),
  );
}

export async function fetchCategoriesRemote(): Promise<CategoryItem[]> {
  const database = requireDb();
  const snapshot = await getDocs(query(collection(database, CATEGORIES_COLLECTION)));
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name ?? '',
      slug: data.slug ?? '',
      icon: data.icon,
      enabled: data.enabled ?? true,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? (typeof data.createdAt === 'string' ? data.createdAt : undefined),
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? (typeof data.updatedAt === 'string' ? data.updatedAt : undefined),
    } as CategoryItem;
  });
}

export async function createCategoryRemote(input: {
  id?: string;
  name: string;
  slug: string;
  icon?: string;
  enabled?: boolean;
}): Promise<string> {
  const database = requireDb();
  const payload = {
    name: input.name.trim(),
    slug: input.slug,
    icon: input.icon || 'tag',
    enabled: input.enabled ?? true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (input.id) {
    await setDoc(doc(database, CATEGORIES_COLLECTION, input.id), payload);
    return input.id;
  }
  const ref = await addDoc(collection(database, CATEGORIES_COLLECTION), payload);
  return ref.id;
}

export async function updateCategoryRemote(
  id: string,
  patch: Partial<Omit<CategoryItem, 'id'>>,
): Promise<void> {
  const database = requireDb();
  const payload: Record<string, unknown> = {
    ...patch,
    updatedAt: serverTimestamp(),
  };
  if (patch.name !== undefined) {
    payload.name = patch.name.trim();
  }
  await updateDoc(doc(database, CATEGORIES_COLLECTION, id), payload);
}

export async function removeCategoryRemote(id: string): Promise<void> {
  const database = requireDb();
  await deleteDoc(doc(database, CATEGORIES_COLLECTION, id));
}

// ---------------- Admin: Users & Sellers ----------------

export async function fetchUsersRemote(): Promise<UserProfile[]> {
  const database = requireDb();
  const snapshot = await getDocs(query(collection(database, USERS_COLLECTION)));
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email ?? '',
      name: data.name ?? 'Anonymous User',
      phone: data.phone,
      role: (data.role ?? 'customer') as UserRole,
      status: (data.status ?? 'active') as 'active' | 'suspended',
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
    };
  });
}

export async function updateUserRoleRemote(uid: string, role: UserRole): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, USERS_COLLECTION, uid), {
    role,
    updatedAt: serverTimestamp(),
  });
}

export async function updateUserStatusRemote(uid: string, status: 'active' | 'suspended'): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, USERS_COLLECTION, uid), {
    status,
    updatedAt: serverTimestamp(),
  });
}

// ---------------- Admin: Store Settings ----------------

export async function fetchStoreSettingsRemote(): Promise<StoreSettings> {
  const database = requireDb();
  try {
    const snap = await getDoc(doc(database, SETTINGS_COLLECTION, SETTINGS_DOC_ID));
    if (snap.exists()) {
      return { ...defaultStoreSettings, ...snap.data() } as StoreSettings;
    }
  } catch (err) {
    console.warn('[firestore] fetchStoreSettingsRemote fallback to default', err);
  }
  return defaultStoreSettings;
}

export async function updateStoreSettingsRemote(settings: Partial<StoreSettings>): Promise<void> {
  const database = requireDb();
  await setDoc(
    doc(database, SETTINGS_COLLECTION, SETTINGS_DOC_ID),
    {
      ...settings,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// ---------------- Admin: Payment Settings ----------------

export async function fetchPaymentSettingsRemote(): Promise<PaymentSettings> {
  const database = requireDb();
  try {
    const snap = await getDoc(doc(database, SETTINGS_COLLECTION, PAYMENT_SETTINGS_DOC_ID));
    if (snap.exists()) {
      const data = snap.data();
      const rawUpdated = data.updatedAt;
      const updatedAtStr =
        rawUpdated && typeof rawUpdated === 'object' && 'toDate' in rawUpdated && typeof rawUpdated.toDate === 'function'
          ? rawUpdated.toDate().toISOString()
          : typeof rawUpdated === 'string'
          ? rawUpdated
          : undefined;
      return { ...defaultPaymentSettings, ...data, updatedAt: updatedAtStr } as PaymentSettings;
    }
  } catch (err) {
    console.warn('[firestore] fetchPaymentSettingsRemote fallback to default', err);
  }
  return defaultPaymentSettings;
}

export async function updatePaymentSettingsRemote(settings: Partial<PaymentSettings>): Promise<void> {
  const database = requireDb();
  await setDoc(
    doc(database, SETTINGS_COLLECTION, PAYMENT_SETTINGS_DOC_ID),
    {
      ...settings,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// ---------------- Admin: Audit Logs ----------------

export async function fetchAuditLogsRemote(): Promise<AdminAuditLog[]> {
  const database = requireDb();
  try {
    const q = query(collection(database, AUDIT_LOGS_COLLECTION), orderBy('timestamp', 'desc'), limit(50));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : (data.timestamp ?? new Date().toISOString()),
        adminEmail: data.adminEmail ?? 'admin',
        adminUid: data.adminUid ?? '',
        action: data.action ?? 'Action',
        targetId: data.targetId,
        details: data.details ?? '',
      };
    });
  } catch (err) {
    console.warn('[firestore] fetchAuditLogsRemote failed', err);
    return [];
  }
}

export async function createAuditLogRemote(
  log: Omit<AdminAuditLog, 'id' | 'timestamp'>,
): Promise<string> {
  const database = requireDb();
  try {
    const ref = await addDoc(collection(database, AUDIT_LOGS_COLLECTION), {
      ...log,
      timestamp: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.warn('[firestore] createAuditLogRemote failed', err);
    return `local-${Date.now()}`;
  }
}

function getPaymentWorkerUrl(): string {
  const workerUrl = process.env.EXPO_PUBLIC_OTP_WORKER_URL?.replace(/\/+$/, '');
  if (!workerUrl) throw new Error('EXPO_PUBLIC_OTP_WORKER_URL is not configured.');
  return workerUrl;
}

async function postPaymentWorker<T>(path: string, input: unknown): Promise<T> {
  const currentUser = auth?.currentUser;
  if (!currentUser) throw new Error('You must be signed in to use payment features.');
  const idToken = await currentUser.getIdToken();
  const response = await fetch(`${getPaymentWorkerUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) throw new Error(payload?.error || `Payment request failed (${response.status}).`);
  if (!payload) throw new Error('Payment service returned an empty response.');
  return payload;
}

export async function createPaymentAttemptViaWorker(input: {
  items: Array<{ productId: string; quantity: number; option?: string }>;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  paymentMethod: 'UPI';
  idempotencyKey: string;
}): Promise<PaymentAttempt> {
  const response = await postPaymentWorker<{ success: boolean; attempt?: PaymentAttempt }>(
    '/payment-attempts/create',
    input,
  );
  if (!response.success || !response.attempt) throw new Error('Payment attempt was not created.');
  return response.attempt;
}

export async function submitPaymentDetailsViaWorker(input: {
  attemptId: string;
  customerUtr: string;
}): Promise<void> {
  const response = await postPaymentWorker<{ success: boolean; message?: string }>(
    '/payment-attempts/submit',
    input,
  );
  if (!response.success) throw new Error(response.message || 'Payment details were not submitted.');
}

export async function confirmPaymentAttemptViaWorker(attemptId: string): Promise<void> {
  const response = await postPaymentWorker<{ success: boolean; orderId?: string }>(
    '/admin/payment-attempts/confirm',
    { attemptId, actualCreditConfirmed: true },
  );
  if (!response.success || !response.orderId) throw new Error('Payment could not be confirmed.');
}

export async function reviewPaymentAttemptViaWorker(
  action: 'reject' | 'cancel' | 'expire',
  attemptId: string,
  reason: string,
): Promise<void> {
  const response = await postPaymentWorker<{ success: boolean }>(
    `/admin/payment-attempts/${action}`,
    { attemptId, reason, adminReviewed: true },
  );
  if (!response.success) throw new Error('Payment attempt could not be updated.');
}

export async function confirmLegacyOrderPaymentViaWorker(
  orderId: string,
  customerUtr: string,
): Promise<void> {
  const response = await postPaymentWorker<{ success: boolean }>(
    '/admin/legacy-orders/confirm-payment',
    { orderId, customerUtr, actualCreditConfirmed: true },
  );
  if (!response.success) throw new Error('Legacy order payment could not be confirmed.');
}

export async function rejectLegacyOrderPaymentViaWorker(
  orderId: string,
  reason: string,
): Promise<void> {
  const response = await postPaymentWorker<{ success: boolean }>(
    '/admin/legacy-orders/reject-payment',
    { orderId, reason, adminReviewed: true },
  );
  if (!response.success) throw new Error('Legacy order payment could not be rejected.');
}

export function subscribeToPaymentAttempts(
  onChange: (attempts: PaymentAttempt[]) => void,
  onError?: (error: Error) => void,
  uidFilter?: string,
) {
  const database = requireDb();
  const constraints = uidFilter ? [where('customerUid', '==', uidFilter)] : [];
  const q = query(collection(database, 'payment_attempts'), ...constraints);
  return onSnapshot(
    q,
    (snapshot) => {
      const attempts = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }) as PaymentAttempt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onChange(attempts);
    },
    (error) => onError?.(error as Error),
  );
}
