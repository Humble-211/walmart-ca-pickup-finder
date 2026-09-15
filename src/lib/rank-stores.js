// Ascending by distance; unknown distances last. Array.prototype.sort is stable.
export function rankStores(stores) {
  const key = (s) => (s.distanceKm == null ? Number.POSITIVE_INFINITY : s.distanceKm);
  return [...stores].sort((a, b) => key(a) - key(b));
}
