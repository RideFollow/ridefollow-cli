// Unit + integration checks for the RideFollow terminal client. Pure Node — no
// broker needed (the live MQTT path is covered manually against a real broker).
// Run with: npm test
import http from 'node:http';
import assert from 'node:assert';

import { parseTarget, deriveApiBase } from '../src/link.js';
import { decodePayload, decodeSample } from '../src/telemetry.js';
import { Ui, formatDuration, formatAge, compass, compassLong, renderBig, bigWidth } from '../src/ui.js';
import { resolveRide, fetchHistory, fetchRoute } from '../src/api.js';
import * as geohash from '../src/geohash.js';
import {
  socialClient, resolveArea, parsePlaces, normalizeRoomCode, normalizeInviteCode, formatRoomCode,
  decodePresence, decodeAreaMeta, decodeFeed, decodeRoomPosition, decodePin, feedText, decodeInbox, inboxText, renderInbox,
  renderNearby, renderBoard, renderRoom, renderMe,
} from '../src/social.js';
import { brokerUrl, resolveAccount, configPath } from '../src/commands.js';

let pass = 0;
const ok = (name) => {
  pass++;
  console.log('  ✓', name);
};
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');
const stripAll = (s) => strip(s).replace(/\x1b\[[0-9]*[A-Za-z]/g, '');

console.log('link parsing');
{
  const a = parseTarget('https://ridefollow.live/?ride=abcDEF123456_-xyz');
  assert.equal(a.token, 'abcDEF123456_-xyz');
  assert.equal(a.apiBase, 'https://api.ridefollow.live:8443');
  assert.equal(a.shareHost, 'ridefollow.live');
  ok('full https share link');

  assert.equal(parseTarget('ridefollow.live/?ride=abcDEF123456_-xyz').apiBase, 'https://api.ridefollow.live:8443');
  ok('bare host + query (no scheme)');

  assert.equal(parseTarget('abcDEF123456_-xyz').token, 'abcDEF123456_-xyz');
  ok('bare token');

  assert.equal(parseTarget('"https://ridefollow.live/?ride=abcDEF123456_-xyz"').token, 'abcDEF123456_-xyz');
  ok('strips surrounding quotes');

  assert.equal(parseTarget('http://localhost/?ride=abcDEF123456_-xyz').apiBase, 'http://localhost:8443');
  ok('localhost -> http api');

  assert.equal(
    parseTarget('https://ridefollow.live/?ride=abcDEF123456_-xyz', { apiOverride: 'my.host:9000' }).apiBase,
    'https://my.host:9000',
  );
  ok('--api override wins');

  assert.equal(deriveApiBase('api.ridefollow.live'), 'https://api.ridefollow.live:8443');
  ok('api-prefixed host not double-prefixed');

  for (const bad of ['', 'https://ridefollow.live/', 'not a token!!', 'https://x.com/?ride=short']) {
    assert.throws(() => parseTarget(bad), `should reject: ${bad}`);
  }
  ok('rejects empty / missing / malformed tokens');
}

console.log('telemetry decode');
{
  const wire = { t: 3725, dist: 42.15, spd: 28.4, elev: 340.6, top: 51.2, paused: false, finished: false, lat: 45.07, lng: 7.68, hdg: 45, name: 'Ada', ts: 1_700_000_000_000 };
  const s = decodePayload(Buffer.from(JSON.stringify(wire)));
  assert.equal(s.elapsed, 3725);
  assert.equal(s.distance, 42.15);
  assert.equal(s.name, 'Ada');
  assert.equal(s.capturedAtMs, 1_700_000_000_000);
  ok('decodes the wire keys (t/dist/spd/elev/top/lat/lng/hdg/name/ts)');

  assert.equal(decodePayload(Buffer.from('not json')), null);
  ok('garbage payload -> null');

  const empty = decodeSample({});
  assert.equal(empty.elapsed, 0);
  assert.equal(empty.lat, null);
  ok('missing fields default safely');
}

console.log('formatting');
{
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatAge(2), 'just now');
  assert.equal(formatAge(45), '45s ago');
  assert.equal(formatAge(120), '2m ago');
  assert.equal(compass(45), 'NE');
  assert.equal(compass(0), 'N');
  assert.equal(compass(null), '—');
  assert.equal(compassLong(45), 'NORTH-EAST');
  assert.equal(compassLong(180), 'SOUTH');
  ok('duration / age / compass');
}

