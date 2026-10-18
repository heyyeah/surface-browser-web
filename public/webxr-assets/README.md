Vendored subset of `@webxr-input-profiles/assets@1.0.20` (MIT, see LICENSE.md),
served same-origin so hand/controller models need no third-party fetch.

Trimmed from the full ~100 MB registry to the profiles this app actually uses:
`generic-hand` (hand-tracking mesh, every headset) plus three controller
profiles covering the headsets Tim tests — `oculus-touch-v2` (Quest 2),
`meta-quest-touch-plus` (Quest 3 / 3S), `pico-4` (Pico 4), `pico-4u` (Pico 4
Ultra). `profilesList.json` lists only these folders: a listed id with no folder
here fails to load instead of falling through to the source's next profile
(see src/hands.js).

To add a profile: download the same package version from npm, copy the
profile's folder in whole (profile.json + its .glb files) under `profiles/`,
and add its entry to `profilesList.json`.
