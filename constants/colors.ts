/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#182322',
    tint: '#F26A4F',

    // Core surfaces
    background: '#FFF9F2',
    foreground: '#182322',

    // Cards / elevated surfaces
    card: '#FFFFFF',
    cardForeground: '#182322',

    // Primary action color (buttons, links, active states)
    primary: '#F26A4F',
    primaryForeground: '#ffffff',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#F1E8DD',
    secondaryForeground: '#315A51',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#F4EEE7',
    mutedForeground: '#7D8881',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#DDEBE1',
    accentForeground: '#315A51',

    // Destructive actions (delete, error states)
    destructive: '#D95555',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#E8DDD0',
    input: '#E8DDD0',

    // VibeKart brand accents
    coral: '#F26A4F',
    coralSoft: '#FFE4DA',
    moss: '#315A51',
    mossSoft: '#DDEBE1',
    butter: '#F8CE6A',
    inkSoft: '#53615C',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
