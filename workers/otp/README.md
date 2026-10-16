# VibeKart OTP Worker

A Cloudflare Worker that replaces Firebase Cloud Functions for OTP and manual UPI payment operations.

Firebase Cloud Functions require the Blaze plan, so this Worker keeps the OTP backend outside Firebase while allowing the Firebase project to remain on the Spark/free plan.

The Worker securely handles:

* OTP generation using Web Crypto
* OTP storage and expiration using Cloudflare KV
* OTP verification
* MSG91 SMS delivery
* Firebase user lookup/creation
* Firestore profile creation/repair
* Firebase custom-token generation
* Server-priced payment-attempt creation and UTR submission
* Trusted manual-UPI order creation from current Firestore product prices and delivery settings
* Admin-only manual-UPI payment review with order-version preconditions, unique UTR claims, and an atomic reviewer audit
* Seller/admin-authorized product deletion with server-side Cloudinary cleanup

The Expo app never receives or stores the MSG91 authentication key or Firebase service-account credentials. UPI payment confirmation uses the same Worker and does not require a payment gateway, Firebase Cloud Functions, or a billing-plan upgrade.

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
Cloudflare OTP Worker
   |
   +--> Generate OTP using Web Crypto
   |
   +--> Store OTP + expiry + attempts in Cloudflare KV
   |
   +--> MSG91
   |      |
   |      +--> Deliver OTP through SMS
   |
   +--> Firebase Identity Toolkit REST API
   |      |
   |      +--> Find existing Firebase user
   |      +--> Create Firebase user if necessary
   |
   +--> Firebase Firestore REST API
   |      |
   |      +--> Create/repair users/{uid} profile
   |
   +--> Sign Firebase Custom Token locally
   |
   v
Expo app
   |
   +--> signInWithCustomToken()
   |
   v
Normal Firebase Authentication session
```

## Important security model

The following credentials must remain on the Cloudflare Worker and must never be exposed to the Expo application:

* MSG91 authentication key
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

Set the non-secret `MSG91_TEMPLATE_ID` Worker variable in the Cloudflare
dashboard. `wrangler.toml` keeps dashboard variables during deploys and does not
ship a placeholder template ID.

## Why Cloudflare Worker?

Firebase Cloud Functions are not used for OTP because they require the Firebase Blaze plan.

The intended architecture is therefore:

```text
Firebase Spark
    +
Cloudflare Worker
    +
MSG91
    +
