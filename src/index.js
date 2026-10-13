import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseTarget } from './link.js';
import { follow } from './follow.js';
import { COMMANDS, runCommand } from './commands.js';

function version() {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `ridefollow-cli — follow a live RideFollow bike ride from your terminal

USAGE
  ridefollow-cli <token>
  ridefollow-cli "<share-link>"
  npx ridefollow-cli "https://ridefollow.live/?ride=<token>"

  Quote the share link — the "?" and "&" in a URL are special to your
  shell (zsh otherwise prints "no matches found"). The bare token works
  without quotes.

SOCIAL (V2 — signed in as your RideFollow rider account)
  ridefollow-cli login --user <u> --password <p>   save your rider account
  ridefollow-cli nearby <city | lat,lng> [-w]      who's riding in a city now
  ridefollow-cli area <city | lat,lng>             the city's land leaderboard
  ridefollow-cli me                                your public id, land, invites
  ridefollow-cli inbox [-w]                        encounters, stolen tiles, friends joined
  ridefollow-cli invite [redeem <code | link>]     your invite link / use a friend's
  ridefollow-cli room create [name]                start a group ride, get a code
  ridefollow-cli room join|show|watch|leave <code> join / see / follow live / leave
  ridefollow-cli room pin <code> <lat,lng|clear>   set the group's meeting point
  ridefollow-cli logout                            forget the saved account

OPTIONS
  -n, --name <name>   your name on a cheer / in a group ride   (env RIDEFOLLOW_NAME)
      --api <url>     override the control-plane API base      (env RIDEFOLLOW_API)
      --insecure      skip TLS certificate verification (dev brokers only)
  -u, --user <u>      rider username (env RIDEFOLLOW_USER)       [social]
  -p, --password <p>  rider password (env RIDEFOLLOW_PASSWORD)   [social]
      --broker <host> broker host[:port] or mqtt(s):// URL      (env RIDEFOLLOW_BROKER)
      --cell          treat the area as a 4-char geohash cell   [nearby/area]
  -w, --watch         keep the view live until you press q      [nearby/inbox/room]
      --json          print raw JSON for scripts                 [social]
  -h, --help          show this help
  -v, --version       print the version

WHILE WATCHING
  q / Esc   quit                    c   send a cheer to the rider

The rider shares a private link from the RideFollow app; paste it here and you'll
watch their ride on a live terminal dashboard — speed, distance, ETA, route
progress and an event feed, like race day.
Learn more at https://ridefollow.live
`;

export async function main(argv) {
  const opts = { name: '', api: '', insecure: false, user: '', password: '', broker: '', cell: false, watch: false, json: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return;
    }
    if (a === '-v' || a === '--version') {
      process.stdout.write(version() + '\n');
      return;
    }
    if (a === '-n' || a === '--name') {
      opts.name = argv[++i] || '';
    } else if (a.startsWith('--name=')) {
      opts.name = a.slice('--name='.length);
    } else if (a === '--api') {
      opts.api = argv[++i] || '';
    } else if (a.startsWith('--api=')) {
      opts.api = a.slice('--api='.length);
    } else if (a === '--insecure') {
      opts.insecure = true;
    } else if (a === '-u' || a === '--user') {
      opts.user = argv[++i] || '';
    } else if (a.startsWith('--user=')) {
      opts.user = a.slice('--user='.length);
    } else if (a === '-p' || a === '--password') {
      opts.password = argv[++i] || '';
    } else if (a.startsWith('--password=')) {
      opts.password = a.slice('--password='.length);
    } else if (a === '--broker') {
      opts.broker = argv[++i] || '';
    } else if (a.startsWith('--broker=')) {
      opts.broker = a.slice('--broker='.length);
    } else if (a === '--cell') {
      opts.cell = true;
    } else if (a === '-w' || a === '--watch') {
      opts.watch = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option "${a}" — run \`ridefollow-cli --help\``);
    } else {
      positional.push(a);
    }
  }

  // Social subcommands. Ride tokens are 16+ chars, so a command word can never
  // be mistaken for one — the plain `ridefollow-cli <link>` form is unchanged.
  if (positional.length && COMMANDS.includes(positional[0])) {
    await runCommand(positional[0], positional.slice(1), opts);
    return;
  }

  if (positional.length === 0) {
    process.stdout.write(HELP);
    throw new Error('paste the ride share link (or its token) to start following');
  }

  const target = parseTarget(positional[0], { apiOverride: opts.api || process.env.RIDEFOLLOW_API });
  await follow(target, { name: opts.name, insecure: opts.insecure });
}
