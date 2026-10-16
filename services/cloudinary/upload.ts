import { Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { auth } from '@/services/firebase/config';

const WORKER_URL = (process.env.EXPO_PUBLIC_OTP_WORKER_URL ?? '').replace(/\/+$/, '');

export const isCloudinaryConfigured = Boolean(WORKER_URL);

export type CloudinaryUploadResult = { url: string; publicId: string };
export type CloudinaryAssetScope =
  | { type: 'product'; targetId: string }
  | { type: 'payment-qr'; targetId: 'settings/payment' };

type WorkerResult = {
  success?: boolean;
  url?: string;
  publicId?: string;
  cleanupPending?: boolean;
  error?: string;
};

async function getWorkerAuthorization(): Promise<string> {
  if (!WORKER_URL) throw new Error('The Cloudinary upload service is not configured (EXPO_PUBLIC_OTP_WORKER_URL).');
  const user = auth?.currentUser;
  if (!user) throw new Error('Sign in before uploading Cloudinary images.');
  return `Bearer ${await user.getIdToken()}`;
}

async function postWorker<T extends WorkerResult>(path: string, body: object): Promise<T> {
  const authorization = await getWorkerAuthorization();
  const response = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(result?.error || `Image service request failed (HTTP ${response.status}).`);
  if (!result?.success) throw new Error(result?.error || 'Image service returned an invalid response.');
  return result;
}

/** Downscale and recompress selected images before sending them through the authenticated Worker. */
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

export async function uploadImageToCloudinary(
  localUri: string,
  scope: CloudinaryAssetScope,
  onProgress?: (percent: number) => void,
): Promise<CloudinaryUploadResult> {
  const authorization = await getWorkerAuthorization();
  const optimizedUri = await prepareForUpload(localUri);
  const formData = new FormData();
  if (Platform.OS === 'web') {
    const response = await fetch(optimizedUri);
    if (!response.ok) throw new Error('Could not read the selected image.');
    formData.append('file', await response.blob(), `vibekart-${Date.now()}.jpg`);
  } else {
    formData.append('file', {
      uri: optimizedUri,
      type: 'image/jpeg',
      name: `vibekart-${Date.now()}.jpg`,
    } as unknown as Blob);
  }
  formData.append('assetType', scope.type);
  formData.append('targetId', scope.targetId);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${WORKER_URL}/cloudinary/upload`);
    xhr.setRequestHeader('Authorization', authorization);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      let result: WorkerResult | null = null;
      try {
        result = JSON.parse(xhr.responseText) as WorkerResult;
      } catch {
        reject(new Error(`Image service returned an invalid response (HTTP ${xhr.status}).`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && result?.success && result.url && result.publicId) {
        resolve({ url: result.url, publicId: result.publicId });
      } else {
        reject(new Error(result?.error || `Image upload failed (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during image upload. Check your connection and retry.'));
    xhr.send(formData);
  });
}

export async function updateProductImagesViaWorker(
  productId: string,
  imageUrls: string[],
  imagePublicIds: string[],
  removedPublicIds: string[] = [],
): Promise<{ cleanupPending: boolean }> {
  const result = await postWorker('/seller/products/images', {
    productId,
    imageUrls,
    imagePublicIds,
    removedPublicIds,
  });
  return { cleanupPending: result.cleanupPending === true };
}

export async function updatePaymentQrViaWorker(
  imageUrl: string,
  imagePublicId: string,
): Promise<{ cleanupPending: boolean }> {
  const result = await postWorker('/admin/payment-settings/qr-image', { imageUrl, imagePublicId });
  return { cleanupPending: result.cleanupPending === true };
}

export async function cleanupCloudinaryAssetsViaWorker(
  scope: CloudinaryAssetScope,
  publicIds: string[],
): Promise<void> {
  await postWorker('/cloudinary/cleanup', {
    assetType: scope.type,
    targetId: scope.targetId,
    publicIds,
  });
}
