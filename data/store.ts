import { ImageSourcePropType } from 'react-native';

export type Category = 'All' | 'Home' | 'Style' | 'Beauty' | 'Wellness';

export type MarkupType = 'fixed' | 'percent';

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
  category: Exclude<Category, 'All'>;
  image: ImageSourcePropType; // legacy single-image field (local demo mode, older products)
  imageUrls?: string[]; // Cloudinary URLs, ordered — imageUrls[0] is the primary image
  imagePublicIds?: string[]; // parallel array of Cloudinary public IDs, for deletion
  rating: number;
  reviews: number;
  colors: string[];
  sizes?: string[];
  isNew?: boolean;
  inStock: boolean;

  // --- Seller / admin-only fields (never render these on customer screens) ---
  baseCost: number; // Meesho / supplier cost price
  markupType: MarkupType; // 'fixed' -> +₹, 'percent' -> +%
  markupValue: number;
  sourceUrl?: string; // supplier product link, for manual fulfilment reference
  sourceCode?: string; // supplier product/SKU code

  // --- Customer-facing computed field ---
  price: number; // = computeDisplayPrice(baseCost, markupType, markupValue)
  originalPrice?: number; // optional strike-through price, admin sets manually
};

export type OrderStatus = 'Placed' | 'Processing' | 'Shipped' | 'Delivered';

export type OrderItem = {
  productId: string;
  name: string;
  option?: string;
  quantity: number;
  unitPrice: number; // customer paid this, per unit
  unitCost: number; // admin-only, supplier cost per unit at order time
  sourceUrl?: string; // admin-only, for manual "place this on Meesho" step
};

export type Order = {
  id: string;
  items: OrderItem[];
  total: number; // revenue collected from customer
  costTotal: number; // admin-only: total supplier cost
  profitTotal: number; // admin-only: total - costTotal
  status: OrderStatus;
  date: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  paymentMethod: 'UPI' | 'COD';
  trackingId?: string;
  costReconciled?: boolean; // cloud mode only — see functions/index.js
};

/** Seller ka pricing-engine: cost + margin/markup = customer ko dikhne wala price. */
export function computeDisplayPrice(
  baseCost: number,
  markupType: MarkupType,
  markupValue: number,
): number {
  const raw =
    markupType === 'percent' ? baseCost + (baseCost * markupValue) / 100 : baseCost + markupValue;
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
      inStock: false,
      sourceUrl: 'https://www.meesho.com/s/p/soft-knit-throw',
      sourceCode: 'MSH-HOME-091',
      description:
        'A breathable knit layer for sofa naps, balcony sunsets, and every in-between moment.',
    },
  ] as Omit<Product, 'price'>[]
).map((product) => ({
  ...product,
  price: computeDisplayPrice(product.baseCost, product.markupType, product.markupValue),
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
  category: Exclude<Category, 'All'>;
  baseCost: number;
  markupType: MarkupType;
  markupValue: number;
  originalPrice?: number;
  colors: string[];
  sizes?: string[];
  sourceUrl?: string;
  sourceCode?: string;
  image?: ImageSourcePropType;
  imageUrls?: string[];
  imagePublicIds?: string[];
};

export const categories: { label: Category; icon: string }[] = [
  { label: 'All', icon: 'grid' },
  { label: 'Home', icon: 'home' },
  { label: 'Style', icon: 'shopping-bag' },
  { label: 'Beauty', icon: 'sun' },
  { label: 'Wellness', icon: 'heart' },
];

export const formatPrice = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;
