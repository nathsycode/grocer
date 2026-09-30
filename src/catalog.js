// Synthetic catalogue and size/money helpers for the local rehearsal slice.
//
// This is rehearsal data only. It is not the Landmark catalogue, contains no
// account/session data, and no code in this repository calls a retailer.

export const CURRENCY = { code: 'PHP', minorUnit: 2 };

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i;

/** Parse "150g", "1 kg", "500 ml" into a normalised size or null. */
export function parseSize(text) {
  const m = String(text ?? '').match(SIZE_RE);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'kg') return canonicalSize(n * 1000, 'mass');
  if (unit === 'g') return canonicalSize(n, 'mass');
  if (unit === 'l') return canonicalSize(n * 1000, 'volume');
  return canonicalSize(n, 'volume');
}

/** Build a size from a base-unit value (grams or millilitres). */
export function canonicalSize(value, dim) {
  if (dim !== 'mass' && dim !== 'volume') throw new Error(`unknown size dimension: ${dim}`);
  return { value, dim, display: formatSize(value, dim) };
}

export function formatSize(value, dim) {
  const bigUnit = dim === 'mass' ? 'kg' : 'L';
  const smallUnit = dim === 'mass' ? 'g' : 'ml';
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000} ${bigUnit}`;
  return `${value} ${smallUnit}`;
}

/** Two sizes are equivalent only within the same dimension in base units. */
export function sizeEquals(a, b) {
  return Boolean(a && b) && a.dim === b.dim && a.value === b.value;
}

export function formatMoney(minor, currency = CURRENCY) {
  return `${currency.code} ${(minor / 10 ** currency.minorUnit).toFixed(currency.minorUnit)}`;
}

const p = (id, brand, name, variant, value, dim, priceMinor, extra = {}) => ({
  id,
  brand,
  name,
  variant,
  size: canonicalSize(value, dim),
  priceMinor,
  currency: CURRENCY,
  evidenceConflict: false,
  ...extra,
});

export const CATALOG = [
  p('hl-beef-150g', 'Highlands', 'Corned Beef', 'Classic', 150, 'mass', 4690),
  p('hl-beef-260g', 'Highlands', 'Corned Beef', 'Classic', 260, 'mass', 7590),
  p('cdo-beef-150g', 'CDO', 'Corned Beef', 'Classic', 150, 'mass', 4250),
  p('pr-fusilli-500g', 'Pasta Roma', 'Fusilli', null, 500, 'mass', 8900),
  p('pr-fusilli-1kg', 'Pasta Roma', 'Fusilli', null, 1000, 'mass', 16500),
  p('arla-milk-1l', 'Arla', 'Full Cream Milk', null, 1000, 'volume', 12500),
  p('arla-milk-500ml', 'Arla', 'Full Cream Milk', null, 500, 'volume', 6800),
  p('tulip-luncheon-150g', 'Tulip', 'Luncheon Meat', null, 150, 'mass', 3990),
  p('spam-luncheon-150g', 'Spam', 'Luncheon Meat', null, 150, 'mass', 4990),
  // Deliberately contradictory evidence, used to demonstrate the fail-closed gate.
  p('conflict-beef-150g', 'Highlands', 'Corned Beef', 'Contradictory', 150, 'mass', 4690, {
    evidenceConflict: true,
    evidenceNote: 'Catalogue title says 150 g but a size attribute says 260 g; unresolved.',
  }),
  // Unrelated pre-existing content used by the demo cart.
  p('mccormick-seasoning-200g', 'McCormick', 'Italian Seasoning', null, 200, 'mass', 46900),
];

export function productById(id, catalog = CATALOG) {
  return catalog.find((prod) => prod.id === id) ?? null;
}

/** Public (JSON-safe) view of a catalogue product. */
export function productView(prod) {
  return {
    id: prod.id,
    brand: prod.brand,
    name: prod.name,
    variant: prod.variant,
    size: prod.size,
    sizeDisplay: prod.size.display,
    priceMinor: prod.priceMinor,
    priceDisplay: formatMoney(prod.priceMinor, prod.currency),
    currency: prod.currency.code,
    evidenceConflict: Boolean(prod.evidenceConflict),
    evidenceNote: prod.evidenceNote ?? null,
  };
}
