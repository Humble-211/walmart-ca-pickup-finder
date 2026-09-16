// "2026-09-22T09:00:00" / "2026-09-16T23:59:00Z" -> "Sep 22"; null for anything unparsable.
// Dates without a zone are read as local time; the site's day is what matters, not the hour.
export function shortDate(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

// "Sep 17" / "Sep 17 – Sep 22" for a delivery window; null when neither end parses.
export function dateRange(fromIso, toIso) {
  const a = shortDate(fromIso), b = shortDate(toIso);
  if (!a && !b) return null;
  if (!a || !b || a === b) return a ?? b;
  return `${a} – ${b}`;
}
