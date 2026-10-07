import AsyncStorage from '@react-native-async-storage/async-storage';
import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import { Auth, browserLocalPersistence, initializeAuth } from 'firebase/auth';
// @ts-ignore — firebase/auth's TypeScript types lag the runtime export
// (firebase-js-sdk#8332 / #9316); getReactNativePersistence works fine at
// runtime, the .d.ts file just hasn't caught up yet.
import { getReactNativePersistence } from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { Platform } from 'react-native';

/**
 * Single source of truth for Firebase initialisation.
 *
 * All EXPO_PUBLIC_* variables are bundled into the client and are NOT secret
 * (Firebase web/client config is meant to be public — real access control
 * happens in Firestore security rules, not by hiding these values). Product
 * images live in Cloudinary, not Firebase Storage — see
 * services/cloudinary/upload.ts. See .env.example for the full list and
 * firestore.rules for the actual access control.
 */
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

/** True once real Firebase keys are present. When false, the app falls back
 * to the local AsyncStorage demo mode instead of crashing on missing config
 * (see context/StoreContext.tsx). Fill in .env with your Firebase project's
 * values to turn this on. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (isFirebaseConfigured) {
  try {
    app = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);
    // getReactNativePersistence only exists in firebase/auth's native (iOS/
    // Android) build — the web build doesn't export it at all, so calling it
    // unconditionally crashes with "is not a function" as soon as this runs
    // in a browser. This app is a universal Expo Router app (it also runs on
    // web), so persistence has to be picked per platform.
    auth = initializeAuth(app, {
      persistence:
        Platform.OS === 'web' ? browserLocalPersistence : getReactNativePersistence(AsyncStorage),
    });
    db = getFirestore(app);
  } catch (error) {
    // This runs at module-import time — inside app/_layout.tsx's import
    // chain, before React even starts rendering. An uncaught throw here
    // would fail the whole bundle evaluation and produce a permanent blank
    // screen with nothing useful in the console. Fall back to null
    // singletons (same as "not configured") instead: subscribeToAuthState()
    // already handles auth === null gracefully, so the app still reaches
    // /login.
    console.warn('[firebase] initialization threw — falling back to local demo mode', error);
    app = null;
    auth = null;
    db = null;
  }
} else if (__DEV__) {
  // eslint-disable-next-line no-console
  console.warn(
    '[firebase] EXPO_PUBLIC_FIREBASE_* env vars are missing — running in local demo mode. ' +
      'Copy .env.example to .env and fill in your Firebase project config to enable ' +
      'real auth/Firestore.',
  );
}

export { app, auth, db };