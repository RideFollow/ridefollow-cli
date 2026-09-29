# ridefollow-cli

Follow a live [RideFollow](https://ridefollow.live) bike ride from your terminal.
Someone shares a private link from the RideFollow app — you paste it here and
watch their ride unfold on a green-phosphor CRT dashboard, like race day:
speed, distance, ETA, route progress and a live event feed.

![ridefollow following a live ride in the terminal](cli.png)

(The headline metrics render as glowing seven-segment "LCD" digits; the wordmark's
`//` and the progress arrow carry the RideFollow flame accent.)

## Install

**npm** (no install — just run it):

```sh
npx ridefollow-cli "https://ridefollow.live/?ride=<token>"
```

or install it globally:

```sh
npm install -g ridefollow-cli
ridefollow-cli "https://ridefollow.live/?ride=<token>"
```

**Homebrew**:

```sh
brew install ridefollow/tap/ridefollow-cli
ridefollow-cli "https://ridefollow.live/?ride=<token>"
```

Requires Node.js 18+ (Homebrew pulls it in automatically).

## Usage

```
ridefollow-cli <share-link | token>
```

You can paste the whole share link, just the `host/?ride=…` part, or the bare
token — they all work.

> **Zsh tip — unquoted links.** A bare share URL trips your shell's globbing on
> the `?` (`zsh: no matches found`) *before* the CLI ever runs, so quoting is up
> to the shell, not the tool. Either quote the link, or pass just the token
> (no `?`, so no quotes needed). To always allow unquoted links, alias the
> command through `noglob` in your `~/.zshrc`:
>
> ```sh
> alias ridefollow-cli='noglob ridefollow-cli'
> ```

| Option | | Description |
| --- | --- | --- |
| `-n, --name <name>` | | Name shown on a cheer you send (env `RIDEFOLLOW_NAME`) |
| `--api <url>` | | Override the control-plane API base (env `RIDEFOLLOW_API`) |
| `--insecure` | | Skip TLS certificate verification — dev brokers only |
| `-h, --help` | | Show help |
| `-v, --version` | | Print the version |

### While watching

| Key | Action |
| --- | --- |
| `q` / `Esc` | Quit |
| `c` | Send a cheer to the rider 📣 |

Piping the output somewhere that isn't a terminal (a file, a log, CI) switches
to a plain one-line-per-update mode instead of the full-screen dashboard.

## Social (V2): riders nearby, land, group rides, invites

Signed in with your **RideFollow rider account** (the same broker account the
app uses), the CLI speaks the V2 social layer too:

```sh
ridefollow-cli login --user <username> --password <password>
ridefollow-cli nearby Turin           # who's riding in a city right now (-w to keep it live)
ridefollow-cli area "Milan"           # the city's land leaderboard: top riders + crews
ridefollow-cli me                     # your public id, visibility, tiles held, invites
ridefollow-cli invite                 # your invite link — friends who join unlock rewards
ridefollow-cli invite redeem <code>   # joined with a friend's code or link
ridefollow-cli room create "Sunday loop"
ridefollow-cli room join ABC-123      # add --watch to follow the group live
ridefollow-cli room watch ABC-123     # members' positions + distance to the meeting point
ridefollow-cli room leave ABC-123
```

Areas are **cities, not people**: type a place name (searched on
OpenStreetMap — only the text you type is sent), `lat,lng`, or a 4-character
geohash cell (`gh:u0nd` or `--cell u0nd`). Nearby riders appear only if they
opted in, and only snapped to their ~1 km district — the CLI sees exactly what
the app's *Nearby* tab does. Add `--json` to any social command for scripting.

| Option | Env | |
| --- | --- | --- |
| `-u, --user` / `-p, --password` | `RIDEFOLLOW_USER` / `RIDEFOLLOW_PASSWORD` | Rider account (else the saved `login`) |
| `--api <url>` | `RIDEFOLLOW_API` | API base (default `https://api.ridefollow.live:8443`) |
| `--broker <host[:port]>` | `RIDEFOLLOW_BROKER` | Broker (default: the API host, MQTT over TLS on 8883; `mqtt://…` for a dev broker) |
| `-n, --name` | `RIDEFOLLOW_NAME` | Your name in a group ride |
| `-w, --watch` / `--json` | | Live view until `q` / raw JSON |

`login` checks the account against `/v2/social/me` before saving it to
`~/.config/ridefollow/cli.json` (mode `600`); `logout` deletes it. How it maps
onto the backend: `/v2` HTTP for the few server decisions (public id, rooms,
invites, a leaderboard snapshot) and the retained MQTT topics for everything
live — `area/<city>/+/presence/+`, `area/<city>/meta|feed`,
`rooms/<code>/presence/+|pin|meta`. Share-link following (above) is unchanged
and still needs no account.

## How it works

RideFollow share links are per-ride and self-expiring — the token *is* the
capability. `ridefollow-cli`:

1. Resolves the token against the control-plane API (`GET /v1/ride/<token>`),
   which hands back the rider plus a **read-only broker account scoped to just
   this ride**.
2. Backfills the ride so far (`/history`) and the planned route (`/route`), so
   joining mid-ride still shows accurate progress, ETA and event history.
3. Streams live telemetry straight from the MQTT broker over TLS — the same
   retained topic the app reads — driving the metrics, route bar and event log.

When the ride ends the account is revoked and the link goes dead, so there's
nothing to watch and nothing to leak. See the RideFollow backend for the full
design.

## Development

```sh
npm install
npm test          # pure-Node unit + mock-API checks (V1 follow + V2 social)
npm start -- --help
```

The client re-speaks the follower half of the RideFollow wire contract in plain
JavaScript; it shares no code with the Flutter app, so it stays a standalone,
dependency-light package (only `mqtt`).

## License

MIT

This license applies only to the contents of this `ridefollow-cli` repository.
The RideFollow mobile app, backend, cloud infrastructure, and the main private
RideFollow repository are not included here and remain proprietary.
