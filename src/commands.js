// V2 social commands: nearby / area / me / invite / room / login / logout.
// They act as a signed-in *rider* (the app's broker account), unlike the
// default share-link follow mode, which needs no account at all.
//
// HTTP (/v2) for the few server decisions (public id, rooms, invites), MQTT for
// the live, retained social topics — the same split the app uses.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import mqtt from 'mqtt';

import {
  SocialError,
  decodeAreaMeta,
  decodeFeed,
  decodeInbox,
  decodePin,
  decodePresence,
  decodeRoomPosition,
  formatRoomCode,
  renderBoard,
  renderInbox,
  renderMe,
  renderNearby,
  renderRoom,
  resolveArea,
  socialClient,
} from './social.js';

export const COMMANDS = ['nearby', 'area', 'me', 'inbox', 'invite', 'room', 'login', 'logout'];

const DEFAULT_API = 'https://api.ridefollow.live:8443';
const SETTLE_MS = 1200; // retained messages arrive in a burst; stop after a quiet gap
const SNAPSHOT_MAX_MS = 6000;

// ── credentials ──────────────────────────────────────────────────────────────

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'ridefollow', 'cli.json');
}

export function loadConfig(env = process.env) {
  try {
    const j = JSON.parse(readFileSync(configPath(env), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function saveConfig(cfg, env = process.env) {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600); // an existing file keeps its old mode otherwise
  return p;
}

/** Flags beat env beat the saved login. */
export function resolveAccount(opts, env = process.env) {
  const saved = loadConfig(env);
  const api = normalizeBase(opts.api || env.RIDEFOLLOW_API || saved.api || DEFAULT_API);
  return {
    api,
    user: opts.user || env.RIDEFOLLOW_USER || saved.user || '',
    password: opts.password || env.RIDEFOLLOW_PASSWORD || saved.password || '',
    broker: brokerUrl(opts.broker || env.RIDEFOLLOW_BROKER || saved.broker || '', api),
    insecure: Boolean(opts.insecure),
  };
}

function normalizeBase(v) {
  let s = String(v).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

/** The broker lives on the API host (MQTT over TLS, 8883) unless told otherwise. */
export function brokerUrl(v, api) {
  const s = String(v || '').trim();
  if (/^mqtts?:\/\//i.test(s)) return s;
  if (s) return `mqtts://${s.includes(':') ? s : `${s}:8883`}`;
  return `mqtts://${new URL(api).hostname}:8883`;
}

function requireAccount(acct) {
  if (!acct.user || !acct.password) {
    throw new SocialError(
      'this command needs your RideFollow rider account — run `ridefollow-cli login` ' +
        '(or set RIDEFOLLOW_USER / RIDEFOLLOW_PASSWORD)',
      0,
    );
  }
  return socialClient({ apiBase: acct.api, user: acct.user, password: acct.password });
}

// ── MQTT ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to `topics` as the rider and feed every message to `onMessage`.
 * Resolves with the client once subscribed. Retained state (presence, boards,
 * pins) replays straight away, so a one-shot snapshot only has to wait for
 * the burst to go quiet.
 */
function connectBroker(acct, topics, onMessage) {
  const client = mqtt.connect(acct.broker, {
    username: acct.user,
    password: acct.password,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 15000,
    resubscribe: true,
    rejectUnauthorized: !acct.insecure,
  });
  client.on('message', onMessage);
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      client.end(true);
      const msg = String((err && err.message) || err);
      reject(
        new SocialError(
          /not authoriz|bad user/i.test(msg)
            ? 'the broker refused your rider account — run `ridefollow-cli login` again'
            : `could not reach the broker ${acct.broker} (${msg})`,
          0,
        ),
      );
    };
    const timer = setTimeout(() => fail(new Error('timed out')), 20000);
    client.once('error', fail);
    // Mosquitto grants a refused (ACL) filter with QoS 128. Right after a room
    // join the broker may still be reloading its ACL, so retry a few times
    // before believing the refusal (the app does the same).
    const attempt = (n) => {
      client.subscribe(topics, { qos: 0 }, (err, granted) => {
        if (err) {
          clearTimeout(timer);
          return fail(err);
        }
        if ((granted || []).some((g) => g.qos === 128)) {
          if (n < 4) {
            setTimeout(() => attempt(n + 1), 500 * 2 ** n);
            return;
          }
          clearTimeout(timer);
          client.end(true);
          return reject(new SocialError('the broker refused that subscription (not a member?)', 403));
        }
        clearTimeout(timer);
        client.removeListener('error', fail);
        resolve(client);
      });
    };
    client.once('connect', () => attempt(0));
  });
}

/** Run until retained messages settle (snapshot) or until the user quits (watch). */
function runView(client, { watch, draw, onKey }) {
  return new Promise((resolve) => {
    const tty = process.stdout.isTTY;
    let settle = null;
    let redraw = null;
    const finish = () => {
      clearTimeout(settle);
      clearTimeout(hardStop);
      clearInterval(ticker);
      if (process.stdin.isTTY && watch) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.removeListener('SIGINT', finish);
      process.removeListener('SIGTERM', finish);
      client.end(true);
      if (watch && tty) process.stdout.write('\x1b[?25h');
      else draw();
      resolve();
    };
    const paint = () => {
      if (!watch) return;
      redraw = null;
      if (tty) process.stdout.write('\x1b[H\x1b[2J\x1b[?25l');
      draw();
      if (tty) process.stdout.write('\n  q quit\n');
    };
    const hardStop = watch ? null : setTimeout(finish, SNAPSHOT_MAX_MS);
    const ticker = watch ? setInterval(paint, 15000) : null;
    const bump = () => {
      if (watch) {
        redraw = redraw || setTimeout(paint, 150); // coalesce bursts
      } else {
        clearTimeout(settle);
        settle = setTimeout(finish, SETTLE_MS);
      }
    };
    client.on('message', bump);
    bump();
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    if (watch && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (b) => {
        const k = b.toString();
        if (k === 'q' || k === '\x1b' || k === '\x03') finish();
        else if (onKey) onKey(k, paint);
      });
    }
  });
}

const print = (lines) => process.stdout.write(lines.join('\n') + '\n');
const json = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

// ── commands ─────────────────────────────────────────────────────────────────

export async function runCommand(cmd, args, opts) {
  const acct = resolveAccount(opts);
  switch (cmd) {
    case 'login':
      return login(acct, opts);
    case 'logout': {
      rmSync(configPath(), { force: true });
      process.stdout.write('Signed out — saved rider account removed.\n');
      return;
    }
    case 'me':
      return me(acct, opts);
    case 'area':
      return area(acct, args, opts);
    case 'nearby':
      return nearby(acct, args, opts);
    case 'inbox':
      return inbox(acct, opts);
    case 'invite':
      return invite(acct, args, opts);
    case 'room':
      return room(acct, args, opts);
    default:
      throw new SocialError(`unknown command "${cmd}"`, 0);
  }
}

async function login(acct, opts) {
  if (!acct.user || !acct.password) {
    throw new SocialError(
      'usage: ridefollow-cli login --user <username> --password <password> [--api <url>]',
      0,
    );
  }
  const me = await requireAccount(acct).me(); // verify before saving
  const cfg = { api: acct.api, user: acct.user, password: acct.password };
  if (opts.broker) cfg.broker = acct.broker;
  const p = saveConfig(cfg);
  const name = (me.profile && me.profile.name) || acct.user;
  process.stdout.write(`Signed in as ${name} (public id ${me.pid}). Saved to ${p}\n`);
}

async function me(acct, opts) {
  const api = requireAccount(acct);
  const [m, inv] = await Promise.all([api.me(), api.invites().catch(() => null)]);
  if (opts.json) return json({ ...m, invites: inv });
  print(renderMe({ me: m, invites: inv }));
}

async function area(acct, args, opts) {
  const api = requireAccount(acct);
  const place = await resolveArea(args.join(' '), { forceCell: opts.cell });
  const meta = decodeAreaMeta(await api.area(place.gh4));
  if (opts.json) return json({ place, ...meta });
  print(renderBoard(meta, { place }));
}

async function nearby(acct, args, opts) {
  requireAccount(acct);
  const place = await resolveArea(args.join(' '), { forceCell: opts.cell });
  const gh4 = place.gh4;
  const riders = new Map();
  let meta = null;
  let feed = [];
  const client = await connectBroker(
    acct,
    [`area/${gh4}/+/presence/+`, `area/${gh4}/meta`, `area/${gh4}/feed`],
    (topic, payload) => {
      const parts = topic.split('/');
      if (parts[3] === 'presence' && parts.length === 5) {
        const r = payload.length ? decodePresence(parts[4], payload) : null;
        if (r) riders.set(parts[4], r);
        else riders.delete(parts[4]);
      } else if (parts[2] === 'meta') {
        meta = payload.length ? decodeAreaMeta(payload) : null;
      } else if (parts[2] === 'feed') {
        feed = decodeFeed(payload);
      }
    },
  );
  const draw = () =>
    opts.json
      ? json({ place, riders: [...riders.values()], meta, feed })
      : print(renderNearby({ place, riders, meta, feed }));
  await runView(client, { watch: opts.watch && !opts.json, draw });
}

async function inbox(acct, opts) {
  requireAccount(acct);
  let events = [];
  const client = await connectBroker(acct, [`social/${acct.user}/inbox`], (_topic, payload) => {
    events = decodeInbox(payload);
  });
  const draw = () => (opts.json ? json(events) : print(renderInbox(events)));
  await runView(client, { watch: opts.watch && !opts.json, draw });
}

async function invite(acct, args, opts) {
  const api = requireAccount(acct);
  const [sub, code] = args;
  if (sub === 'redeem') {
    if (!code) throw new SocialError('usage: ridefollow-cli invite redeem <code | invite link>', 0);
    const r = await api.redeemInvite(code);
    if (opts.json) return json(r);
    process.stdout.write(`Invite accepted${r.invitedBy ? ` — ${r.invitedBy} gets the credit` : ''}. Welcome aboard!\n`);
    return;
  }
  if (sub) throw new SocialError(`unknown invite command "${sub}" — try \`invite\` or \`invite redeem <code>\``, 0);
  const inv = await api.invites();
  if (opts.json) return json(inv);
  print([
    'INVITE FRIENDS — every friend who joins unlocks rewards in the app',
    `  your link   ${inv.link}`,
    `  your code   ${inv.code}`,
    `  joined      ${inv.count} friend${inv.count === 1 ? '' : 's'} so far`,
  ]);
}

async function room(acct, args, opts) {
  const api = requireAccount(acct);
  const [sub, ...rest] = args;
  const displayName = opts.name || process.env.RIDEFOLLOW_NAME || undefined;
  const needCode = () => {
    if (!rest[0]) throw new SocialError(`usage: ridefollow-cli room ${sub} <code>`, 0);
    return rest[0];
  };
  let view;
  switch (sub) {
    case 'create':
      view = await api.createRoom(rest.join(' ') || undefined, displayName);
      break;
    case 'join':
      view = await api.joinRoom(needCode(), displayName);
      break;
    case 'show':
    case 'watch':
      view = await api.getRoom(needCode());
      break;
    case 'pin':
      return pinRoom(acct, api, needCode(), rest.slice(1).join(' '), opts);
    case 'leave': {
      const r = await api.leaveRoom(needCode());
      if (opts.json) return json(r);
      process.stdout.write(r.left ? 'Left the group ride.\n' : 'You were not in that group ride.\n');
      return;
    }
    default:
      throw new SocialError(
        'usage: ridefollow-cli room <create [name] | join <code> | show <code> | watch <code> | pin <code> <lat,lng | clear> | leave <code>>',
        0,
      );
  }
  if (sub === 'create' && !opts.json) {
    process.stdout.write(
      `Group ride created. Share the code ${formatRoomCode(view.code)} — ` +
        `friends join with \`ridefollow-cli room join ${view.code}\` or from the app.\n\n`,
    );
  }
  if (sub !== 'watch' && !opts.watch) return opts.json ? json(view) : print(renderRoom({ room: view }));

  // Live: member positions + meeting point, straight from the room's topics.
  const code = view.code;
  const positions = new Map();
  let pin = null;
  const client = await connectBroker(
    acct,
    [`rooms/${code}/meta`, `rooms/${code}/presence/+`, `rooms/${code}/pin`],
    (topic, payload) => {
      const parts = topic.split('/');
      if (parts[2] === 'presence') {
        const p = payload.length ? decodeRoomPosition(parts[3], payload) : null;
        if (p) positions.set(parts[3], p);
        else positions.delete(parts[3]);
      } else if (parts[2] === 'pin') {
        pin = payload.length ? decodePin(payload) : null;
      } else if (parts[2] === 'meta') {
        if (!payload.length) {
          view = { ...view, members: [], name: `${view.name} (ended)` };
          return;
        }
        try {
          const m = JSON.parse(payload.toString('utf8'));
          if (m && Array.isArray(m.members)) view = { ...view, ...m, you: view.you };
        } catch {
          /* ignore */
        }
      }
    },
  );
  const draw = () =>
    opts.json ? json({ room: view, positions: [...positions.values()], pin }) : print(renderRoom({ room: view, positions, pin }));
  await runView(client, { watch: !opts.json, draw });
}

/** Set (or clear) the group's meeting point — any member may, as in the app. */
async function pinRoom(acct, api, code, where, opts) {
  const clear = /^(clear|none|off)$/i.test(where.trim());
  const ll = where.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!clear && !ll) throw new SocialError('usage: ridefollow-cli room pin <code> <lat,lng | clear>', 0);
  const lat = ll ? Number(ll[1]) : 0;
  const lng = ll ? Number(ll[2]) : 0;
  if (ll && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw new SocialError('those coordinates are off the map', 0);

  const view = await api.getRoom(code); // 404 unless I'm a member
  const mine = (view.members || []).find((m) => view.you && m.pid === view.you.pid);
  const by = opts.name || process.env.RIDEFOLLOW_NAME || (mine && mine.name) || 'Rider';
  const topic = `rooms/${view.code}/pin`;
  const payload = clear ? '' : JSON.stringify({ lat, lng, by });

  // Subscribing first proves the broker has loaded my room grant (it may lag a
  // just-made join); a refused publish would otherwise vanish silently.
  const client = await connectBroker(acct, [topic], () => {});
  await new Promise((resolve, reject) =>
    client.publish(topic, payload, { qos: 1, retain: true }, (err) => (err ? reject(err) : resolve())),
  ).finally(() => client.end());
  if (opts.json) return json(clear ? { pin: null } : { pin: { lat, lng, by } });
  process.stdout.write(
    clear
      ? `Meeting point cleared for ${formatRoomCode(view.code)}.\n`
      : `Meeting point set for ${formatRoomCode(view.code)}: ${lat.toFixed(5)}, ${lng.toFixed(5)}.\n`,
  );
}
