# Surface Browser

Surface Browser is an immersive 3D web browser art piece by Tim Plaisted. Enter
a web address, an image search or an AI image prompt, and the images found
stream toward you through a curving tunnel, which opens into an interactive
sphere of those images. Rotate the sphere, select an image, and you travel
onward to whatever it links to.

This repository is the Three.js / WebXR version and the Node service that feeds
it. It runs in a desktop or mobile browser and in VR on Meta Quest (2, 3, 3S) and
Pico 4 Ultra.
[About the work](https://boxc.net/surfacebrowser.html)

## Run it locally

Needs Node 24+ from https://nodejs.org/ (see `.nvmrc`).

```bash
npm install
cp .env.example .env

npm run dev:api    # terminal 1: API on :8788
npm run dev        # terminal 2: web page on :5173
```

Open <http://localhost:5173>. Web addresses work with no keys at all.

- **Image search** needs a provider key in `.env` (Serper, Brave, or your own
  endpoint).
- **AI images** are off until you configure a provider: a hosted one (fal) or a
  local one that speaks the Stable Diffusion WebUI API (AUTOMATIC1111,
  Draw Things). Ideally one that allows editing images such as Flux 2 Klein.
- **Pages that build their images with JavaScript** need the optional browser
  renderer: `npx playwright install chromium`, then `PLAYWRIGHT_ENABLED=1`.

`.env.example` lists every setting with its default.

## In a headset

WebXR needs HTTPS. The simplest route is a tunnel to the web port only; the page
calls the API through relative `/api/...` paths, which Vite proxies.

```bash
ngrok http 5173
```

Open the HTTPS address in the headset's browser and press **Enter VR**. Press `?`
on the page, or the Help button in VR, for the controls.

## Hosting it

`npm run build` writes the static site to `dist/`. Serve that and proxy
`/api/*` to `node server/index.js`, on one origin. Before putting it on the
open internet, read the "Hardening for a public host" section of
`.env.example`: by default the server trusts its local network.

## Tests

```bash
npm test
```

## Layout

- `index.html`, `src/` — the WebXR / Three.js page
- `server/` — page extraction, image proxy, search, AI relay, speech to text
- `shared/` — code used by both
- `scripts/` — the test suite and AI image tooling

## Contributing

This repository is a published snapshot; development happens elsewhere and
arrives here as one commit per release. Issues and pull requests are welcome,
and accepted changes are carried across by hand, so a merged contribution shows
up in the next release rather than as your commit.

## Licence

The software is MIT licensed: see `LICENSE`. The artwork — the name, the visual
and spatial design, and any images shipped with a release — is licensed
separately under CC BY-NC-SA 4.0: see `LICENSE-ART`.
