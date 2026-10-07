/**
 * App-wide tunables that aren't design tokens (those live in constants/colors.ts)
 * and aren't secrets (those live in .env). Keep this the single place to bump
 * limits like MAX_PRODUCT_IMAGES rather than hard-coding them at each call site.
 */

/** Maximum number of images a seller can attach to one product. Raise this
 * number alone (e.g. to 15 or 20) to change the limit everywhere it's used —
 * the picker, the upload flow, and the gallery all read from here. */
export const MAX_PRODUCT_IMAGES = 10;
