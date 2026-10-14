import { Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Cloudinary holds product images; Firebase Auth + Firestore still own
 * everything else (users, products metadata, orders, etc.) — see
 * services/firebase/.
 *
 * WHY UNSIGNED UPLOADS: this project intentionally stays on Firebase's free
 * Spark plan, which cannot run Cloud Functions at all (any Cloud Function —
 * 1st or 2nd gen — requires the Blaze plan, regardless of whether it uses
 * Secret Manager). That ruled out the earlier design (a Cloud Function
 * signing each upload with a server-held API secret). Cloudinary's unsigned
 * upload presets are the supported alternative: the client uploads directly
 * to Cloudinary using only the cloud name and a preset name, both of which
 * are meant to be public (same trust model as Firebase's client config) —
 * see README.md for the exact dashboard settings this preset needs.
 *
 * TRADE-OFF (read this before changing the preset): an unsigned preset
 * cannot check who's calling it — Cloudinary has no idea about Firebase
 * Auth or this app's "seller" role. Anyone who extracts the cloud name and
 * preset name from the app bundle (they're not secret, just unlisted) could
 * upload images to this Cloudinary account. The mitigations available
 * without a server are all on the preset itself: restrict format/size/
 * dimensions, disable unrelated resource types, and treat the account as
 * "images only, moderate storage cost" rather than something holding
 * sensitive data. This is an accepted trade-off of not running Blaze, not
 * an oversight — see README.md's "Known limitations" section.
 */

const CLOUDINARY_CLOUD_NAME = (process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME ?? '').trim();
const CLOUDINARY_UPLOAD_PRESET = (process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? '').trim();

export const isCloudinaryConfigured = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_UPLOAD_PRESET);

export type CloudinaryUploadResult = { url: string; publicId: string };

/** Downscales + recompresses before upload so a seller's 12MP photo doesn't
 * burn bandwidth/storage for a product thumbnail. Falls back to the
 * original file if manipulation fails for any reason — a slightly larger
 * upload beats a blocked one. */
async function prepareForUpload(localUri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: 1600 } }],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG },
    );
    return result.uri;
  } catch {
    return localUri;
  }
}

/**
 * Uploads one local image (from expo-image-picker's `uri`) to Cloudinary
 * under the given folder (e.g. `vibekart/products/{productId}`) and returns
 * its secure URL + public ID. `onProgress` (0-100) is driven by real upload
 * bytes via XMLHttpRequest.
 *
 * Supports both React Native native (via URI object) and React Native Web
 * (via Blob conversion so browser FormData does not serialize to [object Object]).
 */
export async function uploadImageToCloudinary(
  localUri: string,
  folder: string,
  onProgress?: (percent: number) => void,
): Promise<CloudinaryUploadResult> {
  if (!CLOUDINARY_CLOUD_NAME) {
    throw new Error('Cloudinary cloud name is not configured (EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME).');
  }
  if (!CLOUDINARY_UPLOAD_PRESET) {
    throw new Error('Cloudinary unsigned upload preset is not configured (EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET).');
  }

  const optimizedUri = await prepareForUpload(localUri);
  const fileName = `vk-${Date.now()}.jpg`;

  const formData = new FormData();
  if (Platform.OS === 'web') {
    // In browser JS, passing {uri,type,name} to FormData stringifies to "[object Object]"
    // which Cloudinary rejects. Convert to real Blob for web uploads.
    try {
      const response = await fetch(optimizedUri);
      const blob = await response.blob();
      formData.append('file', blob, fileName);
    } catch {
      // Fallback if fetch fails on local file object
      formData.append('file', optimizedUri);
    }
  } else {
    // React Native's fetch/XHR polyfill recognizes {uri,type,name}
    formData.append('file', { uri: optimizedUri, type: 'image/jpeg', name: fileName } as unknown as Blob);
  }

  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  formData.append('folder', folder);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
          resolve({ url: data.secure_url as string, publicId: data.public_id as string });
        } else {
          const rawMessage = data?.error?.message ?? `Upload failed (HTTP ${xhr.status})`;
          if (rawMessage.toLowerCase().includes('upload preset')) {
            reject(new Error(`Cloudinary preset error: "${CLOUDINARY_UPLOAD_PRESET}" must exist and be set to Unsigned in Cloudinary Settings -> Upload.`));
          } else {
            reject(new Error(rawMessage));
          }
        }
      } catch {
        reject(new Error(`Cloudinary returned an invalid response (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during image upload. Check internet connection.'));
    xhr.send(formData);
  });
}

/**
 * There is no client-side equivalent of this anymore. Deleting a Cloudinary
 * asset requires a signed Admin API call (Cloudinary has no "unsigned
 * delete" — that's deliberate on their end, to stop exactly the kind of
 * anonymous abuse an unsigned preset would otherwise allow), which means it
 * needs a secret held somewhere other than this app. With Cloud Functions
 * off the table (Spark plan), there is nowhere in this project's current
 * architecture to hold that secret.
 *
 * What this means in practice: removing an image from a product, or
 * deleting a product outright, still removes it from Firestore
 * (imageUrls/imagePublicIds) immediately — the app stops showing it right
 * away — but the underlying file stays in Cloudinary storage until cleaned
 * up separately. See scripts/cloudinary-cleanup.js and README.md for a
 * manual, local-only cleanup option that never ships the secret in the app.
 */