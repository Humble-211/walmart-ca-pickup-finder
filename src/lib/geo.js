// Great-circle distance and a small trilateration helper. All distances in km.
const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Estimates the user's position from stores whose coordinates are known and whose
// distance to the user walmart reported. Least-squares (Gauss-Newton) on a local
// flat projection around the nearest store. Returns {lat, lon} or null.
export function locateUser(stores, coordsById) {
  const pts = [];
  for (const s of stores) {
    const c = coordsById.get(s.id);
    if (c && Number.isFinite(s.distanceKm)) pts.push({ lat: c.lat, lon: c.lon, d: s.distanceKm });
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a.d - b.d);
  const origin = pts[0];
  if (pts.length === 1) return { lat: origin.lat, lon: origin.lon };

  const kmPerLat = (Math.PI / 180) * EARTH_KM;
  const kmPerLon = kmPerLat * Math.cos(toRad(origin.lat));
  const proj = pts.map((p) => ({ x: (p.lon - origin.lon) * kmPerLon, y: (p.lat - origin.lat) * kmPerLat, d: p.d }));
  // Start slightly off the nearest store so the first Jacobian is defined.
  let x = 0.01, y = 0.01;
  for (let iter = 0; iter < 30; iter++) {
    let a = 0, b = 0, c = 0, gx = 0, gy = 0; // normal equations J^T J and J^T r
    for (const p of proj) {
      const dx = x - p.x, dy = y - p.y;
      const r = Math.hypot(dx, dy) || 1e-9;
      const jx = dx / r, jy = dy / r, res = r - p.d;
      a += jx * jx; b += jx * jy; c += jy * jy; gx += jx * res; gy += jy * res;
    }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    const sx = (c * gx - b * gy) / det, sy = (a * gy - b * gx) / det;
    x -= sx; y -= sy;
    if (Math.hypot(sx, sy) < 1e-4) break;
  }
  return { lat: origin.lat + y / kmPerLat, lon: origin.lon + x / kmPerLon };
}
