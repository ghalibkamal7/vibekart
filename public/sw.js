/**
 * VibeKart Service Worker — PWA offline support and static asset caching.
 *
 * SAFETY RULES:
 * - Only cache static assets (JS bundles, CSS, images, fonts, icons).
 * - NEVER cache authenticated API responses, order data, payment requests,
 *   admin pages, or anything under /api/.
 * - NEVER cache Firebase Auth tokens or Firestore requests.
 * - Use stale-while-revalidate for static assets so users get fast loads
 *   but always receive updates within one reload.
 * - Show a graceful offline page when the network is unavailable.
 */

const CACHE_NAME = 'vibekart-v1';
const OFFLINE_URL = '/offline.html';

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Patterns that must NEVER be cached
const NEVER_CACHE_PATTERNS = [
  /firestore\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /cloudinary\.com\/v1_1/,       // upload requests
  /\/api\//,
  /workers\.dev/,                 // Cloudflare Worker endpoints
  /checkout/i,
  /payment/i,
];

// Patterns for cacheable static assets
const STATIC_ASSET_PATTERNS = [
  /\/_expo\/static\//,
  /\.js(\?|$)/,
  /\.css(\?|$)/,
  /\.woff2?(\?|$)/,
  /\.ttf(\?|$)/,
  /\.png(\?|$)/,
  /\.jpg(\?|$)/,
  /\.jpeg(\?|$)/,
  /\.svg(\?|$)/,
  /\.ico(\?|$)/,
  /\.webp(\?|$)/,
];

function shouldNeverCache(url) {
  return NEVER_CACHE_PATTERNS.some((pattern) => pattern.test(url));
}

function isStaticAsset(url) {
  return STATIC_ASSET_PATTERNS.some((pattern) => pattern.test(url));
}

// Install: pre-cache essential files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Pre-cache failed for some URLs (non-fatal):', err);
      });
    }),
  );
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
    }),
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// Fetch: network-first for navigation, stale-while-revalidate for static assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = request.url;

  // Never cache sensitive requests
  if (shouldNeverCache(url)) return;

  // Navigation requests (HTML pages)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(OFFLINE_URL) || caches.match('/');
      }),
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const networkFetch = fetch(request)
            .then((networkResponse) => {
              if (networkResponse.ok) {
                cache.put(request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => {
              // Network failed — return cached or nothing
              return cachedResponse;
            });

          // Return cached version immediately, update in background
          return cachedResponse || networkFetch;
        });
      }),
    );
    return;
  }

  // Everything else: network-only (no caching)
});