console.log('seven-segment digits');
{
  const rows = renderBig('35:00');
  assert.equal(rows.length, 3, 'three rows tall');
  assert.ok(rows.every((r) => r.length === rows[0].length), 'rows equal width');
  assert.ok(bigWidth('35:00') > bigWidth('35:00', true), 'compact is narrower than spaced');
  assert.ok(strip(rows.join('')).includes('_') && strip(rows.join('')).includes('|'), 'uses LCD strokes');
  ok('renderBig produces aligned 3-row glyphs');
}

const liveSnap = () => ({
  riderName: 'Ada Lovelace',
  subheader: 'TRACKING: ADA LOVELACE · SESSION #0417 · ROUTE: 42 KM',
  live: { kind: 'live', label: 'LIVE FEED' },
  status: { kind: 'live', label: 'CLIMBING' },
  heading: 'NORTH-EAST',
  sample: { elapsed: 2100, distance: 15.4, speed: 24.3, elevation: 340, topSpeed: 51.2, heading: 45, paused: false, finished: false, lat: 45.02, lng: 7.63 },
  etaSeconds: 65,
  progressPct: 37,
  routeTotalKm: 42,
  distanceKm: 15.4,
  events: [
    { stamp: '30:24', text: 'GPS FIX ACQUIRED', level: 'info' },
    { stamp: '33:36', text: 'CHECKPOINT · 15.0 KM', level: 'info' },
    { stamp: '34:24', text: 'CHEER SENT → ADA', level: 'hi' },
    { stamp: '35:00', text: 'SIGNAL LOST — RECONNECTING', level: 'warn' },
  ],
  ageSeconds: 2,
});

console.log('UI frame rendering');
{
  const out = [];
  const fakeTty = { isTTY: true, columns: 100, rows: 32, write: (s) => out.push(s), on() {}, removeListener() {} };
  const ui = new Ui({ stream: fakeTty, input: { isTTY: false } });
  ui.render(liveSnap());
  const bare = stripAll(out.join('')).split(/\r?\n/);
  const has = (sub) => bare.some((l) => l.includes(sub));

  assert.ok(has('RIDEFOLLOW') && has('TERMINAL') && has('//'), 'wordmark with brand //');
  assert.ok(has('LIVE FEED'), 'live indicator');
  assert.ok(has('SESSION #0417'), 'subheader');
  assert.ok(has('SPEED KM/H') && has('DISTANCE KM') && has('ELAPSED') && has('ETA') && has('TOP KM/H'), 'metric labels');
  assert.ok(has('STATUS') && has('CLIMBING'), 'status box');
  assert.ok(has('HEADING') && has('NORTH-EAST'), 'heading box');
  assert.ok(has('ROUTE PROGRESS') && has('37%'), 'route progress');
  assert.ok(has('KM 0 · START') && has('KM 42 · FINISH'), 'route endpoints');
  assert.ok(has('EVENT LOG') && has('GPS FIX ACQUIRED') && has('SIGNAL LOST'), 'event log lines');

  const tops = bare.filter((l) => l.includes('╭'));
  const bots = bare.filter((l) => l.includes('╰'));
  assert.ok(tops.length >= 3 && tops.length === bots.length, 'every box opened is closed (metric/status/progress/log)');
  for (const l of bare) assert.ok(l.length <= 100, `line within cols: "${l}"`);
  ok('full-screen frame: header, metric strip, status/progress, event log, boxes balanced');
}

console.log('UI non-TTY fallback');
{
  const out = [];
  const fake = { isTTY: false, write: (s) => out.push(s), on() {}, removeListener() {} };
  const ui = new Ui({ stream: fake, input: { isTTY: false } });
  ui.render({ ...liveSnap(), status: { kind: 'live', label: 'RIDING' } });
  const line = out.join('');
  assert.ok(line.includes('[RIDING]') && line.includes('(Ada Lovelace)'), 'compact line with status + rider');
  ok('pipes a one-line summary when not a TTY');
}

