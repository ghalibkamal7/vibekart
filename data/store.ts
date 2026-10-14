import { ImageSourcePropType } from 'react-native';

export type Category = 'All' | 'Home' | 'Style' | 'Beauty' | 'Wellness' | (string & {});

export type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export const defaultCategoryItems: CategoryItem[] = [
  { id: 'home', name: 'Home', slug: 'home', icon: 'home', enabled: true },
  { id: 'style', name: 'Style', slug: 'style', icon: 'shopping-bag', enabled: true },
  { id: 'beauty', name: 'Beauty', slug: 'beauty', icon: 'sun', enabled: true },
  { id: 'wellness', name: 'Wellness', slug: 'wellness', icon: 'heart', enabled: true },
];

export function normalizeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isDuplicateCategoryName(
  name: string,
  categoryList: CategoryItem[],
  excludeId?: string,
): boolean {
  const trimmed = name.trim().toLowerCase();
  const slug = normalizeSlug(name);
  return categoryList.some((c) => {
    if (excludeId && c.id === excludeId) return false;
    return c.name.trim().toLowerCase() === trimmed || c.slug === slug;
  });
}

export function validateCategoryName(
  name: string,
  categoryList: CategoryItem[],
  excludeId?: string,
): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: 'Category name cannot be empty.' };
  }
  if (trimmed.length > 30) {
    return { valid: false, error: 'Category name cannot exceed 30 characters.' };
  }
  if (trimmed.toLowerCase() === 'all') {
    return { valid: false, error: '"All" is reserved for viewing all products.' };
  }
  if (isDuplicateCategoryName(trimmed, categoryList, excludeId)) {
    return { valid: false, error: 'A category with this name already exists.' };
  }
  return { valid: true };
}

export function productMatchesCategory(
  productCategory: string | undefined,
  category: CategoryItem | string,
): boolean {
  if (!productCategory) return false;
  const prodCat = productCategory.trim().toLowerCase();
  if (typeof category === 'string') {
    if (category.toLowerCase() === 'all') return true;
    const target = category.trim().toLowerCase();
    return prodCat === target;
  }
  return (
    prodCat === category.id.toLowerCase() ||
    prodCat === category.slug.toLowerCase() ||
    prodCat === category.name.trim().toLowerCase()
  );
}

export function getCategoryDisplayName(
  productCategory: string | undefined,
  categoryList: CategoryItem[],
): string {
  if (!productCategory) return 'General';
  const found = categoryList.find((c) => productMatchesCategory(productCategory, c));
  return found ? found.name : productCategory;
}

export function getAssignedProductCount(
  category: CategoryItem,
  productList: Pick<Product, 'category'>[],
): number {
  return productList.filter((p) => productMatchesCategory(p.category, category)).length;
}

export type MarkupType = 'fixed' | 'percent' | 'manual';

/**
 * Product = ek "catalogue item" jo humne kisi supplier (jaise Meesho) se socure
 * kiya hai. `baseCost` aur `sourceUrl` / `sourceCode` seller/admin ke liye hote
 * hain — customer-facing screens me kabhi bhi ye fields render nahi karte,
 * sirf computed `price` dikhate hain.
 */
export type Product = {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  image: ImageSourcePropType; // legacy single-image field (local demo mode, older products)
  imageUrls?: string[]; // Cloudinary URLs, ordered — imageUrls[0] is the primary image
  imagePublicIds?: string[]; // parallel array of Cloudinary public IDs, for deletion
  rating: number;
  reviews: number;
  colors: string[];
  sizes?: string[];
  isNew?: boolean;
  featured?: boolean;
  enabled?: boolean; // defaults to true; if false, hidden from customer catalogue
  inStock: boolean;

  // --- Seller / admin-only fields (never render these on customer screens) ---
  baseCost: number; // Meesho / supplier cost price
  markupType: MarkupType; // 'fixed' -> +₹, 'percent' -> +%, 'manual' -> direct price
  markupValue: number;
  manualPrice?: number; // target sell price when markupType is 'manual'
  sourceUrl?: string; // supplier product link, for manual fulfilment reference
  sourceCode?: string; // supplier product/SKU code

  // --- Customer-facing computed field ---
  price: number; // = computeDisplayPrice(baseCost, markupType, markupValue, manualPrice)
  originalPrice?: number; // optional strike-through price, admin sets manually
};

export type OrderStatus = 'Placed' | 'Confirmed' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';

export const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  Placed: ['Confirmed', 'Processing', 'Cancelled'],
  Confirmed: ['Processing', 'Cancelled'],
  Processing: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

