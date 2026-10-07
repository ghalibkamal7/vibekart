# VibeKart

A mobile-first reseller storefront — source products (e.g. from Meesho), set your own
markup, and sell at a transparent custom price. Customers only ever see your final
price; supplier cost stays private to the seller.

Standalone Expo project. No Replit dependency of any kind.

## Stack

- **App**: Expo + Expo Router, React Native, TypeScript
- **Backend**: Firebase (Auth, Firestore — Spark/free plan) + Cloudflare Worker
  (mobile OTP) + Cloudinary (product images, unsigned upload). One optional
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
5. Create a free [Cloudinary](https://cloudinary.com) account and set up an
   **unsigned upload preset** — see "Product images (Cloudinary)" below for the
   exact settings. Copy the **Cloud name** and the **preset name** into `.env`.
6. Deploy the **OTP Cloudflare Worker** — see `workers/otp/README.md` for the
   full walkthrough (Cloudflare account, KV namespace, secrets, deploy). Copy
   the Worker's URL into `.env` as `EXPO_PUBLIC_OTP_WORKER_URL`. This is what
   makes mobile OTP login work; it needs no Firebase billing plan at all.
7. Deploy the Firestore rules (works on Spark, no Blaze needed):
```bash
   npm install -g firebase-tools     # once
   firebase login
   firebase use --add                # pick your project
   firebase deploy --only firestore:rules
```
8. **Important — this project intentionally stays on Firebase's free Spark
   plan.** Cloud Functions of any kind (secrets or not) require the Blaze
   (pay-as-you-go) plan to deploy at all. `functions/index.js` now contains
   only `reconcileOrderCost` (automatic order profit calculation) — mobile OTP
   and Cloudinary no longer use Cloud Functions, so they're unaffected. Unless
   you enable Blaze, skip `firebase deploy --only functions` entirely; orders
   will keep `costTotal`/`profitTotal` at their client-computed placeholder (0)
   instead of the server-reconciled value — fine for demo/testing, not accurate
   for real seller analytics.
9. **Create your first seller account.** Sign up once from the app (mobile OTP or
   email both create a normal `customer`-role account), then in the Firebase
   console open **Firestore → users → `<that uid>`** and change `role` from
   `customer` to `seller`. This has to be a manual step — the security rules
   deliberately never let a client set its own role to `seller` (see
   `firestore.rules`), so nobody can just grant themselves seller access from the
   app.

## How mobile OTP login works

Firebase's own client-side phone auth needs a web reCAPTCHA challenge via
`expo-firebase-recaptcha` — but that package was deprecated and **removed from
Expo as of SDK 48** — and Firebase's phone auth has required the **Blaze** plan
since late 2024 regardless. Firebase Cloud Functions need Blaze too, to deploy
at all, so a Cloud-Function-based OTP backend (MSG91 + a Function holding the
secret) isn't an option either while staying on Spark.

So phone sign-in here goes through a small **Cloudflare Worker** instead —
`workers/otp/` — which needs no Firebase billing plan:

1. The app calls the Worker's `/send-otp` endpoint. The Worker generates a
   4-digit code with Web Crypto's CSPRNG (`crypto.getRandomValues` —
   deliberately never `Math.random()`, which isn't cryptographically
   secure), hashes it into Cloudflare KV with a 5-minute expiry (replacing
   what used to be a Firestore `otp_requests` collection), and texts it via
   MSG91 through a DLT-approved template (India requires a pre-registered
   template for OTP SMS — see `workers/otp/README.md` to create one; MSG91's
   OTP API rejects free-form text without it).
2. The app calls `/verify-otp`. The Worker checks the code against the KV
   record itself (the client's claim of "verified" is never trusted, and
   MSG91's own verify endpoint is never used — this Worker is the one source
   of truth), then looks up — or creates — a Firebase Auth user by phone
   number via the Identity Toolkit REST API. Either way (new or existing
   user) it also makes sure a `users/{uid}` Firestore profile exists,
   creating one if it's somehow missing, before signing a Firebase **custom
   token** locally.
3. The app calls `signInWithCustomToken` with that token — from there it's a
   normal Firebase session, same as email sign-in.