console.log('API client (mock server)');
{
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/ride/GOOD') {
      res.end(JSON.stringify({ rider: 'r-123', host: 'broker.example', tcpPort: 8883, wsPort: 8084, username: 'reader-x', password: 'pw', topic: 'riders/r-123/telemetry', cheersTopic: 'riders/r-123/cheers' }));
    } else if (req.url === '/v1/ride/GONE') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'ride link expired or invalid' }));
    } else if (req.url === '/v1/ride/GOOD/history') {
      res.end(JSON.stringify({ rider: 'r-123', samples: [{ t: 10, dist: 0.5, spd: 20, lat: 45.0, lng: 7.6, ts: 1700 }, { t: 20, dist: 1.0, spd: 24, lat: 45.01, lng: 7.61, ts: 1701 }], serverNowMs: 2000, latestAgeSeconds: 5.0 }));
    } else if (req.url === '/v1/ride/GOOD/route') {
      res.end(JSON.stringify({ points: [[45.0, 7.6], [45.05, 7.7]], distanceKm: 12.3 }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const share = await resolveRide(base, 'GOOD');
  assert.equal(share.rider, 'r-123');
  assert.equal(share.username, 'reader-x');
  assert.equal(share.topic, 'riders/r-123/telemetry');
  ok('resolveRide parses the ride share');

  assert.equal(await resolveRide(base, 'GONE'), null);
  ok('expired token -> null');

  const hist = await fetchHistory(base, 'GOOD');
  assert.equal(hist.samples.length, 2);
  assert.equal(hist.latestAgeSeconds, 5.0);
  ok('fetchHistory backfill decodes + freshness');

  const route = await fetchRoute(base, 'GOOD');
  assert.equal(route.points.length, 2);
  assert.equal(route.distanceKm, 12.3);
  ok('fetchRoute parses the planned line');

  server.close();
}

console.log('V2 · geohash (parity with cloud/api/geocell.py)');
{
  // Expected values produced by geocell.encode / geocell.center.
  const cases = [
    [45.4642, 9.19, 'u0nd9he'],
    [-33.86, 151.2, 'r3gx2eu'],
    [40.7, -74.0, 'dr5rs14'],
    [0, 0, 's000000'],
    [89.9, -179.9, 'bpbp6mb'],
  ];
  for (const [lat, lng, gh] of cases) assert.equal(geohash.encode(lat, lng, 7), gh, `${lat},${lng}`);
  const [clat, clng] = geohash.center('u0nd9h');
  assert.ok(Math.abs(clat - 45.46417236328125) < 1e-9 && Math.abs(clng - 9.1900634765625) < 1e-9);
  assert.ok(geohash.isGeohash('u0nd', 4) && !geohash.isGeohash('rome') && !geohash.isGeohash('u0nd', 6));
  assert.ok(Math.abs(geohash.distanceM(45, 9, 45.01, 9) - 1112) < 5);
  ok('encode / center / isGeohash / distance match the server');
}

console.log('V2 · areas, codes, credentials');
{
  assert.equal((await resolveArea('gh:u0nd9h')).gh4, 'u0nd');
  assert.equal((await resolveArea('u0nd', { forceCell: true })).gh4, 'u0nd');
  assert.equal((await resolveArea('45.4642, 9.19')).gh4, 'u0nd');
  await assert.rejects(resolveArea('gh:u0'), /bigger than a city/);
  await assert.rejects(resolveArea('91,0'), /off the map/);
  const fakeFetch = async (url) => {
    assert.ok(String(url).includes('nominatim') && String(url).includes('q=Milan'));
    return { ok: true, json: async () => [{ name: 'Milano', display_name: 'Milano, Lombardia, Italia', lat: '45.4641943', lon: '9.1896346' }] };
  };
  const milan = await resolveArea('Milan', { fetchImpl: fakeFetch });
  assert.equal(milan.gh4, 'u0nd');
  assert.equal(milan.detail, 'Lombardia, Italia');
  assert.deepEqual(parsePlaces({}), []);
  assert.deepEqual(parsePlaces([{ lat: 'x', lon: '1' }]), []);
  ok('place names, coordinates and geohash cells resolve to a city cell');

  assert.equal(normalizeRoomCode(' abc-123 '), 'ABC123');
  assert.equal(formatRoomCode('abc123'), 'ABC-123');
  assert.equal(normalizeInviteCode('https://ridefollow.live/?invite=P6C7859A078F'), 'p6c7859a078f');
  assert.equal(normalizeInviteCode(' p6c7859a078f '), 'p6c7859a078f');
  ok('room + invite codes normalise (spoken codes, pasted links)');

  assert.equal(brokerUrl('', 'https://api.ridefollow.live:8443'), 'mqtts://api.ridefollow.live:8883');
  assert.equal(brokerUrl('b.example', 'https://x'), 'mqtts://b.example:8883');
  assert.equal(brokerUrl('b.example:9000', 'https://x'), 'mqtts://b.example:9000');
  assert.equal(brokerUrl('mqtt://127.0.0.1:1883', 'https://x'), 'mqtt://127.0.0.1:1883');
  const env = { XDG_CONFIG_HOME: '/nonexistent-rf', RIDEFOLLOW_USER: 'env-user', RIDEFOLLOW_PASSWORD: 'env-pw' };
  assert.equal(configPath(env), '/nonexistent-rf/ridefollow/cli.json');
  const acct = resolveAccount({ user: 'flag-user' }, env);
  assert.equal(acct.user, 'flag-user');
  assert.equal(acct.password, 'env-pw');
  assert.equal(acct.api, 'https://api.ridefollow.live:8443');
  ok('broker defaults to the API host over TLS; flags > env > saved login');
}

console.log('V2 · wire formats + views');
{
  const now = 1_800_000_000_000;
  const pres = decodePresence('pabc', JSON.stringify({ pid: 'pabc', name: 'Anna', crew: 'navigli', gh6: 'u0nd9h', lat: 45.4642, lng: 9.19, spd: 20, since: now - 600000, ts: now }));
  assert.equal(pres.name, 'Anna');
  assert.equal(pres.speedKmh, 20);
  assert.equal(decodePresence('p', 'garbage'), null);
  assert.equal(decodePresence('p', '{"name":"x"}'), null);

  const meta = decodeAreaMeta(JSON.stringify({ gh4: 'u0nd', ridersNow: 1, tiles: 344, top: [{ pid: 'pabc', name: 'Anna', crew: 'navigli', tiles: 284 }, null], crews: [{ crew: 'navigli', tiles: 344 }] }));
  assert.equal(meta.top.length, 1);
  assert.equal(meta.crews[0].tiles, 344);
  const feed = decodeFeed(JSON.stringify([{ type: 'steal', by: { name: 'Carl' }, from: { name: 'Anna' }, tiles: 1, ts: now }, { type: 'loop', by: { name: 'Anna' }, tiles: 200, ts: now }, { nope: 1 }]));
  assert.equal(feed.length, 2);
  assert.equal(feedText(feed[0]), 'Carl took 1 tile from Anna');
  assert.equal(feedText(feed[1]), 'Anna closed a loop and captured 200 tiles');
  assert.deepEqual(decodeFeed('{}'), []);

  const place = { name: 'Milano', detail: 'Lombardia, Italia', gh4: 'u0nd', lat: 45.4642, lng: 9.19 };
  const riders = new Map([['pabc', pres], ['pdef', { ...pres, pid: 'pdef', name: 'Carl', crew: '', lat: 45.48 }]]);
  const lines = renderNearby({ place, riders, meta, feed, now }).join('\n');
  assert.ok(lines.includes('RIDING NOW · Milano · Lombardia, Italia (cell u0nd)'));
  assert.ok(lines.includes('Anna') && lines.includes('[navigli]') && lines.includes('Carl'));
  assert.ok(lines.includes('2 riding now'), 'live list beats a stale board count');
  assert.ok(lines.includes('1. Anna [navigli]') && lines.includes('TOP CREWS') && lines.includes('LATEST'));
  assert.ok(renderNearby({ place, riders: new Map(), meta: null, feed: [], now }).join('\n').includes('nobody is riding here'));
  // Feeds arrive newest-first (the server appendlefts): show the first five.
  const many = Array.from({ length: 7 }, (_, i) => ({ type: 'steal', byName: `R${i}`, fromName: 'X', tiles: 1, tsMs: now - i * 60000 }));
  const latest = renderNearby({ place, riders: new Map(), meta: null, feed: many, now }).join('\n');
  assert.ok(latest.includes('R0 took') && latest.includes('R4 took') && !latest.includes('R5 took'), 'newest five shown');
  assert.ok(latest.indexOf('R0 took') < latest.indexOf('R4 took'), 'newest first');

  const inbox = decodeInbox(JSON.stringify([
    { type: 'stolen', tiles: 3, by: { pid: 'pabc', name: 'Carl' }, gh4: 'u0nd', ts: now },
    { type: 'encounter', gh6: 'u0nd9h', with: { pid: 'pdef', name: 'Anna' }, ts: now - 7200000 },
    { type: 'invite', with: { pid: 'pghi', name: 'Dora' }, ts: now - 86400000 * 2 },
    { nope: true },
  ]));
  assert.equal(inbox.length, 3);
  assert.equal(inboxText(inbox[0]), 'Carl took 3 of your tiles in u0nd');
  assert.equal(inboxText(inbox[1]), 'you crossed paths with Anna (near cell u0nd9h)');
  assert.ok(inboxText(inbox[2]).startsWith('Dora joined RideFollow with your invite'));
  const inboxLines = renderInbox(inbox, now).join('\n');
  assert.ok(inboxLines.includes('now  Carl took') && inboxLines.includes('2h   you crossed') && inboxLines.includes('2d   Dora'));
  assert.ok(renderInbox([], now).join('\n').includes('nothing yet'));
  assert.deepEqual(decodeInbox('garbage'), []);
  assert.ok(renderBoard({ ...meta, top: [], crews: [] }, { place }).join('\n').includes('no land claimed here yet'));

  const room = { code: 'ABC123', name: 'Sunday loop', expiresAt: now + 3 * 3600000 + 5 * 60000, you: { pid: 'pme' },
    members: [{ pid: 'pabc', name: 'Anna', owner: true }, { pid: 'pme', name: 'Me', owner: false }] };
  const pos = decodeRoomPosition('pabc', JSON.stringify({ name: 'Anna', lat: 45.4642, lng: 9.19, spd: 21.4, ts: now }));
  const pin = decodePin(JSON.stringify({ lat: 45.466, lng: 9.19, by: 'Anna' }));
  assert.equal(decodeRoomPosition('p', '{"lat":1,"lng":2}'), null, 'position without ts is dropped');
  assert.equal(decodePin(''), null);
  const r = renderRoom({ room, positions: new Map([['pabc', pos]]), pin, now }).join('\n');
  assert.ok(r.includes('code ABC-123') && r.includes('ends in 3h05m'));
  assert.ok(r.includes('meeting point 45.46600, 9.19000 (set by Anna)'));
  assert.ok(/● Anna \(host\)\s+21 km\/h · now · 200 m to meet/.test(r), r);
  assert.ok(/○ Me \(you\)\s+not riding/.test(r));

  const me = renderMe({
    me: { pid: 'pme', profile: { name: 'Kekko', crew: 'navigli', nearby: true, land: true }, stats: { tiles: 60, areas: { u0nd: 60 }, riding: false } },
    invites: { count: 1, link: 'https://ridefollow.live/?invite=pme', invitedBy: 'Anna' },
  }).join('\n');
  assert.ok(me.includes('YOU · Kekko [navigli]') && me.includes('60 tiles held') && me.includes('u0nd: 60'));
  assert.ok(me.includes('1 friend joined') && me.includes('?invite=pme') && me.includes('invited by  Anna'));
  ok('presence / board / feed / room / pin decode and render');
}

console.log('V2 · /v2 client (mock server)');
{
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Basic ' + Buffer.from('rider-1:pw').toString('base64')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      if (req.url === '/v2/social/me') return res.end(JSON.stringify({ pid: 'p123', profile: { name: 'Kekko' }, stats: {} }));
      if (req.url === '/v2/areas/u0nd') return res.end(JSON.stringify({ gh4: 'u0nd', ridersNow: 0, tiles: 0, top: [], crews: [] }));
      if (req.url === '/v2/rooms' && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ code: 'ABC123', name: JSON.parse(body).name, members: [] })); }
      if (req.url === '/v2/rooms/ABC123/join') return res.end(JSON.stringify({ code: 'ABC123', members: [] }));
      if (req.url === '/v2/rooms/ZZZ999/join') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'no such room (or it has ended)' })); }
      if (req.url === '/v2/invites/redeem') { res.statusCode = 409; return res.end(JSON.stringify({ error: "you've already used an invite" })); }
      res.statusCode = 404;
      res.end('');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const api = socialClient({ apiBase, user: 'rider-1', password: 'pw' });

  assert.equal((await api.me()).pid, 'p123');
  assert.equal((await api.area('u0nd')).gh4, 'u0nd');
  assert.equal((await api.createRoom('Sunday', 'Kekko')).name, 'Sunday');
  assert.equal(JSON.parse(seen.at(-1).body).displayName, 'Kekko');
  await api.joinRoom('abc-123');
  assert.equal(seen.at(-1).url, '/v2/rooms/ABC123/join', 'spoken code normalised in the path');
  await assert.rejects(api.joinRoom('zzz999'), /no such room/);
  await assert.rejects(api.redeemInvite('https://ridefollow.live/?invite=pabcdef12345'), (e) => e.status === 409 && /already used/.test(e.message));
  assert.equal(JSON.parse(seen.at(-1).body).code, 'pabcdef12345', 'invite link reduced to its code');
  await assert.rejects(api.invites(), /no social \(V2\) features/);
  await assert.rejects(socialClient({ apiBase, user: 'rider-1', password: 'nope' }).me(), /ridefollow-cli login/);
  ok('Basic auth, routes, bodies and friendly errors');
  server.close();
}

console.log(`\nAll ${pass} checks passed.`);
