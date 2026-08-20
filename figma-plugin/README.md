# Luminesce Figma plugin

Exports the selected layer/frame as PNG (2x) and converts it to a glowing
Ultra HDR gain-map JPEG using the same encoder as the website. The file
downloads via the browser; nothing leaves your machine.

## Install (development)

1. Figma desktop app -> Plugins -> Development -> Import plugin from manifest
2. Pick `figma-plugin/manifest.json`
3. Select a layer -> Plugins -> Development -> Luminesce

`ui.html` inlines a copy of `docs/app.js` (Figma plugins must be
self-contained). If the encoder changes, re-copy it.

Publishing to Figma Community requires a Figma account review; this folder
is import-ready as-is.
