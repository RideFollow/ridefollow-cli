// Geohash cells — the "where" of the RideFollow V2 social layer. Every extra
// character narrows the cell and a cell's hash prefixes every cell inside it,
// so the MQTT topic tree (`area/<gh4>/<gh6>/...`) answers "everything in this
// city" with a plain wildcard. Mirrors cloud/api/geocell.py and
// lib/social/geohash.dart — the encodings must match exactly.
//
//   4 chars  ~39 x 20 km   a city / metro area   (search + leaderboard)
//   6 chars  ~1.2 x 0.6 km a district            (public presence)
//   7 chars  ~150 x 150 m  a tile                (territory / "land")

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/;

export const CITY = 4;
export const DISTRICT = 6;
export const TILE = 7;

export function isGeohash(value, length) {
  if (typeof value !== 'string' || !GEOHASH_RE.test(value)) return false;
  return length == null || value.length === length;
}

export function encode(lat, lng, precision) {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let out = '';
  let bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngLo = mid; } else { ch <<= 1; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
    }
    even = !even;
    if (++bit === 5) {
      out += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

/** [south, west, north, east] of a cell. */
export function bbox(gh) {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let even = true;
  for (const c of gh) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`not a geohash: ${gh}`);
    for (let b = 4; b >= 0; b--) {
      const on = (v >> b) & 1;
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (on) lngLo = mid; else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (on) latLo = mid; else latHi = mid;
      }
      even = !even;
    }
  }
  return [latLo, lngLo, latHi, lngHi];
}

export function center(gh) {
  const [s, w, n, e] = bbox(gh);
  return [(s + n) / 2, (w + e) / 2];
}

/** Great-circle distance in metres. */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
