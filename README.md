# Photo Row Layout

Write image-heavy notes and see the finished layout while you write — not after you publish.

- **Images written one after another in a single paragraph become one equal-height row.** Mixed portrait and
  landscape shots share the row by width ratio, nothing gets cropped.
- **Captions come from the alt text**, and camera data (EXIF) can be appended on a second line.
- **Real dimensions and multi-width `srcset`** are used when they are known, so rows do not jump around while
  images load and the browser picks the right file for the screen.
- ` ```photos ` fenced blocks give you **grid / masonry / horizontal scroll** and explicit row widths.
- Works in **reading view and live preview** (live preview can miss the fence options if the block is nested
  very deep — it falls back to the default row).

The layout rules are shared with a static-site generator, so the preview is what the built page will show.

## Install

**Community plugins** — search for "Photo Row Layout" in *Settings → Community plugins → Browse*.

**Manually** — download `main.js`, `manifest.json` and `styles.css` from the latest release into
`<your vault>/.obsidian/plugins/photo-row-layout/`, then enable the plugin and reload Obsidian.

## How to write

Ordinary Markdown. Nothing to switch on:

```markdown
![Bridge at dawn](/img/photos/post-images/9a12ae1134/1920.webp)

![Bridge at dawn](/img/photos/post-images/9a12ae1134/1920.webp)
![The old harbour](/img/photos/post-images/f3c5b8b5e4/1920.webp)
```

| What you write | What you get |
| --- | --- |
| One image per paragraph | A single full-width image |
| Several images in the **same** paragraph (single line breaks, no blank line) | One equal-height row |
| Images separated by blank lines | One row per image |
| `![Caption text](…)` | Caption under the image |
| An empty alt text | No caption |

### Fenced blocks

Use a ` ```photos ` block when you want to control the layout. Options go on the info line:

````markdown
```photos wide 2
![](/img/photos/post-images/9a12ae1134/1920.webp)
![](/img/photos/post-images/f3c5b8b5e4/1920.webp)
![](/img/photos/post-images/ce710a1bf0/1920.webp)
![](/img/photos/post-images/ede3dc2183/1920.webp)
```
````

| Option | Effect |
| --- | --- |
| `col` (default) | Keep the row inside the text column |
| `wide` / `full` | Let the row break out of the text column (exact widths depend on your site's CSS) |
| `grid` / `grid 4` | Grid with square crops, 3 columns by default |
| `masonry` / `masonry 3` | Masonry, each image keeps its own ratio |
| `scroll` | Horizontal scroll, one image per screen |
| `crop` / `nocrop` | Force or forbid crop-to-align |
| `ar=3/2` | Crop everything to one ratio |
| `2` `3` `4` | Images per row (more than that wraps onto further rows) |
| `# comment` | Ignored line |

Fence options cannot be set on plain paragraphs — those always use the default row.

## Settings

| Setting | What it does |
| --- | --- |
| **Album index URL** | Optional. A JSON map of image hash → dimensions, variant widths and EXIF, fetched once at startup. With it, rows are planned before the images load, using real ratios and captions. Without it, each row is planned from the image's natural size after it loads. |
| **Site base URL** | Optional. Prefix added to root-relative image paths (`/img/photos/…`) so previews can load them. Leave empty to leave paths exactly as written. |
| **Show capture data under captions** | Camera, lens, focal length, aperture, shutter and ISO, when the index provides them. |
| **Image upload** | Optional, off by default. When enabled, a pasted or dropped image is posted to your own endpoint and the path it returns is inserted instead of a file landing in your vault. |
| **Direct base URL** | Optional. When this base answers, previews load images from it instead of the site base — handy for a LAN or CDN mirror. Probed at startup and every 3 minutes, cached per probe. |

### Album index format

Any URL returning a JSON object keyed by image hash works:

```json
{
  "9a12ae1134": {
    "album": "post-images",
    "width": 7952,
    "height": 5304,
    "widths": [640, 1280, 1920],
    "hasAvif": false,
    "exif": {
      "camera": "SONY ILCE-7M3",
      "lens": "FE 35mm F1.8",
      "focal": "35mm",
      "aperture": "f/1.8",
      "shutter": "1/250",
      "iso": 100
    }
  }
}
```

An image URL is matched against the index when it looks like
`…/<album>/<hash>/<width>.webp` (or `.avif`). Everything else is laid out from its natural size.

### Upload endpoint (optional)

The plugin sends a `POST` with the raw image bytes:

```
POST <upload URL>?album=<album>&name=<url-encoded file name>
Content-Type: application/octet-stream
Authorization: Bearer <token>
```

It expects a JSON response such as:

```json
{
  "ok": true,
  "hash": "9a12ae1134",
  "album": "post-images",
  "alt": "",
  "width": 7952,
  "height": 5304,
  "widths": [640, 1280, 1920],
  "url": "/img/photos/post-images/9a12ae1134/1920.webp",
  "exif": { "camera": "SONY ILCE-7M3" }
}
```

`url` is inserted into the note; the metadata is used right away for layout, so the new image is laid out like
the rest without waiting for the index to be fetched again. If the request fails, nothing is inserted and the
image stays on your clipboard.

## Privacy

The plugin has no telemetry and no analytics. It makes network requests only to the URLs you configure in its
settings: the album index, the direct base (a single reachability probe), and the upload endpoint when you
enable uploading.

## Development

The row engine is a mirror of the one used by the site generator this plugin was written for, and the two are
kept in sync by an equivalence test against the same album data. If you fork this and change the engine, keep
`main.js`'s row-engine section self-contained: it must stay free of Obsidian APIs so it can be unit-tested in
plain Node.

## License

MIT — see [LICENSE](LICENSE).
