# VibeKart Cloudflare Worker

A Cloudflare Worker for trusted manual-UPI order operations, image management,
and cleanup. Phone OTP is currently disabled and reserved for future use.
Both `/send-otp` and `/verify-otp` return HTTP 410 with
`PHONE_OTP_UNAVAILABLE`; these routes do not call MSG91 or create a Firebase
session.

MSG91 integration code and phone OTP helpers remain in the repository for
possible future reactivation. MSG91 is not used by current authentication, and
no MSG91 secret, template, dashboard setup, or `MSG91_TEMPLATE_ID` is required
for current functionality. Do not enable these routes or configure MSG91
without an explicit future product decision.

The Worker securely handles:

* Server-priced payment-attempt creation and UTR submission
* Trusted manual-UPI order creation from current Firestore product prices and delivery settings
* Admin-only payment review with version preconditions, unique UTR claims, and an audit record committed atomically with each payment-attempt or legacy-order review
* Seller/admin-authorized product deletion with server-side Cloudinary cleanup

UPI payment confirmation uses the Worker and does not require a payment gateway,
Firebase Cloud Functions, or a billing-plan upgrade.

Manual UPI confirmation and rejection are available only to authenticated users
whose Firestore profile has an active `admin` role. The Worker rereads the order,
validates the stored INR price snapshot, and atomically updates the order and
review audit (plus the unique reference claim on confirmation). A customer UTR
alone never confirms payment: the admin must first match the reference and
amount to the merchant-account credit in the admin review flow.

## Architecture

```text
Expo app
   |
   | HTTPS
   v
Cloudflare Worker
   |
   +--> Authenticate trusted order/image requests
   +--> Firebase Firestore REST API
   +--> Cloudinary signed upload and cleanup
```

## Important security model

The following credentials must remain on the Cloudflare Worker and must never be exposed to the Expo application:

* Firebase service-account private key
* Google private key
* Firebase service-account JSON

Do not put these credentials inside:

* `.env` with `EXPO_PUBLIC_` variables
* Expo client code
* React Native source files
* GitHub
* Firestore documents
* the mobile/web application bundle

Only public configuration such as the Worker URL should be available to the Expo application.

MSG91 credentials and the non-secret `MSG91_TEMPLATE_ID` are future-only. They
are not current Worker requirements and should not be added for this release.

## Why Cloudflare Worker?

Phone OTP is disabled. The Worker does not send SMS or create phone-auth
sessions.

The intended architecture is therefore:

```text
Firebase Spark + Cloudflare Worker + Firebase REST APIs + Cloudinary
```

The Worker currently handles trusted order and image operations; phone OTP and
MSG91 remain future-only.

## Worker requirements

The Worker requires:

* Cloudflare account
* Cloudflare Workers
* Cloudflare KV
* Firebase project
* Firebase service-account credentials

Current Firebase project:

```text
vibekart-f27b5
```

## Installation

From the project root:

```bash
cd workers/otp
npm install
```

This installs the Worker dependencies.

## Cloudflare login

Log in to Cloudflare:

```bash
npx wrangler login
```

A browser window will open for Cloudflare authentication.

## Create the KV namespace

The Worker uses Cloudflare KV for request idempotency, image upload throttling,
and scheduled cleanup cursors. Retained OTP implementation also uses KV but
the disabled OTP routes do not access it.

Run:

```bash
npx wrangler kv namespace create OTP_KV
```

Cloudflare will return a namespace ID.

Copy that ID into:

```text
workers/otp/wrangler.toml
```

Use the namespace ID belonging to the intended Cloudflare account. Do not
replace an existing production namespace ID or create a duplicate namespace
without an explicit migration plan.

## MSG91 (future-only)

Do not configure MSG91 for current functionality. Phone OTP is disabled at
both Worker routes, and the retained `src/msg91.ts` provider implementation is
not reached by either route. Future reactivation requires a separate product
decision, endpoint enablement, and review of applicable MSG91/DLT settings.
Until then, `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` are optional and unused.

## Firebase service account

