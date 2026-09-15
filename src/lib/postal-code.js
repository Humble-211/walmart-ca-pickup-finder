const POSTAL = /^([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)$/;

// Returns "A1A 1A1" form or null.
export function normalizePostalCode(input) {
  const m = String(input ?? "").trim().match(POSTAL);
  if (!m) return null;
  return `${m[1]} ${m[2]}`.toUpperCase();
}