Firebase REST APIs
```

No Firebase Cloud Function is required for the OTP flow.

## Worker requirements

The Worker requires:

* Cloudflare account
* Cloudflare Workers
* Cloudflare KV
* MSG91 account
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

The Worker uses Cloudflare KV to store OTP information.

Run:

```bash
npx wrangler kv namespace create OTP_KV
```

Cloudflare will return a namespace ID.

Copy that ID into:

```text
workers/otp/wrangler.toml
```

Replace:

```text
REPLACE_WITH_YOUR_KV_NAMESPACE_ID
```

with the real namespace ID.

Do not invent or reuse another KV namespace ID.

## MSG91 setup

The Worker sends OTP messages through MSG91.

For Indian mobile numbers, configure an approved OTP template in MSG91.

In the MSG91 dashboard:

```text
MSG91 Dashboard
→ OTP
→ Templates
→ Create Template
```

Use a template containing one OTP variable, for example:

```text
Your OTP for login is ##OTP##. Please do not share it with anyone.
```

The exact template text must follow MSG91's current requirements and the applicable Indian DLT rules.

After the template is approved, copy its template ID.

Set the template ID in:

```text
workers/otp/wrangler.toml
```

using:

```text
MSG91_TEMPLATE_ID
```

The template ID itself is not a secret.

The MSG91 authentication key is secret and must be stored using Cloudflare Worker secrets.

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

set the MSG91 authentication key:

```bash
npx wrangler secret put MSG91_AUTH_KEY
```

When prompted, paste the MSG91 authentication key.

Then set the Firebase service-account JSON:

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

When prompted, paste the complete contents of the Firebase service-account JSON.

The secret is stored by Cloudflare and is not written into the repository.

Product deletion also requires the Cloudinary Admin API credentials. Create
these as Worker secrets (not app environment variables):

```bash
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
```

The cloud name and API key identify the Cloudinary account; the API secret
authorizes destructive Admin API operations. Keep all three out of Expo
variables and source control. When a product has no Cloudinary image IDs, the
Worker can remove its Firestore documents without these secrets. When it does
have stored image IDs and the credentials are missing, deletion fails closed
and preserves the product.

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

It contains the Worker name, KV binding, and non-secret configuration such as the MSG91 template ID.

The KV binding name must match the binding used by the Worker source code.

The expected binding is:

```text
OTP_KV
```

## API endpoints

The Worker exposes OTP, payment, and product-management endpoints.

### Send OTP

```text
POST /send-otp
```

Request:

```json
{
  "phone": "9876543210"
}
```

The Worker normalizes the number to the required Indian format.

A successful request returns a response similar to:

```json
{
  "success": true
}
```

The actual OTP is never returned to the frontend.

It is sent through MSG91 SMS.

### Verify OTP

```text
POST /verify-otp
```

Request:

```json
{
  "phone": "9876543210",
  "otp": "1234"
}
```

If verification succeeds, the Worker returns a Firebase custom token:

```json
{
  "success": true,
  "token": "..."
}
```

The Expo application then passes that token to Firebase:

```text
signInWithCustomToken()
```

The Worker does not expose the Firebase service-account credentials.

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

## Product deletion

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

The Worker checks that the caller has an active seller or admin profile. A
seller may delete only a product whose `createdByUid` matches their UID;
administrators may also delete legacy products without an owner UID. Before
deleting Firestore documents, it removes every validated `imagePublicIds`
asset through the Cloudinary Admin API. It then conditionally deletes both the
public product document and its private data in one Firestore commit. Direct
client product deletion is denied by `firestore.rules`.

Cloudinary and Firestore cannot participate in one distributed transaction. If
the Cloudinary request succeeds but the Firestore commit fails because the
product changed, the Worker returns a conflict and leaves the product record
intact. A retry safely accepts Cloudinary's `not_found` result for an image
already removed.

## OTP storage

OTP information is stored in Cloudflare KV.

The stored information includes the information required to:

* verify the OTP
* enforce expiration
* limit verification attempts

OTP data is temporary and should expire automatically.

The Worker should invalidate the OTP after successful verification.

## OTP generation

OTP generation must use the Web Crypto API available in Cloudflare Workers.

The implementation must not use:

```text
Math.random()
```

for authentication OTP generation.

The OTP should be generated using a cryptographically secure random source.

## Rate limiting

The Worker provides basic free-tier-compatible abuse protection.

The intended limits are:

* OTP sends: up to 10 per IP per hour
* OTP verification: up to 5 attempts per OTP

The implementation uses Cloudflare KV for this state.

This is basic application-level protection.

It is not a replacement for a dedicated WAF or advanced rate-limiting system if the application grows significantly.

## Firebase user handling

After a valid OTP:

1. The Worker checks Firebase for an existing user associated with the phone number.
2. If the user exists, the existing Firebase Auth user is reused.
3. If the user does not exist, the Worker creates the Firebase Auth user.
4. The Worker checks the Firestore profile:

   ```text
   users/{uid}
   ```
5. If the profile does not exist, the Worker creates it.
6. The Worker generates a Firebase custom token.
7. The token is returned to the Expo application.
8. The Expo application calls:

   ```text
   signInWithCustomToken()
   ```

This also handles the recovery case where a Firebase Auth user exists but the corresponding Firestore profile is missing.

## Firebase custom token

The Worker generates the Firebase custom token locally using the Firebase service-account private key.

The token must follow Firebase's custom-token JWT requirements, including:

* correct JWT header
* RS256 signature
* issuer
* subject
* audience
* issued-at timestamp
* expiration
* Firebase authentication claims

The private key remains inside the Cloudflare Worker secret.

## Expo environment variable

The Expo application needs the Worker URL.

In the root Vibekart `.env`:

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

Put that URL into the root Vibekart `.env`:

```text
EXPO_PUBLIC_OTP_WORKER_URL=https://vibekart-otp.YOUR-SUBDOMAIN.workers.dev
```

Do not include `/send-otp` or `/verify-otp` in the environment variable.

The frontend adds those paths itself.

## Test the Worker

Before testing through the Expo application, test the Worker endpoints directly.

### Send OTP

```bash
curl -X POST https://YOUR-WORKER-URL.workers.dev/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210"}'
```

A successful request should return:

```json
{
  "success": true
}
```

and an OTP SMS should be delivered to the phone.

### Verify OTP

Use the OTP received by SMS:

```bash
curl -X POST https://YOUR-WORKER-URL.workers.dev/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210","otp":"1234"}'
```

A successful verification should return:

```json
{
  "success": true,
  "token": "..."
}
```

The actual token should then be consumed by the Expo application through Firebase's:

```text
signInWithCustomToken()
```

Do not paste production Firebase custom tokens into public services, GitHub, chat, or issue trackers.

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
Cloudflare Worker URL and rebuild the web app. CORS allowlisting alone does not
configure the app to call the Worker. Never put Worker secrets in Vercel's
`EXPO_PUBLIC_*` variables.

## Troubleshooting

### OTP is not received

Check:

1. MSG91 authentication key is configured.
2. MSG91 template ID is correct.
3. The MSG91 OTP template is approved.
4. The phone number is valid.
5. The MSG91 account has the required SMS configuration.
6. Cloudflare Worker logs for the request.

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

### Firebase custom-token sign-in fails

Check:

1. The custom token is generated with RS256.
2. The service-account private key is correct.
3. The issuer is the service-account email.
4. The subject is the service-account email.
5. The audience is Firebase Identity Toolkit.
6. The token has valid `iat` and `exp` timestamps.
7. The Firebase UID is included correctly.
8. The Expo app is using:

   ```text
   signInWithCustomToken()
   ```

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
MSG91_AUTH_KEY
Firebase private keys
service-account JSON files
Cloudflare secret values
```

