// RideFollow V2 social layer, re-spoken in JS: the `/v2` HTTP endpoints, the
// wire formats of the retained `area/…` and `rooms/…` topics, and plain-text
// renderers for them. Mirrors cloud/api/social_api.py (HTTP),
// cloud/api/social.py (payloads) and lib/social/social_models.dart (decoding).
//
// Everything here needs a *rider* account (the same broker credentials the app
// signs in with); share-link followers stay on the V1 token path in api.js.

import * as geohash from './geohash.js';

export class SocialError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SocialError';
    this.status = status;
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * A `/v2` client authenticated as a rider (HTTP Basic, like the app).
 * @param {{ apiBase: string, user: string, password: string, fetchImpl?: typeof fetch }} o
 */
export function socialClient({ apiBase, user, password, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  async function call(method, path, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        signal: ac.signal,
        headers: {
          accept: 'application/json',
          authorization: auth,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new SocialError('the server took too long to respond', 0);
      throw new SocialError(`could not reach the RideFollow server (${err.code || err.message})`, 0);
    } finally {
      clearTimeout(timer);
    }
    let j = null;
    try {
      j = await res.json();
    } catch {
      /* empty / non-JSON body */
    }
    if (!res.ok) {
      const msg =
        res.status === 401
          ? 'wrong rider username or password — run `ridefollow-cli login`'
          : res.status === 404 && !(j && j.error)
            ? 'this server has no social (V2) features yet'
            : (j && j.error) || `request failed (${res.status})`;
      throw new SocialError(String(msg), res.status);
    }
    return j || {};
  }

  const code = (c) => encodeURIComponent(normalizeRoomCode(c));
  return {
    me: () => call('GET', '/v2/social/me'),
    area: (gh4) => call('GET', `/v2/areas/${encodeURIComponent(gh4)}`),
    createRoom: (name, displayName) => call('POST', '/v2/rooms', { name, displayName }),
    joinRoom: (c, displayName) => call('POST', `/v2/rooms/${code(c)}/join`, { displayName }),
    leaveRoom: (c) => call('POST', `/v2/rooms/${code(c)}/leave`, {}),
    getRoom: (c) => call('GET', `/v2/rooms/${code(c)}`),
    invites: () => call('GET', '/v2/invites'),
    redeemInvite: (c) => call('POST', '/v2/invites/redeem', { code: normalizeInviteCode(c) }),
  };
}

/** Room codes are said out loud — accept `abc-123`, ` ABC123 ` etc. */
export function normalizeRoomCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** An invite code, or a whole `…?invite=<code>` link. */
export function normalizeInviteCode(c) {
  const raw = String(c || '').trim();
  const m = raw.match(/[?&#]invite=([^&#\s]+)/);
  return (m ? decodeURIComponent(m[1]) : raw).trim().toLowerCase();
}

// ── Where: place names → a city cell ─────────────────────────────────────────

/**
 * Turn what the user typed into a 4-char city cell:
 *   `gh:u0nd` / `u0nd` with --cell   → that cell
 *   `45.07,7.68`                     → the cell around the point
 *   anything else                    → a place search (OpenStreetMap Nominatim)
 * Only the typed text leaves the machine — never anyone's position.
 */
export async function resolveArea(input, { fetchImpl = fetch, forceCell = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new SocialError('name a city or area, e.g. `ridefollow-cli nearby Turin`', 0);

  const cell = raw.replace(/^gh:/i, '').toLowerCase();
  if ((forceCell || /^gh:/i.test(raw)) && geohash.isGeohash(cell)) {
    if (cell.length < geohash.CITY) throw new SocialError(`"${cell}" is bigger than a city — use 4 characters`, 0);
    const gh4 = cell.slice(0, geohash.CITY);
    const [lat, lng] = geohash.center(gh4);
    return { gh4, name: gh4, detail: 'geohash cell', lat, lng };
  }

  const ll = raw.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = Number(ll[1]);
    const lng = Number(ll[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new SocialError('those coordinates are off the map', 0);
    return { gh4: geohash.encode(lat, lng, geohash.CITY), name: `${lat}, ${lng}`, detail: 'coordinates', lat, lng };
  }

  const places = await searchPlaces(raw, { fetchImpl });
  if (!places.length) throw new SocialError(`no place called "${raw}" — try a bigger city nearby`, 0);
  const p = places[0];
  return { ...p, gh4: geohash.encode(p.lat, p.lng, geohash.CITY) };
}

export async function searchPlaces(query, { fetchImpl = fetch } = {}) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '0' }).toString();
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'ridefollow-cli (+https://ridefollow.live)' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new SocialError(`place search failed (${err.code || err.message})`, 0);
  }
  if (!res.ok) throw new SocialError(`place search failed (${res.status})`, res.status);
  return parsePlaces(await res.json());
}

/** Parse a Nominatim `jsonv2` response (same rules as place_search.dart). */
export function parsePlaces(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const parts = String(item.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
    out.push({
      name: item.name || parts[0] || 'Unknown place',
      detail: parts.slice(1, 3).join(', '),
      lat,
      lng,
    });
  }
  return out;
}

// ── Wire formats (retained MQTT payloads) ────────────────────────────────────

const obj = (raw) => {
  try {
    const j = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);

/** `area/<gh4>/<gh6>/presence/<pid>` — a public rider, snapped to ~1 km. */
export function decodePresence(pid, raw) {
  const j = obj(raw);
  if (!j || num(j.lat) == null || num(j.lng) == null) return null;
  return {
    pid: str(j.pid, pid),
    name: str(j.name, 'Rider'),
    crew: str(j.crew),
    color: str(j.color),
    gh6: str(j.gh6),
    lat: j.lat,
    lng: j.lng,
    speedKmh: num(j.spd) ?? 0,
    sinceMs: num(j.since),
    tsMs: num(j.ts),
  };
}

/** `area/<gh4>/meta` (== GET /v2/areas/<gh4>) — the city leaderboard. */
export function decodeAreaMeta(raw) {
  const j = typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : obj(raw);
  if (!j) return null;
  const list = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : []);
  return {
    gh4: str(j.gh4),
    ridersNow: num(j.ridersNow) ?? 0,
    tiles: num(j.tiles) ?? 0,
    tsMs: num(j.ts),
    top: list(j.top).map((e) => ({
      pid: str(e.pid),
      name: str(e.name, 'Rider'),
      crew: str(e.crew),
      tiles: num(e.tiles) ?? 0,
    })),
    crews: list(j.crews).map((e) => ({ crew: str(e.crew), tiles: num(e.tiles) ?? 0 })),
  };
}

/** `area/<gh4>/feed` — the latest steals / loops in the city. */
export function decodeFeed(raw) {
  const j = obj(raw);
  if (!Array.isArray(j)) return [];
  return j
    .filter((e) => e && typeof e.type === 'string')
    .map((e) => ({
      type: e.type,
      byName: str(e.by && e.by.name, 'Rider'),
      fromName: str(e.from && e.from.name),
      tiles: num(e.tiles) ?? 0,
      tsMs: num(e.ts),
    }));
}

export function feedText(e) {
  if (e.type === 'loop') return `${e.byName} closed a loop and captured ${e.tiles} tiles`;
  return `${e.byName} took ${e.tiles} tile${e.tiles === 1 ? '' : 's'} from ${e.fromName || 'someone'}`;
}

/** `social/<me>/inbox` — my private events, newest first. */
export function decodeInbox(raw) {
  const j = obj(raw);
  if (!Array.isArray(j)) return [];
  return j
    .filter((e) => e && typeof e.type === 'string')
    .map((e) => ({
      type: e.type,
      withName: str(e.with && e.with.name, 'a rider'),
      byName: str(e.by && e.by.name, 'Someone'),
      tiles: num(e.tiles) ?? 0,
      gh4: str(e.gh4),
      gh6: str(e.gh6),
      tsMs: num(e.ts),
    }));
}

export function inboxText(e) {
  switch (e.type) {
    case 'encounter':
      return `you crossed paths with ${e.withName}${e.gh6 ? ` (near cell ${e.gh6})` : ''}`;
    case 'stolen':
      return `${e.byName} took ${e.tiles} of your tile${e.tiles === 1 ? '' : 's'}${e.gh4 ? ` in ${e.gh4}` : ''}`;
    case 'invite':
      return `${e.withName} joined RideFollow with your invite 🎉`;
    default:
      return e.type;
  }
}

export function renderInbox(events, now = Date.now()) {
  if (!events.length) return ['INBOX', '  nothing yet — encounters, stolen tiles and friends joining show up here'];
  return ['INBOX', ...events.map((e) => `  ${pad(ago(e.tsMs, now), 4)} ${inboxText(e)}`)];
}

/** `rooms/<code>/presence/<pid>` — a group member's precise position. */
export function decodeRoomPosition(pid, raw) {
  const j = obj(raw);
  if (!j || num(j.lat) == null || num(j.lng) == null || num(j.ts) == null) return null;
  return { pid, name: str(j.name, 'Rider'), lat: j.lat, lng: j.lng, speedKmh: num(j.spd) ?? 0, tsMs: j.ts };
}

/** `rooms/<code>/pin` — the group's meeting point. */
export function decodePin(raw) {
  const j = obj(raw);
  if (!j || num(j.lat) == null || num(j.lng) == null) return null;
  return { lat: j.lat, lng: j.lng, byName: str(j.by) };
}

// ── Plain-text views (pure: state in, lines out) ─────────────────────────────

export function ago(ms, now = Date.now()) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function formatKm(m) {
  if (m == null) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

const pad = (s, n) => {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
};

/** The `nearby` screen: who's riding in a city right now, plus its board. */
export function renderNearby({ place, riders, meta, feed, now = Date.now() }) {
  const out = [];
  const title = place ? `${place.name}${place.detail ? ` · ${place.detail}` : ''}` : '';
  out.push(`RIDING NOW · ${title} (cell ${place ? place.gh4 : '?'})`);
  const list = [...riders.values()].sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
  if (!list.length) {
    out.push('  nobody is riding here publicly right now');
  } else {
    for (const r of list) {
      const d = place ? geohash.distanceM(place.lat, place.lng, r.lat, r.lng) : null;
      const crew = r.crew ? `[${r.crew}]` : '';
      out.push(
        `  ● ${pad(r.name, 18)} ${pad(crew, 12)} ~${String(r.speedKmh).padStart(2)} km/h  ` +
          `${pad(formatKm(d), 8)} from centre · riding ${ago(r.sinceMs, now)}`,
      );
    }
  }
  if (meta) {
    out.push('');
    // The board is refreshed every few minutes; the live list is fresher.
    out.push(...renderBoard({ ...meta, ridersNow: Math.max(meta.ridersNow, riders.size) }, { heading: false }));
  }
  if (feed && feed.length) {
    out.push('');
    out.push('LATEST');
    // The server keeps feeds newest-first.
    for (const e of feed.slice(0, 5)) out.push(`  ${pad(ago(e.tsMs, now), 4)} ${feedText(e)}`);
  }
  return out;
}

/** The city leaderboard (`area` command, and under `nearby`). */
export function renderBoard(meta, { heading = true, place } = {}) {
  const out = [];
  if (heading) {
    const where = place ? `${place.name}${place.detail ? ` · ${place.detail}` : ''} (cell ${meta.gh4})` : `cell ${meta.gh4}`;
    out.push(`LAND · ${where}`);
  }
  out.push(`  ${meta.ridersNow} riding now · ${meta.tiles} tiles held`);
  if (!meta.top.length) {
    out.push('  no land claimed here yet — ride a loop to take the first tiles');
    return out;
  }
  out.push('  TOP RIDERS');
  meta.top.forEach((e, i) => {
    const crew = e.crew ? ` [${e.crew}]` : '';
    out.push(`  ${String(i + 1).padStart(2)}. ${pad(e.name + crew, 30)} ${String(e.tiles).padStart(5)} tiles`);
  });
  if (meta.crews.length) {
    out.push('  TOP CREWS');
    meta.crews.forEach((e, i) => out.push(`  ${String(i + 1).padStart(2)}. ${pad(e.crew, 30)} ${String(e.tiles).padStart(5)} tiles`));
  }
  return out;
}

/** The `room` views: members and where they are relative to the meeting point. */
export function renderRoom({ room, positions = new Map(), pin = null, now = Date.now() }) {
  const out = [];
  const left = room.expiresAt ? Math.max(0, room.expiresAt - now) : null;
  const leftTxt = left == null ? '' : ` · ends in ${Math.floor(left / 3600000)}h${String(Math.floor((left % 3600000) / 60000)).padStart(2, '0')}m`;
  out.push(`GROUP RIDE · ${room.name} · code ${formatRoomCode(room.code)}${leftTxt}`);
  if (pin) out.push(`  meeting point ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}${pin.byName ? ` (set by ${pin.byName})` : ''}`);
  const me = room.you && room.you.pid;
  for (const m of room.members || []) {
    const p = positions.get(m.pid);
    const tags = [m.owner ? 'host' : '', m.pid === me ? 'you' : ''].filter(Boolean).join(', ');
    let where = 'not riding';
    if (p) {
      const stale = now - p.tsMs > 120000;
      where = `${p.speedKmh.toFixed(0)} km/h · ${ago(p.tsMs, now)}${stale ? ' (stale)' : ''}`;
      if (pin) where += ` · ${formatKm(geohash.distanceM(p.lat, p.lng, pin.lat, pin.lng))} to meet`;
    }
    out.push(`  ${p ? '●' : '○'} ${pad(m.name + (tags ? ` (${tags})` : ''), 26)} ${where}`);
  }
  return out;
}

/** `ABC123` → `ABC-123`, easier to read out loud. */
export function formatRoomCode(c) {
  const s = normalizeRoomCode(c);
  return s.length === 6 ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}

/** The `me` view. */
export function renderMe({ me, invites }) {
  const out = [];
  const p = me.profile || {};
  const s = me.stats || {};
  out.push(`YOU · ${p.name || 'Rider'}${p.crew ? ` [${p.crew}]` : ''}`);
  out.push(`  public id   ${me.pid}`);
  out.push(`  visible     ${p.nearby ? 'yes — riders nearby can see you (snapped to ~1 km)' : 'no (turn on "Show me nearby" in the app)'}`);
  out.push(`  land        ${p.land ? 'on' : 'off'}${s.tiles != null ? ` · ${s.tiles} tiles held` : ''}`);
  const areas = Object.entries(s.areas || {}).sort((a, b) => b[1] - a[1]);
  if (areas.length) out.push(`  cities      ${areas.map(([gh, n]) => `${gh}: ${n}`).join(' · ')}`);
  out.push(`  riding      ${s.riding ? (s.visible ? 'yes (public)' : 'yes (private)') : 'no'}`);
  if (invites) {
    out.push(`  invites     ${invites.count} friend${invites.count === 1 ? '' : 's'} joined with your link`);
    out.push(`  your link   ${invites.link}`);
    if (invites.invitedBy) out.push(`  invited by  ${invites.invitedBy}`);
  }
  if (me.brokerConnected === false) out.push('  (the server\'s social engine is offline — data may be stale)');
  return out;
}
