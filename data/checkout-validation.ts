export type CheckoutDetails = {
  name: string;
  phone: string;
  address: string;
};

export type CheckoutValidationErrors = Partial<Record<keyof CheckoutDetails, string>>;

export function validateCheckoutName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Enter your full name.';
  if (name.length > 120 || !/^[\p{L}\p{M}]+(?:[ .'’-][\p{L}\p{M}]+)*$/u.test(name)) {
    return 'Enter a valid name using letters only.';
  }
  if ([...name].filter((character) => /\p{L}/u.test(character)).length < 2) {
    return 'Enter at least two letters for your name.';
  }
  return null;
}

export function normalizeIndianMobile(value: string): string | null {
  const phone = value.trim();
  if (!phone || !/^\+?[\d\s().-]+$/.test(phone)) return null;

  let digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function validateCheckoutPhone(value: string): string | null {
  return normalizeIndianMobile(value) ? null : 'Enter a valid 10-digit Indian mobile number.';
}

export function validateCheckoutAddress(value: string): string | null {
  const address = value.trim();
  if (!address) return 'Enter your delivery address.';
  if (
    address.length < 10 ||
    address.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(address) ||
    address.split(/\s+/).filter(Boolean).length < 2
  ) {
    return 'Enter a complete delivery address with locality or city.';
  }
  return null;
}

export function validateCheckoutDetails(details: CheckoutDetails): CheckoutValidationErrors {
  const errors: CheckoutValidationErrors = {};
  const nameError = validateCheckoutName(details.name);
  const phoneError = validateCheckoutPhone(details.phone);
  const addressError = validateCheckoutAddress(details.address);
  if (nameError) errors.name = nameError;
  if (phoneError) errors.phone = phoneError;
  if (addressError) errors.address = addressError;
  return errors;
}

export function buildUpiPaymentUri(vpa: string, merchantName: string, amount?: number): string {
  const cleanVpa = vpa.trim();
  const cleanName = merchantName.trim();
  if (!cleanVpa || !cleanName) return '';
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) return '';

  const params = new URLSearchParams({
    pa: cleanVpa,
    pn: cleanName,
    cu: 'INR',
  });
  if (amount !== undefined) params.set('am', amount.toFixed(2));
  return `upi://pay?${params.toString()}`;
}