Never place these values inside:

```text
EXPO_PUBLIC_*
```

The Expo application is client-side code and anything placed in an `EXPO_PUBLIC_*` variable should be treated as public.

## Relationship with Firebase Cloud Functions

The OTP Worker replaces the old Firebase Cloud Functions:

```text
sendOtp
verifyOtp
```

The OTP flow should not depend on Firebase Cloud Functions.

Other Firebase Cloud Functions may still exist in the project for unrelated functionality. Those functions are outside the scope of this OTP Worker.

## Current OTP flow summary

```text
1. User enters phone number
        ↓
2. Expo calls /send-otp
        ↓
3. Worker validates phone
        ↓
4. Worker generates secure OTP
        ↓
5. OTP stored temporarily in Cloudflare KV
        ↓
6. MSG91 sends SMS
        ↓
7. User enters OTP
        ↓
8. Expo calls /verify-otp
        ↓
9. Worker verifies OTP from KV
        ↓
10. Worker finds or creates Firebase Auth user
        ↓
11. Worker creates/repairs Firestore profile
        ↓
12. Worker creates Firebase custom token
        ↓
13. Expo receives token
        ↓
14. signInWithCustomToken()
        ↓
15. Normal Firebase Auth session
```

The Worker is intended to keep the Firebase project on the Spark plan while providing a secure server-side OTP flow through Cloudflare Workers and MSG91.