The Worker needs a Firebase service-account credential so it can perform the required Firebase REST operations.

In Firebase Console:

```text
Project settings
→ Service accounts
→ Generate new private key
```

Download the JSON file.

Do not commit this JSON file to GitHub.

Prefer keeping the downloaded service-account file outside the Vibekart repository entirely.

For example:

```text
Desktop/firebase-service-account.json
```

or another secure location.

## Configure Worker secrets

From:

```bash
cd workers/otp
```

set the Firebase service-account JSON:

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

When prompted, paste the complete contents of the Firebase service-account JSON.

The secret is stored by Cloudflare and is not written into the repository.

Cloudinary image upload, attachment, and cleanup require these exact
environment bindings:

```bash
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

For local development, copy `workers/otp/.dev.vars.example` to
`workers/otp/.dev.vars` and populate it locally with
`FIREBASE_SERVICE_ACCOUNT_JSON` and the three Cloudinary bindings. Wrangler
reads `.dev.vars` when run from the Worker directory. MSG91 settings are
future-only and must not be treated as required. The example contains blank
placeholders only; `.dev.vars` and local variants are ignored by Git.

For production, open **Cloudflare Dashboard → Workers & Pages → vibekart-otp
→ Settings → Variables and Secrets**. Add `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` as Worker secrets, plus
`FIREBASE_SERVICE_ACCOUNT_JSON`. Cloudinary's cloud name
and API key identify the account; the API secret authorizes signed uploads and
destructive Admin API operations. Never put these values in Expo variables,
Vercel, or source control. Do not infer live configuration from this
repository; verify bindings in the authorized Cloudflare dashboard and inspect
Worker runtime logs when diagnosing production failures.

Missing Cloudinary bindings return an actionable configuration error without
including credential values. Firebase authentication and Cloudinary API
failures use separate error paths. This distinction is diagnostic, not
confirmation of any production incident's cause.

Never put the service-account JSON into:

```text
.env
.env.example
EXPO_PUBLIC_*
GitHub
```

## Worker configuration

The Worker configuration is located at:

```text
workers/otp/wrangler.toml
```

It contains the Worker name, KV binding, and non-secret configuration for
current Worker features. MSG91 is not configured there.

The KV binding name must match the binding used by the Worker source code.

The expected binding is:

```text
OTP_KV
```

## API endpoints

The Worker exposes disabled phone-OTP routes plus payment and
product-management endpoints.

### Phone OTP (disabled)

```text
POST /send-otp
POST /verify-otp
```

Both routes return HTTP 410 with the same response:

```json
{
  "error": "Phone OTP sign-in is currently unavailable. Use Google or email and password.",
  "code": "PHONE_OTP_UNAVAILABLE"
}
```

Neither route sends an SMS, reads/writes OTP state, or creates a Firebase
session. Do not use production SMS for testing.

## Manual UPI payments

All payment endpoints below require `Authorization: Bearer <Firebase ID token>`.
The Worker validates the token and checks the caller's active Firestore profile.

### Create an attempt

```text
POST /payment-attempts/create
```

The request contains cart product IDs/quantities, customer delivery details,
and an idempotency key. The Worker reloads product prices and availability;
client-supplied totals and prices are ignored. It creates a `payment_attempts`
document and an admin-only private cost snapshot. It does not create an order.
Attempts have a 24-hour expiry timestamp, but are not automatically expired;
customers can still submit a reference later for reconciliation.

### Submit payment details

```text
POST /payment-attempts/submit
```

Request:

```json
{
  "attemptId": "pay-...",
  "customerUtr": "reference copied from the customer's payment app"
}
```

The Worker trims and requires a non-empty reference (up to 100 characters)
without assuming a provider-specific format. Submission leaves the attempt
unverified and creates no order.

### Admin review

```text
POST /admin/payment-attempts/confirm
POST /admin/payment-attempts/reject
POST /admin/payment-attempts/cancel
POST /admin/payment-attempts/expire
```

Every route independently checks that the authenticated user's Firestore
profile has the active `admin` role. Confirmation requires a submitted UTR and
an explicit confirmation from the admin that the actual merchant-account
credit was checked. It atomically creates the paid order, its private cost
snapshot, updates the attempt, and claims a normalized transaction reference
so that it cannot confirm a second order. The Worker cannot independently
prove a manual UPI credit; the admin must verify the merchant's transaction
history. Rejected, cancelled, and manually expired attempts never create an
order.

`POST /create-order` is retired and returns `410 Gone`; clients must use
`/payment-attempts/create`. The old client-side `/payment/verify` route is not
available for marking an order paid.

The Expo client can read an attempt only when it belongs to the signed-in user.
Direct client creates/updates/deletes of payment attempts and direct order
creation/payment-status updates are denied by `firestore.rules`. Deploy the
matching rules after review before enabling the updated app.

## Product images and cleanup

```text
POST /seller/products/delete
Authorization: Bearer <Firebase ID token>
```

Request:

```json
{
  "productId": "product-id"
}
```

The Expo app sends image bytes to authenticated `POST /cloudinary/upload`.
Sellers/admins may upload to an existing product they are authorized to edit;
only admins may upload payment QR images. The Worker generates the Cloudinary
public ID, signs the upload, and records a Firestore ownership binding before
calling Cloudinary. The app cannot choose an arbitrary public ID or use the
server-side API secret.

The app attaches product images through `POST /seller/products/images` and
payment QR images through `POST /admin/payment-settings/qr-image`. The Worker
checks the upload's ownership record, target, and URL before updating metadata.
Firestore rules deny direct client changes to these protected image fields and
deny client access to ownership records and cleanup jobs.

When images are removed from a product, a QR is replaced/cleared, or a product
is deleted, the metadata operation and a durable cleanup job are committed
together. Cleanup rereads the target and does not call Cloudinary while a queued
ID is still referenced. The Worker retries incomplete cleanup using the
15-minute scheduled trigger in `wrangler.toml`; the app can also retry pending
cleanup. Cloudinary partial responses leave ownership records/jobs in place for
retry. A successful upload that cannot be attached is retained for retry or
queued for cleanup rather than silently forgotten.

Legacy image IDs created before ownership records were introduced are allowed
to remain displayed, but cannot be safely removed or deleted automatically.
The Worker fails closed when it cannot verify the asset-to-target binding.
Before cleanup of those assets, perform an authorized inventory review and a
trusted migration that records actual ownership; never bulk-register IDs
provided by clients or treat a folder prefix as proof.

The previous direct unsigned-upload client flow should be considered retired
after all deployed app versions are updated. In Cloudinary Console, review
**Settings → Upload → Upload presets** and disable/delete any old unsigned
preset only after confirming no supported older client still needs it.

## Product deletion

`POST /seller/products/delete` requires a Firebase ID token. Sellers may delete
only products whose `createdByUid` is their UID; admins may delete any product.
The Worker atomically deletes the product documents and queues Cloudinary
cleanup. If cleanup is incomplete, the response still reports deletion success
with `cleanupPending: true`; retry with the same product ID or let the scheduled
trigger retry. Product deletion is not rolled back because Cloudinary is
temporarily unavailable. Legacy assets without trusted ownership records block
the deletion rather than risking deletion of unrelated account assets.

Direct client product deletion remains denied by `firestore.rules`.

## Future-only OTP implementation

The OTP storage, cryptographic generation, abuse controls, Firebase user
handling, and custom-token code remain in `src/` for possible future use.
They are not part of the active route behavior: `/send-otp` and `/verify-otp`
return the unavailable response before invoking those handlers. MSG91
configuration is optional and unused while the feature is disabled. A future
reactivation must include a security review and tests proving that phone
verification cannot be bypassed.

## Expo Worker URL

The Expo application uses this URL for trusted order and image APIs (the
variable name is retained for compatibility):

```text
EXPO_PUBLIC_OTP_WORKER_URL=https://YOUR-WORKER-URL.workers.dev
```

Do not put any secret in this variable.

After changing the Expo environment, restart the Expo development server so the new value is loaded.

## Deploy the Worker

After configuration and testing:

```bash
cd workers/otp
npx wrangler deploy
```

Cloudflare will provide the deployed Worker URL.

For example:

```text
https://vibekart-otp.YOUR-SUBDOMAIN.workers.dev
```

Put that URL into the root Vibekart `.env` for current Worker APIs:

```text
EXPO_PUBLIC_OTP_WORKER_URL=https://vibekart-otp.YOUR-SUBDOMAIN.workers.dev
```

The URL is used for current Worker operations. Phone OTP remains disabled.

## Test the Worker

Before testing through the Expo application, test the Worker endpoints directly.

### Disabled phone OTP routes

```bash
curl -i -X POST https://YOUR-WORKER-URL.workers.dev/send-otp
```

The route should return HTTP 410 and:

```json
{
  "error": "Phone OTP sign-in is currently unavailable. Use Google or email and password.",
  "code": "PHONE_OTP_UNAVAILABLE"
}
```

```bash
curl -i -X POST https://YOUR-WORKER-URL.workers.dev/verify-otp
```

Neither request sends SMS or performs Firebase authentication. Do not submit a
real phone number or OTP while checking these disabled routes.

## Local type checking

From the Worker directory:

```bash
cd workers/otp
npm run typecheck
```

The Worker must compile successfully before deployment.

From the Vibekart project root:

```bash
cd /Users/ghalibkamal/Downloads/vibekart
npm run typecheck
```

The main Expo application must also compile successfully.

## CORS

Browser requests require appropriate CORS headers.

The Worker handles CORS through:

```text
workers/otp/src/cors.ts
```

The allowlist includes local development, Firebase Hosting, and the current
Vercel production origin (`https://vibekaart.vercel.app`). Add any new
production domain as an exact origin in `workers/otp/src/cors.ts`.

