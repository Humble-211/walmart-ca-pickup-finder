// Locates a Canadian postal code by the centroid of its forward sortation area
// (first three characters), from the bundled GeoNames table (CC BY 4.0). Urban FSAs
// are a few km across; rural ones (second character 0) can be 100+ km. Used by
// retailers whose store endpoints take coordinates only (Shoppers Drug Mart).
import table from "./fsa-ca.json";

// Returns { lat, lon } for "M5V 3L9" / "m5v3l9" / "M5V", or null when the FSA is unknown.
export function locatePostalCode(postalCode) {
  const fsa = String(postalCode ?? "").trim().slice(0, 3).toUpperCase();
  const c = table.fsa[fsa];
  return c ? { lat: c[0], lon: c[1] } : null;
}
