import {
  Auth,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  signInWithPopup,
  User,
} from 'firebase/auth';

/**
 * Web: Firebase's own popup OAuth flow — no extra package needed, the
 * `firebase` SDK this app already depends on handles it. Requires the
 * Google provider to be enabled in Firebase Console → Authentication →
 * Sign-in method, and the page's domain to be in the project's authorised
 * domains list (localhost is authorised by default).
 *
 * browserPopupRedirectResolver is passed explicitly on purpose: this app
 * creates its Auth with initializeAuth() (see config.ts — it needs a
 * per-platform persistence), and unlike getAuth(), initializeAuth() does
 * NOT include a popup/redirect resolver. Without it, signInWithPopup throws
 * `auth/argument-error` before any popup opens. Passing it per call is the
 * pattern Firebase documents for exactly this case.
 */
export async function performGoogleSignIn(auth: Auth): Promise<User> {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser, so signing in again after a logout
  // doesn't silently reuse the previous Google account.
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  return result.user;
}

export async function signOutOfGoogle(): Promise<void> {
  // Nothing to do on web — Firebase's signOut() clears the session, and
  // prompt: 'select_account' above means the next sign-in re-asks.
}