import { Auth, GoogleAuthProvider, signInWithCredential, User } from 'firebase/auth';

/**
 * iOS / Android: the native Google Sign-In SDK, via
 * @react-native-google-signin/google-signin. This is a native module — it
 * CANNOT run inside Expo Go; it needs a development build (see README.md,
 * "Google Sign-In on iOS/Android"). Expo itself stopped maintaining a
 * browser-based Google OAuth helper as of SDK 53, so this is the supported
 * route on native.
 *
 * The module is loaded lazily (a require() inside the function, not a
 * top-level import) on purpose: in Expo Go the native side isn't linked,
 * and a top-level import would throw while the app is still booting —
 * i.e. a startup crash. Lazy loading turns that into a normal, catchable
 * error shown only when someone actually taps the button.
 */

type GoogleSigninModule = typeof import('@react-native-google-signin/google-signin');

// Result shape differs between library majors (v12 returned the user
// object directly, v13+ returns { type, data }). Read both defensively.
type SignInResultShape = {
  type?: string;
  data?: { idToken?: string | null } | null;
  idToken?: string | null;
};

// OAuth client IDs are public identifiers (not secrets). This must be the
// project's *Web* client ID — the native SDK only returns an ID token that
// Firebase can accept when it's configured with the web client.
const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

let configured = false;

function googleError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function requireGoogleSignin(): GoogleSigninModule {
  return require('@react-native-google-signin/google-signin') as GoogleSigninModule;
}

export async function performGoogleSignIn(auth: Auth): Promise<User> {
  if (!WEB_CLIENT_ID) {
    throw googleError(
      'google/not-configured',
      'Google Sign-In is not configured. See .env.example (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).',
    );
  }

  let mod: GoogleSigninModule;
  try {
    mod = requireGoogleSignin();
  } catch (error) {
    console.warn('[auth] native Google Sign-In module is unavailable', error);
    throw googleError(
      'google/needs-dev-build',
      'Google Sign-In needs a development build of the app — it cannot run in Expo Go.',
    );
  }

  const { GoogleSignin, statusCodes } = mod;
  if (!configured) {
    GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
    configured = true;
  }

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = (await GoogleSignin.signIn()) as unknown as SignInResultShape;

    if (result.type === 'cancelled') {
      throw googleError('google/cancelled', 'Google sign-in was cancelled.');
    }
    const idToken = result.data?.idToken ?? result.idToken;
    if (!idToken) {
      throw googleError(
        'google/no-id-token',
        "Google didn't return an ID token. Check that EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is the project's Web client ID.",
      );
    }

    const credential = GoogleAuthProvider.credential(idToken);
    const userCredential = await signInWithCredential(auth, credential);
    return userCredential.user;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === statusCodes.SIGN_IN_CANCELLED) {
      throw googleError('google/cancelled', 'Google sign-in was cancelled.');
    }
    if (code === statusCodes.IN_PROGRESS) {
      throw googleError('google/in-progress', 'A Google sign-in is already in progress.');
    }
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw googleError(
        'google/play-services-unavailable',
        'Google Play Services is unavailable or out of date on this device.',
      );
    }
    throw error;
  }
}

/** Clears the native Google session too, so the next sign-in shows the
 * account chooser instead of silently reusing the last account. Never
 * throws — a missing module (Expo Go) or "not signed in" is fine here. */
export async function signOutOfGoogle(): Promise<void> {
  try {
    const { GoogleSignin } = requireGoogleSignin();
    await GoogleSignin.signOut();
  } catch {
    // nothing to sign out of, or the native module isn't available
  }
}