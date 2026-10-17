# VibeKart

A mobile-first reseller storefront — source products (e.g. from Meesho), set your own
markup, and sell at a transparent custom price. Customers only ever see your final
price; supplier cost stays private to the seller.

Standalone Expo project. No Replit dependency of any kind.

## Stack

- **App**: Expo + Expo Router, React Native, TypeScript
- **Backend**: Firebase (Auth, Firestore — Spark/free plan) + Cloudflare Worker
  (image upload/cleanup and trusted order APIs) + Cloudinary. One optional
  Cloud Function (`reconcileOrderCost`) needs the Blaze plan and isn't required
  for the app to run.

## Local setup

```bash
npm install
cp .env.example .env      # fill in your Firebase project's config (see below)
npm start                 # then press i / a / w, or scan the QR with Expo Go
```

Without a `.env`, the app still runs in **local demo mode**: guest browsing only,
data kept on-device (AsyncStorage), no seller-panel writes reach a server. This is
useful for UI work without a Firebase project set up yet.

## Firebase project setup

1. Create a project at https://console.firebase.google.com
2. Add a **Web app** to the project (even though this is a mobile app — the Firebase
   JS SDK used here connects the same way for web and React Native) and copy its
   config into `.env` (see `.env.example` for the exact variable names).
3. Enable **Authentication → Email/Password**.
4. Create a **Firestore** database (production mode).
5. Create a [Cloudinary](https://cloudinary.com) account and configure its API
   credentials as **Cloudflare Worker secrets** — see "Product images
   (Cloudinary)" below. Do not add Cloudinary credentials or upload presets to
   Expo variables.
6. Configure and deploy the **Cloudflare Worker** — see `workers/otp/README.md`
   for the full walkthrough (Cloudflare account, KV namespace, secrets, deploy).
   Copy the Worker's URL into `.env` as `EXPO_PUBLIC_OTP_WORKER_URL`. The
   Worker is required for product deletion and customer product requests. The
   Worker authenticates customers, validates delivery details and quantities,
   re-reads product availability and catalogue prices, and creates requests
   without payment fields. It also restricts request-status changes to active
   administrators.
7. Review and deploy the Firestore rules (works on Spark, no Blaze needed):
```bash
   npm install -g firebase-tools     # once
   firebase login
   firebase use --add                # pick your project
   firebase deploy --only firestore:rules
```
   The current rules deny all client-side order creation and restrict customer
   order reads to that customer's own records. The authenticated Worker creates
   requests and administers request status transitions; no rule changes are
   required. Payment review rules remain in place for historical/retained
   payment flows. Deploying rules is not part of this repository change.
8. **Important — this project intentionally stays on Firebase's free Spark
   plan.** Cloud Functions of any kind (secrets or not) require the Blaze
   (pay-as-you-go) plan to deploy at all. `functions/index.js` now contains
   only `reconcileOrderCost` (automatic order profit calculation). Current
   product requests do not represent sales or revenue and are not included in
   paid-order analytics.
   Unless you enable Blaze, skip `firebase deploy --only functions` entirely.
9. **Create your first seller account.** Sign up once from the app (email
   creates a normal `customer`-role account), then in the Firebase
   console open **Firestore → users → `<that uid>`** and change `role` from
   `customer` to `seller`. This has to be a manual step — the security rules
   deliberately never let a client set its own role to `seller` (see
   `firestore.rules`), so nobody can just grant themselves seller access from the
   app.

## Customer product-request workflow

Checkout collects the customer's name, Indian mobile number, house/building,
road/area/colony, six-digit pincode, city, state, and requested products and
quantities. The authenticated Worker validates the request, checks each product
against current Firestore availability, snapshots the catalogue price, and
stores it in the existing `orders` collection with status `New`. Requests have
no payment method, payment status, UTR, or payment-reference fields; the
catalogue value is informational and is not an amount charged or paid.

An active administrator manually places any corresponding order in the Meesho
app, then records progress as `Ordered on Meesho`, `Shipped`, `Delivered`, or
`Cancelled` in the admin panel. VibeKart does not call a Meesho API and does not
place orders automatically. Customers can read only their own requests. The
Worker writes status changes and their audit records atomically.

The previous UPI checkout, QR, payment-attempt, and payment-review
implementations remain in the repository for possible future reactivation, but
the current customer shopping/checkout/order UI does not expose payment
choices, QR codes, payment instructions, or UTR submission. Historical payment
records and payment verification protections are preserved.

The Firestore rule tests run against the local emulator (no production
credentials or data):

```bash
npx firebase-tools emulators:exec --only firestore \
  --project demo-vibekart-manual-upi --config firebase.json \
  'npm run test:rules'
```

## Legacy delivery and order changes

Customer product requests start in `New` and are advanced by an administrator
after the corresponding manual Meesho step is completed. Existing paid orders
retain their historical delivery and cancellation behavior.

Customers can request cancellation while a paid order is Placed or Confirmed.
Authorized staff can cancel a paid order before it is shipped. Cancellation
does not itself issue a refund; any refund must be handled and confirmed
separately.

## Reviews and ratings

The app does not currently have a verified customer-review system. Seed/demo
rating values are not shown as customer feedback, and new products do not
receive placeholder ratings. Existing stored fields and historical orders are
preserved.

## Phone OTP status

Phone OTP is currently unavailable and reserved for future use. Both Worker
routes (`/send-otp` and `/verify-otp`) return the same unavailable response
without sending SMS or creating a Firebase session. The MSG91 integration and
client helpers remain in the repository for possible future reactivation, but
MSG91 is not called by any active user-facing flow and no MSG91 configuration
is required for current functionality. Current sign-in methods are Google and
email/password; guest browsing remains available. See `workers/otp/README.md`
for the future-only OTP implementation notes.

## Product images (Cloudinary)

Firebase Storage is not used. Image bytes are sent to the authenticated
Cloudflare Worker, which verifies Firebase identity and role, generates a
unique Cloudinary public ID, signs the upload with its server-only API secret,
and registers the asset's owner and product/QR target in Firestore. The client
receives the secure URL and registered public ID; it never receives Cloudinary
API credentials or calls Cloudinary's upload API directly. The Worker accepts
JPEG, PNG, WebP, or AVIF images up to 10 MB.

### Local Worker configuration

1. Copy `workers/otp/.dev.vars.example` to `workers/otp/.dev.vars`.
2. Add the local Firebase service-account JSON and Cloudinary values to that
   local-only file. MSG91 settings are future-only and are not needed for
   current Worker functionality. The checked-in example contains blank values
   only.
3. `.dev.vars` and its variants are ignored by Git. Keep the file on this
   machine; never paste values into `.env`, `EXPO_PUBLIC_*`, or source control.
4. Set `EXPO_PUBLIC_OTP_WORKER_URL` in the app's `.env` to the local Worker
   address when using `wrangler dev`. The app authenticates Worker requests
   with the signed-in Firebase user's ID token.

### Cloudinary account and Worker setup

1. In Cloudinary Console, open **Dashboard** and note the cloud name.
2. Open **Settings → API Keys** (or the account's API key management page) and
   use the API key and API secret for the account that owns VibeKart images.
   Rotate the API secret if it has ever been exposed in a client bundle.
3. For local development, configure `CLOUDINARY_CLOUD_NAME`,
   `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in
   `workers/otp/.dev.vars`.
4. For production, open **Cloudflare Dashboard → Workers & Pages →
   vibekart-otp → Settings → Variables and Secrets**. Add these exact names as
   Worker secrets: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
   `CLOUDINARY_API_SECRET`, and `FIREBASE_SERVICE_ACCOUNT_JSON`. MSG91 is
   future-only and must not be configured for current functionality. Never
   paste secret values into the repository, build logs, or Expo configuration.
5. `workers/otp/wrangler.toml` schedules cleanup retries every 15 minutes. The
   schedule becomes active only when the updated Worker is deployed.

The app no longer uses `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME`,
`EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`, or unsigned presets. After all deployed
client versions using direct unsigned uploads have been retired, verify the old
preset under **Cloudinary Console → Settings → Upload → Upload presets** and
disable or delete it if it is no longer needed. Do not disable it while an
older client still depends on it.

An unsigned preset is not authentication: anyone who knows the Cloudinary
cloud name and preset name can attempt uploads. Until the old preset is
disabled, inspect its **Signing Mode**, **Folder**, **Allowed formats**,
**Resource type**, **Maximum file size**, **Maximum image dimensions**,
**Unique filename**, and whether client-set `public_id`/overwrite behavior is
allowed. Restrict it to image uploads in the intended folder, JPEG/PNG/WebP,
reasonable size and dimensions, unique filenames, and no client-controlled IDs
or overwrite if those controls are available. These are only damage limits;
they do not replace the Firebase-authenticated Worker architecture.

### Ownership and cleanup

Product uploads require an active seller/admin and an existing product;
payment-QR uploads require an administrator. A Worker-only
`cloudinary_assets` record binds each server-generated public ID to its exact
asset type and target. Firestore rules deny client writes to these records and
to product image metadata/payment QR metadata. The Worker checks this binding
before attaching or deleting an asset; it does not trust a client-supplied
public-ID prefix.

Product image metadata is updated through the Worker. The metadata change and
durable cleanup job are committed together; cleanup deletes an image only after
the Firestore target no longer references it. Product deletion removes the
Firestore records and creates the same cleanup job atomically. Replacing or
clearing a payment QR follows the same pattern. If Cloudinary is unavailable,
cleanup remains queued for retry, and the scheduled Worker trigger retries it.
The app reports whether cleanup is pending; images still referenced by
Firestore are not intentionally removed.

Existing images and QR codes continue to render from stored URLs. Older public
IDs created before Worker ownership records cannot be proven safe from
repository data alone. The Worker fails closed when a legacy ID would be
removed or deleted. Those assets require a reviewed, trusted migration that
checks the Cloudinary inventory and associates each asset with its actual
product/QR target before cleanup. Do not bulk-register client-supplied IDs or
rely only on a folder prefix.

## Why a customer can never see supplier cost

Firestore security rules can only allow or deny reading a whole document — they
can't hide one field of a document a user is otherwise allowed to read. So instead
of one `products/{id}` document with a cost field customers are asked nicely not to
render, cost lives in a **separate** sub-document:

`firestore.rules` denies all read/write access to `private/data` unless the
signed-in user's own profile has `role == 'seller'`. A customer's client genuinely
cannot fetch that document, no matter what the app code does.

The same reasoning applies to order profit: a customer's client can never read
`baseCost`, so it can't compute a trustworthy `costTotal`/`profitTotal`. The
optional `reconcileOrderCost` Cloud Function can read private costs and write
them to the seller-only order fields. Without that function or another trusted
reconciliation process, historical paid orders may not have a cost/profit
snapshot. Product requests are deliberately excluded from paid-order
reconciliation and analytics.

## Project structure

## Known limitations / follow-ups

- **`reconcileOrderCost` needs the Blaze plan to deploy at all.** Without it or
  another trusted reconciliation process, some historical paid orders may not
  receive supplier-cost/profit snapshots. Customer requests are excluded from
  reconciliation and paid-order analytics.
- **Payment flows are retained but not customer-facing.** Historical manual-UPI
  payment review still uses the Worker, which validates stored price snapshots
  and atomically records payment transitions, reference claims, and reviewer
  audits. Customer-submitted UTRs are not proof of payment; actual
  merchant-account credit must be verified by an administrator. Firestore
  rules continue to deny direct client payment-status and reference-claim writes.
- **The Worker is a separate deployable** from the Firebase project — it has
  its own `wrangler deploy` and secrets (`workers/otp/README.md`). Phone OTP
  is currently disabled; MSG91 code and configuration are future-only.
- **Legacy Cloudinary images require migration before deletion.** Existing URLs
  continue to render, but assets without a trusted Worker ownership record
  cannot be safely removed during edits or product deletion. See "Product
  images (Cloudinary)" for the required inventory review and migration.
- **Meesho product import is manual, not scraped.** The seller "Add product" form
  lets you paste a Meesho URL for your own reference, but does not auto-fetch
  title/price/images from it — see the note in `app/seller-add-product.tsx` for why
  (Meesho's ToS and page-structure fragility).
- **Sequential image uploads.** Multiple images for one product upload one at a
  time (with per-image progress and retry), not in parallel — simpler failure
  handling at the cost of some speed on slow connections.
- **Cart and favourites stay on-device** (not synced to the cloud) even in cloud
  mode — this was a deliberate scope cut, not an oversight.