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

export type UserRole = 'customer' | 'seller';

export type UserProfile = {
  uid: string;
  email: string;
  name: string;
  phone?: string;
  role: UserRole;
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
 * So phone sign-in here (requestPhoneOtp/confirmPhoneOtp below) calls a
 * Cloudflare Worker instead (see workers/otp/) — Cloudflare's free tier —
 * which holds the MSG91 and Firebase service-account credentials, verifies
 * the OTP, and returns a Firebase custom token the same way the old Cloud
 * Function did. Email/password (signUp/signIn above) is also available as
 * an alternative sign-in method and needs none of this.
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
};

function friendlyAuthMessage(error: unknown, fallback: string): string {
  const code = ((error as { code?: string })?.code ?? '').toLowerCase();
  if (FRIENDLY_AUTH_MESSAGES[code]) return FRIENDLY_AUTH_MESSAGES[code];

  const message = error instanceof Error ? error.message : String(error ?? '');
  const looksGeneric =
    !message || message.toLowerCase() === 'internal' || code.endsWith('/internal') || message.startsWith('Firebase:');
  return looksGeneric ? fallback : message;
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
    await setDoc(doc(database, 'users', credential.user.uid), {
      ...profile,
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
  if (!auth) return;
  await firebaseSignOut(auth);
}

export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  if (!db) return null;
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? (snapshot.data() as UserProfile) : null;
}

// ---------------- Phone OTP (custom, via a Cloudflare Worker) ----------------
// See the top-of-file note for why this isn't Firebase's built-in phone auth
// or a Cloud Function. sendOtp texts a code via MSG91 (configured in the
// Worker); verifyOtp checks it server-side there and returns a Firebase
// custom token, which signInWithCustomToken exchanges for a real session —
// same onAuthStateChanged listener as email sign-in picks it up from there.

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
    console.warn('[auth] sendOtp (Worker) failed', error);
    throw new Error(friendlyAuthMessage(error, "We couldn't send the OTP. Please try again."));
  }
}

export async function confirmPhoneOtp(phone: string, otp: string): Promise<void> {
  try {
    const result = await callOtpWorker<{ token: string }>('/verify-otp', { phone, otp });
    await signInWithCustomToken(requireAuth(), result.token);
  } catch (error) {
    console.warn('[auth] verifyOtp (Worker) failed', error);
    throw new Error(friendlyAuthMessage(error, "We couldn't verify that OTP. Please try again."));
  }
}