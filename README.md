# 🎬 VlogBuddy

**Make a vlog with your friends, without the effort.**

Self-hosted. Create a vlog, share one link. Everyone dumps their photos, videos
and music picks into a shared pile, reacts to the good stuff, and the best bits
float to the top on their own. Then you cut it together — in the browser, at the
same time — and render a real MP4.

No accounts. No apps to install. Your media never leaves your server.

---

## How it works

A vlog moves through five phases. The creator drives it forward.

| Phase | What happens |
|---|---|
| **📥 Dump & vote** | Friends upload photos/videos and paste music links. Everyone reacts with three emoji that double as a score. |
| **⭐ Curate** | The pile is sorted by vote. Pick the keepers and lock the running order. |
| **✂️ Edit** | The vlog is **already assembled** from the winners. Trim, reorder, add titles, lay shots over the cut, stack up the sound — together, live. |
| **⚙️ Render** | FFmpeg stitches the real thing server-side. Progress streams to everyone. |
| **🎉 Published** | Watch and download the MP4. |

### The dump view

The bit that makes this low-effort. Items flow **left-to-right in rough
chronological order** (grouped by capture date from EXIF/video metadata), and
within each day the **best-voted float to the front and render larger**. Music
links sit on the same timeline, so a track can be parked roughly where it should
land in the final cut.

Ranking blends total score with vote count, so five 🙂 beats one 🤩 — broad
approval wins over a single enthusiast.

---

## Quick start

