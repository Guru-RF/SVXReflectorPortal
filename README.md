# SVXReflectorPortal

A live web dashboard for an [SvxLink](https://www.svxlink.org/) **SvxReflector**
network. It shows who is currently talking, recent activity, talkgroup names and
per-callsign information in real time, with a map view of repeaters and hotspots.

The portal is a small [Node.js](https://nodejs.org/) (Express) server that:

- serves the static dashboard from [`public/`](public/),
- serves runtime configuration (title, talkgroup and callsign metadata) as JSON
  from `/config.json` (plus `/talkgroups.json` and `/callsigns.json`),
- exposes a `/healthz` health check.

The portal itself does **not** talk to the SvxReflector and does **not** proxy
any WebSocket. The dashboard runs in the browser and connects **directly** to an
upstream live feed (the `UPSTREAM_WS_URL` below). The Node server only hosts the
static files and the configuration. See the prerequisite next.

## Prerequisite: SVXReflectorFeed

You must install and run [**SVXReflectorFeed**](https://github.com/Guru-RF/SVXReflectorFeed)
**first**. It connects to your SvxReflector, tracks activity, and publishes the
live WebSocket feed that this portal renders.

Install and start it following its own instructions, then note the WebSocket URL
it exposes. Because the **browser** connects to it directly, that URL must be
reachable from your users' browsers — not just from the portal server:

```text
SVXReflector ──▶ SVXReflectorFeed ──(WebSocket)──┐
                                                 ▼
   Browser ◀── static files/config ── SVXReflectorPortal
   Browser ──────────(WebSocket, direct)────────▶ SVXReflectorFeed
```

> **HTTPS note:** if you serve the portal over `https://`, the feed URL must use
> `wss://` (a secure WebSocket). Browsers block insecure `ws://` connections from
> a secure page (mixed content). Put the feed behind TLS accordingly.

## Configuration

All configuration is supplied through environment variables. For deployment they
are kept in an `env.yaml` file. Copy the example and edit it:

```bash
cp env.yaml.example env.yaml
```

| Variable             | Required | Description                                                          |
| -------------------- | -------- | -------------------------------------------------------------------- |
| `UPSTREAM_WS_URL`    | yes      | WebSocket URL of your **SVXReflectorFeed** (browser connects to it). |
| `UI_TITLE`           | no       | Page / header title. Default: `SVX Reflector • Live`.                |
| `TG_INFO_JSON`       | no       | JSON map of talkgroup id → name, e.g. `{"9990":"Parrot"}`.           |
| `CALLSIGN_INFO_JSON` | no       | JSON map of callsign → info text shown on hover / in map popups.     |
| `PORT`               | no       | Port the server listens on. Default: `8080`.                         |

The talkgroups listed in `TG_INFO_JSON` also drive the columns shown in the
dashboard table. `TG_INFO_JSON` and `CALLSIGN_INFO_JSON` must be valid JSON;
`deploy.sh` and `runlocal.sh` validate/echo them so typos surface early.

## Run locally

Requires [Node.js](https://nodejs.org/) 20+, plus [`yq`](https://github.com/mikefarah/yq)
and [`prettier`](https://prettier.io/) (used by the helper script to load
`env.yaml` and format sources). On macOS: `brew install yq prettier` (see
[`prereq-mac`](prereq-mac)).

```bash
npm install
./runlocal.sh
```

The dashboard is then available at <http://localhost:8080>.

To run without the helper, export the variables yourself and start the server:

```bash
export UPSTREAM_WS_URL="wss://feed.example.org/"
npm start
```

## Deployment

Two supported options: **Google Cloud Run** (serverless) and a **standalone
Debian** server. Both serve the same app; pick whichever fits your environment.

### Option A — Google Cloud Run

Container-based, scales to zero, no server to maintain.

Prerequisites:

- The [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`)
  and [`yq`](https://github.com/mikefarah/yq). On macOS: `brew install google-cloud-sdk yq`.
- A Google Cloud project with billing enabled.
- A configured `env.yaml` (see [Configuration](#configuration)).

[`deploy.sh`](deploy.sh) has the project, region and service name hardcoded near
the bottom — edit these to match your setup:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud config set run/region YOUR_REGION          # e.g. europe-west1
gcloud run deploy YOUR_SERVICE_NAME ...
```

One-time setup, then deploy:

```bash
gcloud auth login
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
./deploy.sh
```

`deploy.sh` validates the JSON in `env.yaml`, builds from source (using the
[`Dockerfile`](Dockerfile)), and deploys to Cloud Run with `--allow-unauthenticated`.
The command prints the public service URL when it finishes.

### Option B — Standalone Debian (systemd)

Run the portal as a long-lived service on a Debian/Ubuntu host, optionally behind
nginx for TLS.

#### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

#### 2. Get the code and install dependencies

```bash
sudo git clone https://github.com/Guru-RF/SVXReflectorPortal.git /opt/svxreflectorportal
cd /opt/svxreflectorportal
sudo npm install --omit=dev
```

#### 3. Create the environment file

systemd's `EnvironmentFile` requires `KEY=value` pairs with **single-line**
values, so keep each JSON value on one line. Create `/etc/svxreflectorportal.env`:

```ini
UPSTREAM_WS_URL=wss://feed.example.org/
UI_TITLE=SVX Reflector • Live
PORT=8080
TG_INFO_JSON={"9990":"Parrot, test your audio here"}
CALLSIGN_INFO_JSON={"ON0EXAMPLE":"TX:438.8000 RX:431.2000"}
```

#### 4. Create the systemd service

Create `/etc/systemd/system/svxreflectorportal.service`:

```ini
[Unit]
Description=SVXReflectorPortal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/svxreflectorportal
EnvironmentFile=/etc/svxreflectorportal.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

#### 5. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now svxreflectorportal
sudo systemctl status svxreflectorportal
```

The portal now listens on `http://<host>:8080`.

#### 6. (Optional) nginx reverse proxy with TLS

To serve the portal on port 443 with a domain name, put nginx in front. The
portal serves only plain HTTP (no WebSocket of its own), so a basic proxy works:

```nginx
server {
    listen 80;
    server_name portal.example.org;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add TLS with [certbot](https://certbot.eff.org/):

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d portal.example.org
```

Remember the **SVXReflectorFeed** WebSocket is a separate service that browsers
connect to directly; expose it over `wss://` (its own TLS / reverse proxy) so it
works from the HTTPS portal.

## Project layout

| Path                         | Purpose                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| [`server.js`](server.js)     | Express server: static hosting + JSON config endpoints.       |
| [`public/`](public/)         | Dashboard front-end (`index.html`, `app.js`, map, styles).    |
| [`Dockerfile`](Dockerfile)   | Container image used by Cloud Run.                            |
| [`deploy.sh`](deploy.sh)     | Cloud Run deploy helper (validates `env.yaml`).               |
| [`runlocal.sh`](runlocal.sh) | Run locally with `env.yaml` loaded.                           |
| `env.yaml`                   | Your configuration (copied from `env.yaml.example`).          |

## License

See repository for license information.