Do not use unrestricted CORS with credentials.

Native Expo requests do not have the same browser CORS restrictions, but keeping correct CORS handling is still necessary for Expo Web.

## Vercel configuration

The Vercel project must set `EXPO_PUBLIC_OTP_WORKER_URL` to the deployed
Cloudflare Worker URL for current order/image APIs and rebuild the web app.
CORS allowlisting alone does not configure the app to call the Worker. Never
put Worker secrets in Vercel's `EXPO_PUBLIC_*` variables.

## Troubleshooting

### Phone OTP is unavailable

This is expected: phone OTP and MSG91 are future-only. Both endpoints return
`PHONE_OTP_UNAVAILABLE` without sending SMS. Do not add MSG91 configuration to
resolve this response.

### Worker returns authentication errors

Check:

1. `FIREBASE_SERVICE_ACCOUNT_JSON` is configured correctly.
2. The service-account JSON belongs to:

   ```text
   vibekart-f27b5
   ```
3. The private key is valid.
4. The Firebase project ID is correct.
5. The Worker has access to the required Firebase REST APIs.

### Expo cannot reach the Worker

Check:

1. `EXPO_PUBLIC_OTP_WORKER_URL` exists in the root `.env`.
2. The Worker URL is correct.
3. The Expo development server was restarted after changing `.env`.
4. Browser CORS configuration includes the current web origin.
5. The Worker is deployed and reachable.

## Security notes

Never commit:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
Firebase private keys
service-account JSON files
Cloudflare secret values
```

`MSG91_AUTH_KEY` is also a secret if configured in the future, but is not
required or used while phone OTP is disabled.

Never place these values inside:

```text
EXPO_PUBLIC_*
```

The Expo application is client-side code and anything placed in an `EXPO_PUBLIC_*` variable should be treated as public.

## Current authentication and OTP status

```text
Google sign-in / email-password sign-in -> Firebase Authentication
Guest browsing -> local app experience
Phone OTP -> unavailable (HTTP 410; no MSG91 call)
```

The retained OTP/MSG91 implementation is future-only. It is not used by a
current user-facing flow and is not needed to deploy the current Worker.
