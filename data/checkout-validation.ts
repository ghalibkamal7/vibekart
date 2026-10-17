export type CheckoutDetails = {
  name: string;
  phone: string;
  address: string;
};

export type CheckoutValidationErrors = Partial<Record<keyof CheckoutDetails, string>>;
export type ProductRequestAddress = {
  houseDetails: string;
  roadArea: string;
  pincode: string;
  city: string;
  state: string;
};
export type ProductRequestValidationErrors = Partial<Record<keyof ProductRequestAddress | 'name' | 'phone', string>>;

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

function validateAddressText(value: string, minLength: number, maxLength: number): boolean {
  const text = value.trim();
  return text.length >= minLength &&
    text.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(text) &&
    /[\p{L}\p{N}]/u.test(text) &&
    text.replace(/[ .,'’()/#-]/g, '').length >= 2 &&
    /^[\p{L}\p{M}\p{N} .,'’()/#-]+$/u.test(text);
}

function validatePlaceName(value: string): boolean {
  const text = value.trim();
  return text.length >= 2 &&
    text.length <= 80 &&
    [...text].filter((character) => /\p{L}/u.test(character)).length >= 2 &&
    /^[\p{L}\p{M} .'-]+$/u.test(text);
}

export function validateProductRequestDetails(input: {
  name: string;
  phone: string;
  address: ProductRequestAddress;
}): ProductRequestValidationErrors {
  const errors: ProductRequestValidationErrors = {};
  const nameError = validateCheckoutName(input.name);
  const phoneError = validateCheckoutPhone(input.phone);
  if (nameError) errors.name = nameError;
  if (phoneError) errors.phone = phoneError;
  if (!validateAddressText(input.address.houseDetails, 2, 160)) {
    errors.houseDetails = 'Enter valid house or building details.';
  }
  if (!validateAddressText(input.address.roadArea, 2, 160)) {
    errors.roadArea = 'Enter a valid road, area, or colony.';
  }
  if (!/^\d{6}$/.test(input.address.pincode.trim())) {
    errors.pincode = 'Enter a valid six-digit pincode.';
  }
  if (!validatePlaceName(input.address.city)) errors.city = 'Enter a valid city.';
  if (!validatePlaceName(input.address.state)) errors.state = 'Enter a valid state.';
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