The Worker never uses the `firebase-admin` npm package — its Node.js
Firestore/Auth clients need gRPC, which doesn't run in the Workers runtime.
Every Admin operation it needs (OAuth2 token exchange, looking up/creating a
user, signing a custom token, checking/writing the user's Firestore profile
doc) is reimplemented as plain signed-JWT + REST calls, following Firebase's
documented custom-token JWT spec exactly (RS256, `iss`/`sub`/`aud`/`iat`/`exp`/
`uid` claims) — see `workers/otp/src/google.ts` for exactly how and why.

See `workers/otp/README.md` for deployment, and `services/firebase/auth.ts`
(`requestPhoneOtp` / `confirmPhoneOtp`) for the client side, which now calls the
Worker's URL (`EXPO_PUBLIC_OTP_WORKER_URL`) with plain `fetch()` instead of a
Firebase callable function. Swapping MSG91 for Twilio or another provider only
means changing `workers/otp/src/msg91.ts` — nothing else needs to change.

## Product images (Cloudinary)

Firebase Storage isn't used anywhere in this app — product images go straight to
Cloudinary. Uploads are **unsigned** (no API key, no secret, no Cloud Function):
this project intentionally stays on Firebase's Spark (free) plan, and Cloud
Functions require Blaze to deploy at all, secrets or not — see "Firebase project
setup" above. Cloudinary's unsigned upload presets are the supported way to
upload directly from a client without a server component.

### Cloudinary dashboard setup (do this once)

1. Cloudinary Console → **Settings → Upload → Upload presets → Add upload preset**.
2. **Signing Mode: Unsigned.** This is what lets the app upload without a secret.
3. **Preset name**: anything you like (e.g. `vibekart_products`) — put it in
   `.env` as `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`.
4. **Folder**: set a fixed folder (e.g. `vibekart/products`) if you want every
   upload confined there regardless of what the app requests — recommended,
   since an unsigned preset can't verify who's calling it (see the trade-off
   note below).
