import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  DocumentData,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  CategoryItem,
  computeDisplayPrice,
  NewProductInput,
  Order,
  OrderStatus,
  Product,
} from '@/data/store';
import { auth, db } from './config';

const PRODUCTS_COLLECTION = 'products';
const CATEGORIES_COLLECTION = 'categories';
const ORDERS_COLLECTION = 'orders';
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
// A customer can create an order and read only their own (uid == request
// customerUid); only role == 'seller' can read every order, update status,
// or set trackingId. costTotal/profitTotal/item.unitCost stay out of every
// screen customers see, but — unlike products — they live on the same
// order doc the customer owns, so a customer inspecting raw network traffic
// could technically see them. That residual gap is called out in the
// migration report; closing it fully would need the same doc-split treatment
// applied to orders.

export type NewOrderInput = {
  customerUid: string;
  items: Order['items'];
  total: number;
  costTotal?: number;
  profitTotal?: number;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  paymentMethod: 'UPI' | 'COD';
  idempotencyKey?: string;
};

export async function createOrderViaWorker(input: {
  items: Array<{ productId: string; quantity: number; option?: string }>;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  paymentMethod: 'UPI' | 'COD';
  idempotencyKey?: string;
}): Promise<Order> {
  const workerUrl = process.env.EXPO_PUBLIC_OTP_WORKER_URL?.replace(/\/+$/, '');
  if (!workerUrl) {
    throw new Error(
      'EXPO_PUBLIC_OTP_WORKER_URL is not configured. Cloud order creation requires the secure pricing worker.',
    );
  }
  const currentUser = auth?.currentUser;
  if (!currentUser) {
    throw new Error('You must be signed in to place an order.');
  }
  const idToken = await currentUser.getIdToken();
  const response = await fetch(`${workerUrl}/create-order`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const resJson = (await response.json().catch(() => null)) as { success?: boolean; order?: Order; error?: string } | null;
  if (!response.ok || !resJson?.success || !resJson.order) {
    throw new Error(resJson?.error || `Order creation failed with status ${response.status}`);
  }
  return resJson.order;
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
  const q = query(collection(database, ORDERS_COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snapshot) => {
      let orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as Order & { customerUid?: string });
      if (uidFilter) orders = orders.filter((order) => order.customerUid === uidFilter);
      onChange(orders);
    },
    (error) => onError?.(error as Error),
  );
}

export async function createOrder(input: NewOrderInput): Promise<string> {
  const database = requireDb();
  const docRef = await addDoc(collection(database, ORDERS_COLLECTION), {
    customerUid: input.customerUid,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerAddress: input.customerAddress,
    paymentMethod: input.paymentMethod,
    paymentStatus: 'Selected',
    status: 'Placed' as OrderStatus,
    items: input.items.map((it) => ({
      productId: it.productId,
      name: it.name,
      option: it.option,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      itemTotal: it.unitPrice * it.quantity,
    })),
    total: input.total,
    costReconciled: true,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateOrderStatusRemote(id: string, status: OrderStatus): Promise<void> {
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