**Requirements:** Docker + Docker Compose, and a reverse proxy you already run
(skip the proxy if you're on a LAN — see [Access by IP](#access-by-ip-no-domain)).

```bash
git clone https://github.com/MayeulHP/vlogbuddy.git && cd vlogbuddy
./scripts/setup-env.sh    # copies .env.example and fills in random secrets
$EDITOR .env              # set PUBLIC_BASE_URL and PUBLIC_STORAGE_URL
docker compose up -d
```

Migrations run automatically on first boot. That's it.

### Minimum config

```bash
PUBLIC_BASE_URL=https://vlog.example.com          # where the app lives
PUBLIC_STORAGE_URL=https://vlog-storage.example.com  # where MinIO lives
```

Secrets (`SESSION_SECRET`, `POSTGRES_PASSWORD`, `S3_SECRET_KEY`) are generated
by `./scripts/setup-env.sh`. Both URLs must be reachable **from your friends'
browsers** — uploads and downloads go directly to the storage endpoint via
presigned URLs.

### Access by IP (no domain)

Uploads go from the browser straight to MinIO, which is a different origin
(`:3000` vs `:9000`). Without a domain, the `Origin` header is something like
`http://192.168.1.10:3000`, and MinIO will reject the PUT unless that origin is
allowed.

```bash
./scripts/setup-env.sh --lan            # detect LAN IP, set URLs, CORS=*
./scripts/setup-env.sh --lan --host 192.168.1.10
```

Or set it yourself:

```bash
PUBLIC_BASE_URL=http://192.168.1.10:3000
PUBLIC_STORAGE_URL=http://192.168.1.10:9000
CORS_ALLOW_ORIGIN=*
```

`CORS_ALLOW_ORIGIN=*` is the LAN flag. Do not use it on the public internet —
lock MinIO back to `PUBLIC_BASE_URL` (leave the variable empty) once you have a
real domain.

---

## Reverse proxy

VlogBuddy deliberately **does not ship a reverse proxy**, since most home servers
already run one. Point yours at the two published ports:

| Service | Port | Needs |
|---|---|---|
| `web` | `WEB_PORT` (3000) | **WebSocket upgrade** for live voting + co-editing |
| `minio` | `S3_PORT` (9000) | **Large request bodies** — this is where the video actually uploads |

Uploads bypass the app entirely (browser → MinIO via presigned PUT), so the app
proxy only needs normal body limits.

### Caddy

```caddy
vlog.example.com {
	reverse_proxy localhost:3000
}

vlog-storage.example.com {
	reverse_proxy localhost:9000
	request_body {
		max_size 5GB
	}
}
```

### nginx

```nginx
server {
    server_name vlog.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required — live voting and collaborative editing use WebSockets.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

server {
    server_name vlog-storage.example.com;

    # Video files are big.
    client_max_body_size 5G;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Architecture

```
                    your reverse proxy (TLS)
                     │                    │
         ┌───────────┘                    └──────────┐
         ▼                                           ▼
   ┌───────────┐   presigned PUT/GET ──────────▶ ┌─────────┐
   │    web    │                                 │  minio  │
   │  Next.js  │◀──── Socket.IO (live) ───▶ 🧑‍🤝‍🧑    │   (S3)  │
   └─────┬─────┘                                 └────┬────┘
         │ enqueue (pg-boss)                          │
         ▼                                            │
   ┌───────────┐                                      │
   │ postgres  │◀──── LISTEN/NOTIFY bridge ───┐       │
   └─────┬─────┘                              │       │
         │ jobs                               │       │
         ▼                                    │       ▼
   ┌───────────────────────────────────────────────────┐
   │ worker — ffmpeg thumbnails, proxies, final render  │
   └───────────────────────────────────────────────────┘
```

**Stack:** Next.js 15 · TypeScript · Tailwind · Postgres + Drizzle · MinIO ·
pg-boss · Socket.IO · FFmpeg.

Deliberate choices:

- **No Redis.** pg-boss runs the job queue on the Postgres we already have.
- **Direct-to-storage uploads.** 4K phone video never touches the Node process.
- **Server-side rendering.** Reliable for large files and consistent across
  devices, unlike ffmpeg.wasm in a browser tab.
- **Low-res proxies.** Scrubbing the editor doesn't stream multi-GB originals.
- **The worker talks back via Postgres `NOTIFY`**, which the web process relays
  into Socket.IO rooms. One less moving part.

### Layout

```
apps/web      Next.js app + custom server hosting Socket.IO
apps/worker   ffmpeg media pipeline + render jobs
packages/db   Drizzle schema, migrations, client
packages/shared  timeline model, zod schemas, realtime event contract, Immich client
```

The **timeline document** (`packages/shared/src/timeline.ts`) is the heart of it:
a single JSON doc describing the final cut, mutated by pure `TimelineOp`
reducers. The same reducer runs optimistically in the browser and
authoritatively on the server, and the worker compiles the result into an FFmpeg
filter graph.

---

## Development

```bash
pnpm install

# Postgres + MinIO only
docker compose up -d postgres minio minio-init

./scripts/setup-env.sh  # or cp .env.example .env and edit
# point DATABASE_URL / S3_ENDPOINT at localhost for `pnpm dev`
pnpm db:migrate

pnpm dev          # web on :3000
pnpm dev:worker   # worker (needs ffmpeg on PATH)
```

```bash
pnpm typecheck    # all packages
pnpm build        # production build
```

### Testing the render pipeline

The FFmpeg filter graph is the trickiest part, so it has a real integration
check — it builds graphs and renders actual MP4s:

```bash
# generate test media first (see apps/worker/src/render-check.ts header)
pnpm --filter @vlogbuddy/worker render-check /tmp/vbrender
```

It covers straight cuts, mixed portrait/landscape letterboxing, crossfades,
burned-in titles, music beds with ducking, muted clips, picture layers
(stacked, faded, clipped to the picture) and multiple audio cues in one mix.
Titles and layers aren't just checked for a valid MP4 — each is re-rendered
with the feature removed and the frames compared, because a filter that
silently draws nothing still produces a perfectly valid file.

---

## Immich

If your photos already live on your own [Immich](https://immich.app) server, you
don't need to upload them again.

Each person connects their **own** instance from inside a vlog — server address
plus an API key from *Account Settings → API Keys*. The key is encrypted with
AES-256-GCM (keyed off `SESSION_SECRET`), scoped to that one vlog, and never
sent to anyone else's browser. Thumbnails are proxied through the app so the
browser never sees the key either.

**Importing.** Pick an album and hit *Import all*, or open it and choose
individual shots. The worker pulls the originals server-to-server — the bytes
never touch your phone — and each asset lands in the pile as a normal item with
its real capture time, so the chronological ordering still works. Assets already
in the vlog are skipped by content hash, so two people importing the same shared
album doesn't double the pile.

**Getting the media back out.** This is the part Immich can't do for you: two
friends with two servers have no way to merge libraries. *Copy roll to my
Immich* pushes every original in the vlog — everybody's, not just yours — into
your instance as an album named after the vlog. It asks your server which files
it already has first, so only what's missing is transferred and pressing it
twice is harmless. Whoever brought the footage, everyone can keep the originals.

> The app server is what talks to Immich, not the browser — so the address has
> to be reachable **from the machine running VlogBuddy**. A LAN address like
> `http://192.168.1.10:2283` is fine; `localhost` only works if Immich is on the
> same host (inside Docker, `http://host.docker.internal:2283`). That also means
> a member can point VlogBuddy at any address it can reach, so only hand share
> links to people you'd trust with that.

---

## Music & the law

Music links (YouTube / Spotify / Deezer) are used for **discovering, voting and
placing** a track on the timeline. That part is just an embedded player and
always works.

Getting audio **into the rendered MP4** is a different matter:

- **Spotify and Deezer are DRM-protected.** Their audio cannot be extracted, and
  VlogBuddy never tries.
- **The blessed path is to upload an audio file.** Drop an MP3/WAV into the vlog
  and pick it as the music bed in the editor. Legally clean, always works.
- **`ENABLE_YT_AUDIO=true`** makes the worker pull audio from YouTube links with
  `yt-dlp`. ⚠️ **This violates YouTube's Terms of Service and the result is not
  redistributable.** It is **off by default** and provided only for private,
  personal, self-hosted use. Enabling it is your call and your responsibility.

With extraction off, a vlog still renders perfectly — it just uses uploaded audio
or the clips' own sound.

---

## Configuration

See [`.env.example`](.env.example) for the annotated list. The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | — | Public origin of the app. Builds share links. |
| `PUBLIC_STORAGE_URL` | — | Public origin of MinIO. Browsers hit this directly. |
| `CORS_ALLOW_ORIGIN` | `PUBLIC_BASE_URL` | MinIO + Socket.IO allowed Origin. Set `*` for IP / no-domain access. |
| `SESSION_SECRET` | — | `openssl rand -hex 32`. Signs member cookies and encrypts stored Immich keys. Needed by **both** web and worker, same value. (`setup-env.sh` generates it.) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / — | Guards `/admin` and creating vlogs. Empty password seals the admin area. (`setup-env.sh` generates the password.) |
| `MAX_UPLOAD_MB` | `2048` | Per-file upload limit. |
| `RENDER_HEIGHT` / `RENDER_FPS` | `1080` / `30` | First-boot defaults only — the export format is set on `/admin` after that. |
| `RENDER_CONCURRENCY` | `1` | Raise only if the host has CPU to spare. |
| `ENABLE_YT_AUDIO` | `false` | See the warning above. |

---

## The admin page

Everything a guest touches is open: the share link, the cutting room, the
finished film. What isn't is `/admin`, behind HTTP Basic Auth
(`ADMIN_USER` / `ADMIN_PASSWORD`). Serve the instance over HTTPS — Basic
credentials are base64, not encrypted. Leaving `ADMIN_PASSWORD` empty seals the
admin area off entirely.

It does three things:

- **Starts rolls.** Creating a vlog spends this box's disk and CPU, so it
  belongs to whoever runs the box. Friends still need nothing but the link.
- **Sets the export format** — frame size, frame rate, quality and encoder
  preset. These used to be env vars, which meant editing `.env` and restarting
  to discover that 1080p60 is too much for the machine. Changes apply to the
  next render.
- **Frees the disk.** Once a film is rendered, the source footage behind it is
  almost all of the space it occupies. *Sweep sources* deletes the originals,
  proxies and thumbnails and keeps the film, the credits and the votes — the
  vlog stays readable as a record of the trip, it just can't be re-edited or
  re-rendered. The button is only offered once something has actually been
  rendered, so there's no way to sweep a trip you haven't cut yet.

---

## Privacy & access

- A vlog is reachable by anyone holding its **share link** — treat it like a
  secret. Add a **passcode** when creating one for a second factor.
- Joining sets a signed, HTTP-only cookie scoped to that single vlog.
- All storage access goes through **expiring presigned URLs**; the bucket is
  never public.
- People can delete their own uploads; the creator can delete anything.

---

## Roadmap

See [`TODO.md`](TODO.md). The headline items for v2:

- **More of the editor** — effects, keyframes, a bigger transitions library, and
  CRDT-backed conflict-free co-editing. (Multiple video and audio tracks landed;
  see [`TODO.md`](TODO.md).)

---

## License

MIT.
