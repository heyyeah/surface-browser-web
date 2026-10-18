# Notes for AI coding agents

## What this is

A Three.js / WebXR page (`src/`, entry `src/main.js`) and an Express server
(`server/index.js`) that extracts images from web pages, proxies them, relays
image search and AI image generation. `README.md` has the run commands.

## Working rules

- Run `npm test` before and after a change. It starts real servers on free
  ports; do not run two suites at once.
- `npm run build` must pass. The page is one bundle; there is no framework.
- Nothing visual or in-headset can be verified by tests. Say what you could
  not check rather than calling it done; the person running the headset is the
  check.
- Settings resolve as: saved settings file, then environment, then default.
  A value changed in the Settings panel outranks `.env`.
- The server fetches addresses that visitors supply. Keep every outbound
  request behind the existing target checks (`assertTargetUrlAllowed`) and do
  not add a route that fetches without them.
- AI image generation costs money per image. Keep new generation paths behind
  the spend guard (`server/spend-guard.js`).
- Comments state invariants and traps, not history. Match the surrounding
  style.

## Where things are

- Tunnel: `src/tunnel*.js`. Sphere: `src/sphere.js`. Moving between them:
  `src/transitions.js`.
- Input: `src/input.js` (keyboard, mouse, controllers), `src/touch-gestures.js`,
  `src/xr-hand-gestures.js` (hand tracking).
- In-VR panels: `src/vrpanel.js`, `src/wristui.js`, `src/controller-callouts.js`.
- URL flags and build flags: `src/config.js`.
- Every server setting: `.env.example`.
