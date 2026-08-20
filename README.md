# image-luminescence

Make ordinary images glow on HDR displays -- whites brighter than the
screen's normal white, staying bright even when the display dims -- while
keeping every color pixel-exact.

Point it at any sRGB PNG or JPEG:

```
python3 luminescence.py logo.png
```

and you get `logo-luminescence.jpg`: an Ultra HDR gain-map JPEG whose base
image is your original pixels, byte-for-byte, with near-white regions boosted
up to 4x over standard white on HDR-capable displays (macOS 14+, iOS 17+,
Chrome, Android). On SDR displays or non-supporting apps it renders as a
completely normal image -- the failure mode is "no glow," never "wrong
colors."

## How it works

A gain-map file contains two images: your untouched sRGB image, plus a small
grayscale "boost stencil" marking which pixels may exceed SDR white and by
how much. HDR-aware viewers apply the stencil; everything else ignores it.
Because the base image is literal sRGB data, color fidelity is structural --
there is no tone mapping, reference white, or per-display calibration in the
loop. (We learned this the hard way; see LIMITATIONS.md for why the
PQ-based alternative cannot guarantee a 1:1 color match.)

The stencil is generated automatically: pixels above a brightness knee
(default 85%) ramp smoothly up to the boost ceiling, scaled per-pixel across
all three channels equally so chromaticity never drifts. Anti-aliased edges
ramp smoothly -- no halos.

## Install

```
brew install imagemagick libultrahdr
```

Python 3 with numpy (ships with macOS's /usr/bin/python3).

## Usage

```
python3 luminescence.py input.png [-o out.jpg] [--boost 4] [--knee 0.85] [--quality 95]
```

- `--boost`  max brightness of whites, as a multiple of SDR white (default 4;
  the display clamps to its available headroom)
- `--knee`   how bright a pixel must be (0-1) before it starts to glow
  (default 0.85; raise to 0.95 to restrict glow to near-pure whites)
- `--quality` JPEG quality for the base and gain map (default 95)

Notes: output is JPEG, so transparency is flattened onto white. If the input
is already a JPEG its bytes are kept verbatim as the base image.

### PQ fallback: luminescence_pq.py

```
python3 luminescence_pq.py input.png [--nits 1000] [--sdr-nits 203] [--knee 0.85] [--depth 16|8] [--cicp] [--uniform]
```

Produces a 16-bit Rec.2020 PQ PNG (embedding `rec2020-pq-reference.icc`,
plus a `cICP` chunk with `--cicp`). Use this only for destinations that
support PQ PNGs but not gain-map JPEGs, and accept that PQ's absolute
luminance model means non-glowing colors can drift a few percent in
lightness depending on the viewer's display and brightness setting -- hue
never shifts. `--uniform` scales the whole image instead of only highlights.

## Tests

```
./test_luminescence.sh
```

Verifies profile embedding, white neutrality, exact color round-trips, and
that highlight mode holds colors at SDR level while whites hit the peak.

## Roadmap

- Free client-side website (no uploads -- all conversion in the browser)
- Figma plugin (shares the website's JS math)
- macOS Finder Quick Action
- pip / Homebrew packaging