export function canTransitionOrderStatus(current: OrderStatus, next: OrderStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[current]?.includes(next) ?? false;
}

export function canCancelOrder(status: OrderStatus): boolean {
  return status === 'Placed' || status === 'Confirmed';
}

export type OrderItem = {
  productId: string;
  name: string;
  option?: string;
  quantity: number;
  unitPrice: number; // customer paid this, per unit
  unitCost?: number; // admin-only, supplier cost per unit at order time (stored in orders/{id}/private/data)
  sourceUrl?: string; // admin-only, for manual "place this on Meesho" step
};

export type Order = {
  id: string;
  items: OrderItem[];
  total: number; // revenue collected from customer
  costTotal?: number; // admin-only: total supplier cost (stored in orders/{id}/private/data)
  profitTotal?: number; // admin-only: total - costTotal
  status: OrderStatus;
  date: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  paymentMethod: 'UPI' | 'COD';
  paymentStatus?: 'Selected' | 'Pending' | 'Paid';
  trackingId?: string;
  costReconciled?: boolean;
};

/** Seller ka pricing-engine: cost + margin/markup = customer ko dikhne wala price. */
export function computeDisplayPrice(
  baseCost: number,
  markupType: MarkupType = 'fixed',
  markupValue: number = 0,
  manualPrice?: number,
): number {
  if (markupType === 'manual') {
    const candidate = manualPrice !== undefined ? manualPrice : markupValue;
    const valid = Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
    return Math.max(0, Math.round(valid));
  }
  const safeMarkup = Number.isFinite(markupValue) ? markupValue : 0;
  const raw =
    markupType === 'percent'
      ? baseCost + (baseCost * safeMarkup) / 100
      : baseCost + safeMarkup;
  return Math.max(0, Math.round(raw));
}

export function computeMargin(product: Pick<Product, 'baseCost' | 'price'>): number {
  return product.price - product.baseCost;
}

export const defaultProducts: Product[] = (
  [
    {
      id: 'terra-lamp',
      name: 'Terra Glow Lamp',
      subtitle: 'Warm light, slow evenings',
      baseCost: 950,
      markupType: 'fixed' as MarkupType,
      markupValue: 549,
      originalPrice: 1999,
      category: 'Home',
      image: require('../assets/images/lamp.jpg'),
      rating: 4.8,
      reviews: 128,
      colors: ['Clay', 'Sand'],
      isNew: true,
      featured: true,
      enabled: true,
      inStock: true,
      sourceUrl: 'https://www.meesho.com/s/p/terra-glow-lamp',
      sourceCode: 'MSH-LAMP-001',
      description:
        'A sculptural accent lamp with a soft, ambient glow. Designed to turn a quiet corner into your favourite corner.',
    },
    {
      id: 'sage-overshirt',
      name: 'Sage Everyday Overshirt',
      subtitle: 'The layer you reach for',
      baseCost: 780,
      markupType: 'percent' as MarkupType,
      markupValue: 40,
      originalPrice: 1699,
      category: 'Style',
      image: require('../assets/images/overshirt.jpg'),
      rating: 4.7,
      reviews: 94,
      colors: ['Sage', 'Oat'],
      sizes: ['S', 'M', 'L', 'XL'],
      isNew: false,
      featured: false,
      enabled: true,
      inStock: true,
      sourceUrl: 'https://www.meesho.com/s/p/sage-everyday-overshirt',
      sourceCode: 'MSH-SHIRT-014',
      description:
        'A relaxed cotton overshirt cut for everyday movement. Easy over a tee, polished enough for plans.',
    },
    {
      id: 'cloud-mist',
      name: 'Cloud Mist Face Serum',
      subtitle: 'Dewy skin, no drama',
      baseCost: 520,
      markupType: 'fixed' as MarkupType,
      markupValue: 379,
      originalPrice: 1199,
      category: 'Beauty',
      image: require('../assets/images/lamp.jpg'),
      rating: 4.9,
      reviews: 203,
      colors: ['30 ml'],
      isNew: true,
      featured: false,
      enabled: true,
      inStock: true,
      sourceUrl: 'https://www.meesho.com/s/p/cloud-mist-face-serum',
      sourceCode: 'MSH-BEAUTY-088',
      description:
        'A light, hydrating serum with a fresh finish. Built for the five-minute ritual that makes the whole day feel better.',
    },
    {
      id: 'linen-carryall',
      name: 'Linen Daily Carryall',
      subtitle: 'Room for the little things',
      baseCost: 480,
      markupType: 'percent' as MarkupType,
      markupValue: 35,
      category: 'Style',
      image: require('../assets/images/overshirt.jpg'),
      rating: 4.6,
      reviews: 67,
      colors: ['Olive', 'Natural'],
      isNew: false,
      featured: false,
      enabled: true,
      inStock: true,
      sourceUrl: 'https://www.meesho.com/s/p/linen-daily-carryall',
      sourceCode: 'MSH-BAG-042',
      description:
        'A structured everyday tote with a roomy interior and an easy shoulder drop. Light enough for all-day carry.',
    },
    {
      id: 'pause-tea-set',
      name: 'Pause Tea Set',
      subtitle: 'Pour something lovely',
      baseCost: 650,
      markupType: 'fixed' as MarkupType,
      markupValue: 449,
      originalPrice: 1399,
      category: 'Wellness',
      image: require('../assets/images/lamp.jpg'),
      rating: 4.8,
      reviews: 51,
      colors: ['Dune'],
      isNew: false,
      featured: true,
      enabled: true,
      inStock: true,
      sourceUrl: 'https://www.meesho.com/s/p/pause-tea-set',
      sourceCode: 'MSH-HOME-233',
      description:
        'A two-cup ceramic set for slow mornings and good conversations. Hand-finished with a soft, tactile glaze.',
    },
    {
      id: 'soft-knit-throw',
      name: 'Soft Knit Throw',
      subtitle: 'A little more comfort',
      baseCost: 890,
      markupType: 'percent' as MarkupType,
      markupValue: 30,
      category: 'Home',
      image: require('../assets/images/overshirt.jpg'),
      rating: 4.7,
      reviews: 39,
      colors: ['Moss', 'Cream'],
      isNew: false,
      featured: false,
      enabled: true,
      inStock: false,
      sourceUrl: 'https://www.meesho.com/s/p/soft-knit-throw',
      sourceCode: 'MSH-HOME-091',
      description:
        'A breathable knit layer for sofa naps, balcony sunsets, and every in-between moment.',
    },
  ] as Omit<Product, 'price'>[]
).map((product) => ({
  ...product,
  price: computeDisplayPrice(product.baseCost, product.markupType, product.markupValue, product.manualPrice),
}));