5. Restrict the preset as much as Cloudinary allows for this use case:
   - **Allowed formats**: `jpg, png, webp` (no raw/video/svg).
   - **Resource type**: `Image` only.
   - **Max file size**: a few MB is plenty for product photos (this app also
     compresses client-side before upload, but the preset should enforce its
     own ceiling — don't rely on the client alone).
   - **Max image width/height**: e.g. 2000×2000, to stop absurdly large uploads.
   - Leave **Unique filename** on and do **not** enable letting the client set
     a custom `public_id` — auto-generated IDs avoid collision/overwrite risk.
6. Copy your **Cloud name** (Console → Dashboard, top of the page) into `.env`
   as `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME`.

Both `.env` values above are meant to be public (same trust model as Firebase's
client config) — they authorise *how* an upload happens, not *who* can do it.

### The trade-off this design accepts

An unsigned preset has no concept of Firebase Auth or this app's "seller" role —
Cloudinary and Firebase are unrelated services. Previously, a Cloud Function
checked `role == 'seller'` before issuing a signed upload; without Cloud
Functions, **anyone who extracts the cloud name and preset name from the app
bundle could upload images to this Cloudinary account.** Neither value is
encrypted or hidden in a shipped app — they're just not advertised. The
mitigations available without a server are entirely on the preset's own
restrictions (format/size/dimensions/folder, above). If this risk isn't
acceptable, the alternative is re-introducing a signed-upload Cloud Function,
which means upgrading to Blaze.

### How it works

1. Seller picks up to `MAX_PRODUCT_IMAGES` (see `constants/config.ts`, default 10)
   photos in the product form.
2. Each is resized/compressed on-device (`expo-image-manipulator`) before upload,
   to keep bandwidth and Cloudinary storage down.
3. The client uploads the file directly to Cloudinary's API with the unsigned
   preset attached, with live progress reported in the UI — see
   `services/cloudinary/upload.ts`.
4. The returned URL + public ID are saved on the product's Firestore doc as
   `imageUrls` / `imagePublicIds` (first entry = primary image).

### Deleting images — the one real limitation

Cloudinary has no "unsigned delete" API by design (it would let anyone delete
anyone's assets). Removing an image from a product, or deleting a product
outright, removes it from Firestore immediately (the app stops showing it
right away) but **does not** delete the file from Cloudinary — that needs a
signed Admin API call, which needs a secret, which this project has nowhere
to safely hold without Cloud Functions. Orphaned images accumulate in
Cloudinary storage over time. Two ways to deal with that:

- Periodically browse Cloudinary's Media Library and delete unused files by hand.
- Run `scripts/cloudinary-cleanup.js` — a manual, local-only Node script (not
  part of the app, not deployed anywhere) that compares Cloudinary against
  Firestore and deletes what's orphaned. It reads the API secret only from
  your own shell's environment variables at the moment you run it — see the
  comment at the top of that file for exact usage.

Images are organised in Cloudinary under `vibekart/products/{productId}/`.
Older products created before this migration (or local demo-mode products using
a bundled asset) keep working via `getProductImages()` in `data/store.ts`, which
falls back to the legacy single `image` field when `imageUrls` is empty — no
existing product's image ever disappears.

## Why a customer can never see supplier cost

Firestore security rules can only allow or deny reading a whole document — they
can't hide one field of a document a user is otherwise allowed to read. So instead
of one `products/{id}` document with a cost field customers are asked nicely not to
render, cost lives in a **separate** sub-document:

`firestore.rules` denies all read/write access to `private/data` unless the
signed-in user's own profile has `role == 'seller'`. A customer's client genuinely
cannot fetch that document, no matter what the app code does.

The same reasoning applies to order profit: a customer's client can never read
`baseCost`, so it can't compute a trustworthy `costTotal`/`profitTotal` when placing
an order. `functions/index.js` is a Cloud Function that reconciles this server-side
(with Admin SDK privileges) right after an order is created — see the comments in
that file and in `services/firebase/firestore.ts`.

## Project structure

## Known limitations / follow-ups

- **`reconcileOrderCost` needs the Blaze plan to deploy at all** — this project
  is intentionally on Spark, so this one remaining Cloud Function is present in
  the code but not deployed unless Blaze is enabled. Order `costTotal`/
  `profitTotal` stay at the client-side placeholder (0) rather than being
  server-reconciled. Mobile OTP (via the Cloudflare Worker) and Cloudinary are
  both unaffected — neither uses Cloud Functions anymore.
- **The OTP Worker is a separate deployable** from the Firebase project — it
  has its own `wrangler deploy` and its own secrets (`workers/otp/README.md`).
  Forgetting to redeploy it after an edit, or letting `EXPO_PUBLIC_OTP_WORKER_URL`
  drift out of sync with the actual deployed Worker, will break mobile OTP
  without affecting anything else in the app.
- **Product image uploads are unsigned** (see "Product images (Cloudinary)"
  above) because Cloud Functions aren't available on Spark. This means upload
  authorisation relies entirely on the Cloudinary preset's own restrictions,
  not on checking who's calling it — accepted trade-off, not an oversight.
- **Cloudinary asset deletion is manual.** Removing an image or deleting a
  product stops it from displaying immediately (Firestore is updated) but
  does not delete the underlying Cloudinary file — see
  `scripts/cloudinary-cleanup.js` for a manual cleanup option.
- **OTP rate limiting is basic**: a 30-second resend cooldown, 5 verify attempts
  per code, and 10 sends per IP per hour, all via Cloudflare KV (see
  `workers/otp/src/otp-store.ts`). Fine for an MVP; worth hardening (e.g. a real
  WAF rule, or Durable Objects for stronger per-phone-number locking) before
  high-volume production use.
- **Order cost/profit fields are on the same document the customer owns.** Unlike
  products, orders aren't split into public/private documents, so while no screen
  in this app ever renders `costTotal`/`profitTotal`/`unitCost` to a customer, a
  customer inspecting raw network traffic could technically see those fields on
  their own order. Closing this fully would mean the same public/private doc split
  used for products, applied to orders too.
- **Meesho product import is manual, not scraped.** The seller "Add product" form
  lets you paste a Meesho URL for your own reference, but does not auto-fetch
  title/price/images from it — see the note in `app/seller-add-product.tsx` for why
  (Meesho's ToS and page-structure fragility).
- **Sequential image uploads.** Multiple images for one product upload one at a
  time (with per-image progress and retry), not in parallel — simpler failure
  handling at the cost of some speed on slow connections.
- **Cart and favourites stay on-device** (not synced to the cloud) even in cloud
  mode — this was a deliberate scope cut, not an oversight.