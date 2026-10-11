import type { Auth, User } from 'firebase/auth';

/**
 * Google Sign-In has two real implementations, picked per platform by
 * Metro at bundle time (standard React Native platform-extension
 * resolution):
 *
 *   googleSignIn.web.ts     — Firebase's signInWithPopup (browser OAuth)
 *   googleSignIn.native.ts  — @react-native-google-signin/google-signin
 *                             (native module; needs a development build,
 *                             it cannot run inside Expo Go)
 *
 * This plain .ts file exists so TypeScript has one module to resolve when
 * type-checking, and as a safe fallback for any platform that has neither.
 * All three files must keep the same exported signatures.
 */
export async function performGoogleSignIn(_auth: Auth): Promise<User> {
  throw new Error('Google Sign-In is not supported on this platform.');
}

export async function signOutOfGoogle(): Promise<void> {
  // nothing to sign out of on an unsupported platform
}