/**
 * The single place every screen goes through to get a product's images.
 * Prefers the new multi-image `imageUrls`; falls back to the legacy single
 * `image` field so older products (created before multi-image support, or
 * local demo-mode products using a bundled asset) keep displaying correctly.
 * Returns an empty array only when a product genuinely has no image at all —
 * callers should render a placeholder in that case, never a broken icon.
 */
export function getProductImages(product: Pick<Product, 'image' | 'imageUrls'>): ImageSourcePropType[] {
  if (product.imageUrls?.length) return product.imageUrls.map((uri) => ({ uri }));
  if (product.image) return [product.image];
  return [];
}

export type NewProductInput = {
  name: string;
  subtitle: string;
  description: string;
  category: string;
  baseCost: number;
  markupType: MarkupType;
  markupValue: number;
  manualPrice?: number;
  originalPrice?: number;
  colors: string[];
  sizes?: string[];
  sourceUrl?: string;
  sourceCode?: string;
  image?: ImageSourcePropType;
  imageUrls?: string[];
  imagePublicIds?: string[];
  inStock?: boolean;
  enabled?: boolean;
  featured?: boolean;
  isNew?: boolean;
};

export const categories: { label: Category; icon: string }[] = [
  { label: 'All', icon: 'grid' },
  { label: 'Home', icon: 'home' },
  { label: 'Style', icon: 'shopping-bag' },
  { label: 'Beauty', icon: 'sun' },
  { label: 'Wellness', icon: 'heart' },
];

export const formatPrice = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

export type StoreSettings = {
  storeName: string;
  supportEmail: string;
  supportPhone?: string;
  announcement: string;
  announcementActive: boolean;
  maintenanceMode: boolean;
  freeDeliveryThreshold?: number;
};

export const defaultStoreSettings: StoreSettings = {
  storeName: 'VibeKart',
  supportEmail: 'support@vibekart.in',
  supportPhone: '+91 98765 43210',
  announcement: 'Welcome to VibeKart — Handpicked, honest aesthetic picks for your space.',
  announcementActive: true,
  maintenanceMode: false,
  freeDeliveryThreshold: 499,
};

export type AdminAuditLog = {
  id: string;
  timestamp: string;
  adminEmail: string;
  adminUid: string;
  action: string;
  targetId?: string;
  details: string;
};
