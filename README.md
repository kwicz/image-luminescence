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

## Example

| Original | Luminesced |
| --- | --- |
| <img src="examples/disco-ball.png" alt="Original watercolor disco ball" width="380"> | <img src="examples/disco-ball-luminescence.jpg" alt="Glowing version" width="380"> |

View this page in Chrome (or another Ultra HDR-aware browser) on an HDR
display: the right image's whites -- the background and the grout between
tiles -- lift off the page while the watercolor tiles stay true. On an SDR
screen the two images look identical, which is exactly the point.

To reproduce: `python3 luminescence.py examples/disco-ball.png`

### Why this tool exists

Before this tool, there were two ways to attempt an HDR glow, and each ruins
the image in its own way:

| ImageMagick ICC profile conversion | Naive HDR profile tag |
| --- | --- |
| <img src="examples/disco-ball-imagemagick.png" alt="Colors ruined by profile conversion" width="380"> | <img src="examples/disco-ball-tagged.png" alt="Glowing but oversaturated" width="380"> |
| `magick in.png -profile sRGB.icc -profile rec2020_pq.icc` rewrites the pixels -- badly. Pure white becomes murky green-gray `rgb(123,127,105)`, every color drifts with it, and there is no glow to show for it. | Untouched sRGB pixels tagged with an HDR profile. This one really glows on an HDR display -- but every color is reinterpreted in the wrong gamut, turning the pastel watercolor hot neon pink. |

This tool exists to do neither: your pixels stay exactly what you authored,
and the glow rides alongside as gain-map metadata.

## What kind of images work best

The glow is applied to pixels that are already near-white, so the effect
lives or dies on where your whites are:

- **Best**: graphics whose whites represent light -- logos with white
  marks or text, icons, sparkles and highlights, line art on colored
  backgrounds. Small, intentional white areas read as "lit up."
- **Good**: artwork with scattered near-white highlights (the disco ball
  above -- its white grout and hotspots glow like catchlights).
- **Works, but loud**: anything on a large white background -- the whole
  background glows. Striking for a hero image, blinding in a document.
- **No visible effect**: images with nothing near white (a dark photo, a
  saturated illustration). Nothing crosses the knee, so nothing glows;
  lower `--knee` to pull the glow deeper into the midtones.
- **Transparency**: JPEG output flattens alpha onto white, and that white
  background will glow. If you don't want a glowing backdrop, composite
  your art onto a colored background first.

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
python3 luminescence.py input.png [-o out.jpg] [--boost 49.26] [--knee 0.85] [--quality 95]
```

- `--boost`  max brightness of whites, as a multiple of SDR white. The
  default is the format's ceiling (10000 nits, about 49x), which means
  "as bright as the viewer's display can physically go" -- every screen
  clamps to its own maximum headroom. Pass a lower value for a gentler glow
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

## Accessibility

Luminesced images don't violate accessibility guidelines -- the glow is
static (no flashing, so WCAG's photosensitivity thresholds don't apply),
colors and contrast are unchanged, and on SDR displays or non-supporting
apps the image is simply normal. But guidelines lag the technology, and
"compliant" isn't the same as "considerate": these images deliberately
exceed the brightness the viewer chose for their screen, and there is no
built-in way for them to opt out. Someone reading in a dark room, or
sensitive to bright light, experiences your glow at full strength.

So use it thoughtfully. This is a for-fun, decorative effect -- logos,
celebration graphics, a bit of sparkle -- not something to put behind body
text, essential UI, or anything a person is forced to look at to get
something done. Small glowing accents delight; full-bleed glowing
backgrounds in someone's feed are the visual equivalent of autoplay audio.

## Roadmap

- Free client-side website (no uploads -- all conversion in the browser)
- Figma plugin (shares the website's JS math)
- macOS Finder Quick Action
- pip / Homebrew packaging
