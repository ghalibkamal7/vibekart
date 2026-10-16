import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from './config';
import { performGoogleSignIn, signOutOfGoogle } from './googleSignIn';

export type UserRole = 'customer' | 'seller' | 'admin';

export type UserProfile = {
  uid: string;
  email: string;
  name: string;
  phone?: string;
  role: UserRole;
  status?: 'active' | 'suspended';
  createdAt?: any;
};

/**
 * NOTE on phone-number sign-in: real Firebase phone auth needs a web
 * reCAPTCHA challenge via `expo-firebase-recaptcha`, but that package was
 * deprecated and removed from Expo as of SDK 48 — it doesn't work on the
 * Expo SDK this project targets. Firebase's own phone auth also requires
 * the Blaze plan as of late 2024, and this project intentionally stays on
 * the free Spark plan — so does every Firebase Cloud Function, which rules
 * out a Cloud-Function-based OTP backend too (Cloud Functions need Blaze
 * to deploy at all, independent of whether they use secrets).
 *
 * Phone OTP and its MSG91 provider implementation are retained for future
 * use, but the Worker currently disables both OTP endpoints. The active
 * login methods are email/password and Google; guest browsing is also
 * available without signing in.
 */

function requireAuth() {
  if (!auth) throw new Error('Firebase is not configured. See .env.example.');
  return auth;
}

function requireDb() {
  if (!db) throw new Error('Firebase is not configured. See .env.example.');
  return db;
}

// ---------------- Friendly error messages ----------------
// Errors are either a specific, already-readable message (one of the
// known auth/* codes below, or an { error } string the OTP Worker sent
// deliberately — see workers/otp/src/index.ts) or something generic like
// Firebase's bare "internal" — which a browser can show when a request
// fails before producing a real error (a network problem, a cold-start
// crash, etc). A raw "internal" string is never shown to the user; the
// real error is still logged to the console (prefixed `[auth]`) for
// debugging.

const FRIENDLY_AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/user-not-found': 'No account found with that email.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Choose a stronger password (at least 6 characters).',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  // Google sign-in (web popup + native module)
  'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
  'auth/cancelled-popup-request': 'Google sign-in was cancelled.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  'auth/account-exists-with-different-credential':
    'An account with this email already exists using a different sign-in method. Sign in with your email and password instead.',
  'auth/operation-not-allowed': 'Google sign-in is not enabled for this project yet.',
  'auth/unauthorized-domain': "This website's domain isn't authorised for Google sign-in yet.",
  'google/cancelled': 'Google sign-in was cancelled.',
  'google/in-progress': 'A Google sign-in is already in progress.',
  'google/not-configured': 'Google sign-in is not configured yet.',
  'google/needs-dev-build': 'Google sign-in on phones needs a development build of the app (it cannot run in Expo Go).',
  'google/play-services-unavailable': 'Google Play Services is unavailable or out of date on this device.',
  'google/no-id-token': "Google sign-in couldn't be completed. Please try again.",
};

/** Safe-to-log summary of an error: only the code and message — never the
 * error object itself, which for some failures can carry request details
 * (tokens, credentials). */
function describeAuthError(error: unknown): { code: string; message: string } {
  return {
    code: (error as { code?: string })?.code ?? 'unknown',
    message: error instanceof Error ? error.message : String(error ?? ''),
  };
}

function friendlyAuthMessage(error: unknown, fallback: string): string {
  const code = ((error as { code?: string })?.code ?? '').toLowerCase();
  if (FRIENDLY_AUTH_MESSAGES[code]) return FRIENDLY_AUTH_MESSAGES[code];

  const message = error instanceof Error ? error.message : String(error ?? '');
  const looksGeneric =
    !message || message.toLowerCase() === 'internal' || code.endsWith('/internal') || message.startsWith('Firebase:');
  if (!looksGeneric) return message;
  // In development builds, show the real error code next to the generic
  // text so "We couldn't sign you in" is never a dead end while debugging.
  // Production builds show only the friendly sentence.
  return __DEV__ && code ? `${fallback} (${code})` : fallback;
}

