import type { OrderStatus } from './store';

const CUSTOMER_ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  Placed: 'Placed',
  Confirmed: 'Confirmed',
  Processing: 'Processing',
  New: 'Request received',
  'Ordered on Meesho': 'Processing',
  Shipped: 'Shipped',
  Delivered: 'Delivered',
  Cancelled: 'Cancelled',
};

export function getCustomerOrderStatusLabel(status: OrderStatus): string {
  return CUSTOMER_ORDER_STATUS_LABELS[status];
}

export const PRODUCT_REQUEST_RECEIVED_TITLE = 'Request received';
export const PRODUCT_REQUEST_RECEIVED_MESSAGE =
  'Your product request has been submitted successfully. We will contact you using the mobile number provided. Your request is currently being reviewed.';
export const PRODUCT_REQUEST_STATUS_DESCRIPTION =
  'This is a product request only. Your request is being reviewed. No payment has been taken.';
