# kalyaka

A shared drawing sheet. Open a sheet, send the link, and everyone with it draws
on the same page in real time.

Nothing is stored. The server only relays messages between the people in a
room, and a room exists only while someone is in it. When the last person
leaves, the sheet is gone.

The whole thing ships as one static Go binary with the web page embedded.

## Features

- **Rooms by URL.** Every path is a sheet: `https://your.host/quiet-otter-42`.
  The front page suggests a random name.
- **Drafting tools.** Pen, line, arrow, rectangle, circle from the center, a
  dimension tool that labels lengths, and an eraser. Three line weights, four
  inks, and an optional snap to the 20 px grid.
- **Presence.** Live cursors, a "Drawn by" list in the title block, editable
  names, and emoji reactions.
- **Late joiners catch up.** A newcomer asks the room for the sheet, and the
  peer who has been there longest sends a snapshot.
- **Undo and export.** Undo your own last shape, clear the sheet for everyone,
  or save it as a PNG.
- **No build step on the front end.** Plain JS, CSS and self-hosted fonts.

### Keyboard

| Key                   | Action                          |
| --------------------- | ------------------------------- |
| `P` `L` `A` `R` `C`   | Pen, line, arrow, rect, circle  |
| `D`                   | Dimension                       |
| `E`                   | Eraser                          |
| `1` `2` `3`           | Line weight 1, 2, 4 px          |
| `G`                   | Toggle snap to grid             |
| `Shift`               | Constrain while drawing         |
| `Space` + drag        | Pan (also middle mouse, wheel)  |
| `Ctrl`/`Cmd` + `Z`    | Undo your last shape            |
| `Esc`                 | Cancel the shape in progress    |

On touch screens, drag with two fingers to pan.

## How it works

```
browser ──ws──▶ reverse proxy ──▶ kalyaka (centrifuge) ──▶ other browsers in the room
```

- The server is [centrifuge](https://github.com/centrifugal/centrifuge) with
  channel history disabled. Each room is a channel `room:<name>`.
- Clients batch everything they do into one publication per animation tick
  (about 25 per second), each carrying a list of drawing ops.
- When someone joins, they call the `sync` RPC. The server picks the member
  who has been in the room longest and asks them for a snapshot. That peer
  answers with the `snap` RPC, and the server forwards it to the newcomer.
  A snapshot is only forwarded from the peer that was asked, once, within
  10 seconds, so no client can push large messages at others unprompted.

### Limits

All limits are hard caps in [`hub.go`](hub.go), so the server's memory use is bounded.

| Limit                     | Value                       |
| ------------------------- | --------------------------- |
| Connections in total      | 1000                        |
| Connections per IP        | 8                           |
| Rooms                     | 200                         |
| People per room           | 16                          |
| Publication size          | 16 KB                       |
| Snapshot size             | 1 MB                        |
| Publication rate          | 30/s, burst 60              |
| Name length               | 32 characters               |
| Room name                 | `[a-z0-9][a-z0-9-]{0,39}`   |

A client that keeps going over the rate limit (100 refusals) is disconnected.

## Running

Download an archive for your platform from
[Releases](https://github.com/tmshv/kalyaka/releases), or build from source:

```sh
go install github.com/tmshv/kalyaka@latest
kalyaka -listen 127.0.0.1:20480
```

Flags:

| Flag       | Default            | Meaning                        |
| ---------- | ------------------ | ------------------------------ |
| `-listen`  | `127.0.0.1:20480`  | Address to serve HTTP on       |
| `-version` |                    | Print the version and exit     |

### Behind a reverse proxy

kalyaka is meant to sit behind a reverse proxy that terminates TLS. It takes
the visitor's address from the first `X-Forwarded-For` entry, so the proxy
**must overwrite** that header rather than append to it. Otherwise clients can
spoof it and get around the per-IP cap. The WebSocket origin must match the
`Host` the proxy forwards.

A [Caddy](https://caddyserver.com) site is enough:

```caddyfile
draw.example.com {
	reverse_proxy 127.0.0.1:20480 {
		header_up X-Forwarded-For {remote_host}
	}
}
```

Since the server stores nothing, it can run with no user, no writable
filesystem and loopback-only networking (for example systemd's
`DynamicUser=yes`, `ProtectSystem=strict`, `IPAddressAllow=localhost`).

## Development

Requires Go (see [`go.mod`](go.mod)) and [just](https://github.com/casey/just).

```sh
just run          # serve on 127.0.0.1:20480
just test         # go vet + go test -race
just build        # bin/kalyaka for this machine
just dist         # cross-compiled archives and checksums in dist/
```

The front end lives in [`web/`](web) and is embedded into the binary with
`go:embed`. Asset URLs carry a hash of the embedded files, so a new build
reaches every browser at once while the files themselves cache for a week.

### Releasing

Releases are driven by tags, the way `npm version` works:

```sh
just release patch   # v1.2.3 -> v1.2.4
just release minor   # v1.2.3 -> v1.3.0
just release major   # v1.2.3 -> v2.0.0
just release 2.0.0   # an explicit version
```

The recipe checks that the working tree is clean, runs the tests, creates an
annotated `vX.Y.Z` tag and pushes the current branch and the tag. The
[release workflow](.github/workflows/release.yml) then tests and builds
binaries for Linux and macOS (amd64 and arm64). It publishes a GitHub release
with the list of changes since the previous tag, download links and SHA-256
checksums.

[CI](.github/workflows/ci.yml) runs formatting checks, vet, tests and a build
on every pull request and on pushes to the main branch.

## License

[MIT](LICENSE). Bundled third-party files keep their own licenses:
[centrifuge-js](web/vendor/centrifuge.LICENSE) (MIT) and the
[IBM Plex fonts](web/fonts/OFL.txt) (SIL OFL 1.1).