export function subscribeToAuthState(callback: (user: User | null) => void) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function signUp(params: {
  email: string;
  password: string;
  name: string;
  phone?: string;
  role?: UserRole;
}): Promise<UserProfile> {
  try {
    const authInstance = requireAuth();
    const database = requireDb();
    const credential = await createUserWithEmailAndPassword(authInstance, params.email, params.password);
    const profile: UserProfile = {
      uid: credential.user.uid,
      email: params.email,
      name: params.name,
      phone: params.phone,
      role: params.role ?? 'customer',
    };
    // Firestore rejects `undefined` field values, so phone is only written
    // when one was actually provided.
    const { phone, ...profileWithoutPhone } = profile;
    await setDoc(doc(database, 'users', credential.user.uid), {
      ...profileWithoutPhone,
      ...(phone ? { phone } : {}),
      createdAt: serverTimestamp(),
    });
    return profile;
  } catch (error) {
    console.warn('[auth] sign up failed', error);
    throw new Error(friendlyAuthMessage(error, "We couldn't create your account. Please try again."));
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  try {
    const authInstance = requireAuth();
    const credential = await signInWithEmailAndPassword(authInstance, email, password);
    return credential.user;
  } catch (error) {
    console.warn('[auth] sign in failed', error);
    throw new Error(friendlyAuthMessage(error, "We couldn't sign you in. Please try again."));
  }
}

export async function signOutUser(): Promise<void> {
  // Clear the native Google session first (no-op on web / if never used),
  // so the next Google sign-in shows the account chooser rather than
  // silently reusing the previous account.
  await signOutOfGoogle();
  if (!auth) return;
  await firebaseSignOut(auth);
}

export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  if (!db) return null;
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? (snapshot.data() as UserProfile) : null;
}

// ---------------- Google Sign-In ----------------
// Web uses Firebase's popup flow, iOS/Android use the native Google SDK —
// see googleSignIn.web.ts / googleSignIn.native.ts. Either way the result is
// a normal Firebase user, so the existing onAuthStateChanged listener picks
// it up exactly like an email sign-in.

/** Creates users/{uid} only if it doesn't exist yet — an existing user's
 * profile (role, name, phone, ...) is never overwritten, and there's never
 * more than one document per uid. Best-effort: the person is already
 * authenticated at this point, so a failed profile write (e.g. rules not
 * deployed yet) is logged and retried on their next sign-in rather than
 * blocking login. */
async function ensureGoogleUserProfile(user: User): Promise<void> {
  try {
    const database = requireDb();
    const ref = doc(database, 'users', user.uid);
    const existing = await getDoc(ref);
    if (existing.exists()) return;
    await setDoc(ref, {
      uid: user.uid,
      email: user.email ?? '',
      name: user.displayName ?? '',
      role: 'customer' as UserRole,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.warn('[auth] could not create the Google user profile (will retry next sign-in)', error);
  }
}

export async function signInWithGoogle(): Promise<void> {
  try {
    const user = await performGoogleSignIn(requireAuth());
    await ensureGoogleUserProfile(user);
  } catch (error) {
    console.warn('[auth] Google sign-in failed', describeAuthError(error));
    throw new Error(friendlyAuthMessage(error, "We couldn't sign you in with Google. Please try again."));
  }
}

// ---------------- Future-only phone OTP (via a Cloudflare Worker) ----------------
// Both Worker OTP endpoints return PHONE_OTP_UNAVAILABLE and do not call MSG91.
// Keep these client helpers for a future, explicitly authorized reactivation.

const OTP_WORKER_URL = process.env.EXPO_PUBLIC_OTP_WORKER_URL ?? '';

function requireOtpWorkerUrl(): string {
  if (!OTP_WORKER_URL) {
    throw new Error('Mobile OTP is not configured. See .env.example (EXPO_PUBLIC_OTP_WORKER_URL).');
  }
  return OTP_WORKER_URL;
}

async function callOtpWorker<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${requireOtpWorkerUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}) as Record<string, unknown>);
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

export async function requestPhoneOtp(phone: string): Promise<void> {
  try {
    await callOtpWorker('/send-otp', { phone });
  } catch (error) {
    console.warn('[auth] phone OTP is unavailable', describeAuthError(error));
    throw new Error(friendlyAuthMessage(error, "We couldn't send the OTP. Please try again."));
  }
}

export async function confirmPhoneOtp(phone: string, otp: string): Promise<void> {
  try {
    const result = await callOtpWorker<{ token: string }>('/verify-otp', { phone, otp });
    await signInWithCustomToken(requireAuth(), result.token);
  } catch (error) {
    console.warn('[auth] phone OTP is unavailable', describeAuthError(error));
    throw new Error(friendlyAuthMessage(error, "We couldn't verify that OTP. Please try again."));
  }
}