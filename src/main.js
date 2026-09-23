/*
 * Photo Row Layout — Obsidian plugin
 *
 * Renders image rows in reading view and live preview the way a published site will:
 *   images written one after another in a single paragraph → one equal-height row
 *   ```photos fenced block → a group of images, options on the info line (wide 2 / grid / masonry / scroll …)
 *   caption = alt text, capture data (EXIF) on a second line under it
 *   multi-width srcset and aspect ratios carried over, so preview matches the built page
 *
 * The row engine is mirrored in the site project (src/lib-photos.mjs): change one, change the other,
 * or preview and site drift apart. Nothing here talks to the network unless you configure it:
 *   · "Album index URL" — optional JSON map of hash → width/height/variant widths/EXIF
 *   · "Image upload" — optional, off by default, posts pasted images to your own endpoint
 *
 * Single file, zero dependencies: Obsidian supplies require('obsidian') at load time, no bundling.
 */
const { Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require('obsidian')

const DEFAULT_ALBUM = 'post-images'
const UPLOAD_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif'])

/* ==================== row engine (mirrored in the site's src/lib-photos.mjs) ==================== */

const PIPELINE = /\/img\/photos\/([^/]+)\/([0-9a-fA-F]{6,})\/\d+\.(?:webp|avif)(?:[?#].*)?$/
const WIDTHS = { col: 640, wide: 1080, full: 1600 }
const IMG_LINE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["']([^"']*)["'])?\s*\)$/

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const r3 = (v) => Math.round(v * 1000) / 1000

const exifText = (e) =>
  !e
    ? ''
    : [e.camera, e.lens, e.focal, e.aperture, e.shutter, e.iso ? `ISO ${e.iso}` : '']
        .filter(Boolean)
        .join(' · ')

function parseOpts(meta = '') {
  const o = { width: 'col', mode: 'row', crop: false, nocrop: false, ar: null, cols: 0, grid: false }
  for (const tok of String(meta).split(/[\s,]+/).filter(Boolean)) {
    const t = tok.toLowerCase()
    if (t === 'full' || t === 'wide' || t === 'col' || t === 'block') o.width = t === 'block' ? 'col' : t
    else if (t === 'grid') {
      o.crop = true
      o.ar = 1
      o.grid = true
    } else if (t === 'masonry' || t === 'scroll') o.mode = t
    else if (t === 'crop') o.crop = true
    else if (t === 'nocrop') o.nocrop = true
    else if (t.startsWith('ar=')) {
      const [a, b] = t.slice(3).split('/')
      const v = parseFloat(a) / parseFloat(b || 1)
      if (v > 0.2 && v < 5) o.ar = v
    } else if (/^\d$/.test(t) && +t >= 1 && +t <= 6) o.cols = +t
  }
  if (o.grid && !o.cols) o.cols = 3
  return o
}

function plan(items, opts) {
  const n = items.length
  const ars = items.map((it) => it.ratio ?? 1.5)
  const even = Array.from({ length: n }, () => 1 / n)

  // ar= / grid also apply to a single image (a grid row often ends with one; uncropped it stands out)
  if (opts.ar) return { ar: ars.map(() => opts.ar), fb: even }
  if (n === 1) return { ar: [ars[0]], fb: [1] }
  if (opts.mode === 'masonry' || opts.mode === 'scroll') return { ar: ars, fb: even }

  const proportional = () => {
    const a = [...ars]
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) if (i !== j && a[i] / a[j] > 2.5) a[i] = a[j] * 2.5
    const s = a.reduce((x, y) => x + y, 0)
    return { ar: a, fb: a.map((x) => x / s) }
  }

  if (opts.nocrop) return proportional()
  if (n === 2 && !opts.crop) return proportional()

  const sorted = [...ars].sort((x, y) => x - y)
  if (!opts.crop && sorted[n - 1] / sorted[0] <= 1.08) return { ar: ars, fb: even }
  const med = clamp(sorted[Math.floor(n / 2)], 0.7, 1.6)
  return { ar: ars.map(() => med), fb: even }
}

const widthClass = (width) => (width === 'wide' ? 'hh-pw-wide' : width === 'full' ? 'hh-pw-full' : '')

function sizesFor(width, n, frac) {
  const px = WIDTHS[width] ?? WIDTHS.col
  if (n === 1) return `(max-width: ${px}px) 100vw, ${px}px`
  const pct = Math.max(10, Math.round(100 * frac))
  return `(max-width: ${px}px) ${pct}vw, ${Math.round(px * frac)}px`
}

/* ==================== plugin ==================== */

// Row state: laid-out row → { items, opts, figures }, used to re-plan once real sizes are known
const ROWS = new WeakMap()

class PhotoLayoutPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {}
    this.settings = Object.assign(
      {
        dataUrl: '', // optional album index: hash → size / variant widths / EXIF
        siteBase: '', // optional prefix for root-relative image paths
        directBase: '', // optional faster mirror, used when it answers
        showExif: true,
        enableUpload: false, // opt-in: nothing leaves the vault unless you say so
        uploadUrl: '',
        token: '',
        album: DEFAULT_ALBUM,
      },
      saved
    )
    this.index = new Map()
    this.directOk = { at: 0, ok: false } // reachability of directBase, cached for a few minutes

    this.registerMarkdownPostProcessor((el, ctx) => this.render(el, ctx))

    // Pasted / dropped images can be routed through an upload endpoint instead of the vault.
    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor) => this.maybeUpload(evt, editor)))
    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor) => this.maybeUpload(evt, editor)))

    this.addSettingTab(new PhotoLayoutSettingTab(this.app, this))

    // Base URL previews load images from: the site base, unless a direct base answers first.
    this.displayBase = tidyBase(this.settings.siteBase)

    // The index arrives asynchronously; re-render what is open once it does.
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.dataUrl) {
        const n = await this.refreshIndex()
        if (n > 0) this.rerenderOpenViews()
      }
      await this.updateDisplayBase()
      // Network can change (home ↔ away): re-probe, but only when a direct base is configured.
      if (tidyBase(this.settings.directBase))
        this.registerInterval(window.setInterval(() => this.updateDisplayBase(), 3 * 60 * 1000))
    })
  }

  async refreshIndex() {
    if (!this.settings.dataUrl) return 0 // no index configured: rows use each image's natural size
    try {
      const json = await this.getJson(this.settings.dataUrl)
      this.index = new Map(Object.entries(json))
      return this.index.size
    } catch (err) {
      console.warn('[Photo Row Layout] Could not load the album index, falling back to natural sizes:', err)
      return 0
    }
  }

  /** Cross-origin JSON: prefer requestUrl (built into Obsidian, immune to CORS), fall back to fetch. */
  async getJson(url) {
    if (typeof requestUrl === 'function') {
      const res = await requestUrl({ url, cache: 'no-store' })
      if (res.status >= 400) throw new Error(String(res.status))
      return res.json
    }
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    return res.json()
  }

  rerenderOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view
      try {
        view.previewMode?.rerender?.(true)
      } catch {
        /* Live preview has no such object; the next scroll or edit re-renders it */
      }
    }
  }

  /* ---------- pasted / dropped images → upload → inserted markdown ---------- */

  /**
   * Optional. Hand the image to your own upload endpoint and insert the path it returns,
   * rather than letting Obsidian copy the file into the vault.
   */
  async maybeUpload(evt, editor) {
    if (!this.uploadReady()) {
      if (this.settings.enableUpload)
        new Notice('Image upload is on, but the upload URL or token is missing (Settings → Photo Row Layout).')
      return // not configured — leave Obsidian's own paste/drop behaviour alone
    }
    const files = imageFilesOf(evt)
    if (!files.length || !editor) return
    evt.preventDefault()

    const album = this.settings.album || DEFAULT_ALBUM
    const notice = new Notice(`Uploading 1/${files.length}…`, 0)
    const lines = []
    try {
      for (const [i, f] of files.entries()) {
        notice.setMessage(`Uploading ${i + 1}/${files.length}: ${f.name || 'clipboard image'} (${mb(f.size)} MB)…`)
        const out = await this.uploadImage(f, album)
        lines.push(`![${out.alt}](${out.url})`)
      }
      editor.replaceSelection(lines.join('\n'))
      new Notice(`Inserted ${lines.length} image${lines.length > 1 ? 's' : ''} (album "${album}").`)
    } catch (err) {
      new Notice(`Upload failed: ${err.message}\nNothing was inserted; the image is still on your clipboard.`, 8000)
      console.warn('[Photo Row Layout] Upload failed:', err)
    } finally {
      notice.hide()
    }
  }

  /** Uploading is strictly opt-in: toggle, endpoint and token all have to be in place. */
  uploadReady() {
    const s = this.settings
    return Boolean(s.enableUpload && s.uploadUrl && s.token)
  }

  async uploadImage(file, album) {
    const body = await file.arrayBuffer()
    const name = encodeURIComponent(file.name || `paste-${Date.now()}.png`)
    const res = await requestUrl({
      url: `${this.settings.uploadUrl}?album=${encodeURIComponent(album)}&name=${name}`,
      method: 'POST',
      contentType: 'application/octet-stream',
      headers: { Authorization: `Bearer ${this.settings.token}` },
      body,
    })
    if (res.status >= 400) {
      let hint = ''
      try {
        hint = res.json?.hint || res.json?.error || ''
      } catch {
        /* No body to read — move on */
      }
      throw new Error(`${res.status} ${hint}`.trim())
    }
    const out = res.json
    if (!out?.ok || !out.url) throw new Error('Incomplete response from the upload endpoint')
    // Feed the new image into the index so it lays out by the site rules right away
    this.index.set(out.hash, {
      album: out.album,
      name: out.name,
      width: out.width,
      height: out.height,
      widths: out.widths,
      hasAvif: false,
      exif: out.exif,
    })
    return out
  }

  /* ---------- which base URL previews use: direct mirror or site ---------- */

  /** Prefer the direct base when it answers, otherwise the site base. */
  async updateDisplayBase() {
    const site = tidyBase(this.settings.siteBase)
    const direct = tidyBase(this.settings.directBase)
    const next = direct && (await this.directReachable(direct)) ? direct : site
    if (next !== this.displayBase) {
      this.displayBase = next
      this.rerenderOpenViews()
    }
    return next
  }

  /**
   * "Reachable" means anything answered, even a 404 — a server that is up but on a network we
   * cannot see must not win. Result cached for 3 minutes.
   */
  async directReachable(base) {
    const now = Date.now()
    if (this.directOk.at && now - this.directOk.at < 3 * 60 * 1000) return this.directOk.ok
    let ok = false
    try {
      const probe =
        typeof requestUrl === 'function'
          ? requestUrl({ url: `${base}/`, throw: false }).then(() => true)
          : fetch(`${base}/`, { method: 'HEAD', mode: 'no-cors' }).then(() => true)
      ok = await Promise.race([probe.catch(() => false), sleep(1500).then(() => false)])
    } catch {
      ok = false
    }
    this.directOk = { at: now, ok }
    return ok
  }

  /* ---------- entry points ---------- */

  render(el, ctx) {
    this.processFences(el, ctx)
    this.processParagraphs(el)
  }

  /** "A paragraph holding nothing but images" → one equal-height row */
  processParagraphs(el) {
    const hits = []
    for (const p of Array.from(el.querySelectorAll('p'))) {
      const imgs = onlyImages(p)
      if (imgs) hits.push([p, imgs])
    }
    for (const [p, imgs] of hits) {
      const items = imgs.map((img) => this.resolve(img.getAttribute('src'), img.getAttribute('alt') || ''))
      p.replaceWith(this.buildRow(items, parseOpts('')))
    }
  }

  /** ```photos fenced block → a group of images */
  processFences(el, ctx) {
    const pres = []
    for (const pre of Array.from(el.querySelectorAll('pre'))) {
      const code = pre.querySelector('code') || pre
      const cls = `${pre.className || ''} ${code.className || ''}`
      if (!/\blanguage-photos?\b/.test(cls)) continue
      const items = extractFenced(code.textContent || '')
      if (items.length) pres.push([pre, items, this.fenceOpts(pre, code, ctx)])
    }

    for (const [pre, items, meta] of pres) {
      const opts = parseOpts(meta)
      let node
      if (opts.cols && opts.mode === 'row' && items.length > opts.cols) {
        // More images than columns → wrap into several rows
        node = document.createElement('div')
        node.className = ['hh-prow-set', widthClass(opts.width)].filter(Boolean).join(' ')
        for (let i = 0; i < items.length; i += opts.cols)
          node.appendChild(this.buildRow(items.slice(i, i + opts.cols), opts))
      } else {
        node = this.buildRow(items, opts)
      }
      pre.replaceWith(node)
    }
  }

  /**
  /**
   * The fence options (```photos wide 2) are gone from the rendered DOM, so fish the opening
   * line back out of the section's source text.
   */
  fenceOpts(pre, code, ctx) {
    let text = ''
    try {
      const info = ctx?.getSectionInfo?.(pre) || ctx?.getSectionInfo?.(code)
      text = info?.text || ''
    } catch {
      /* Could not get it — carry on */
    }
    const m = /^[ \t]*`{3,}[ \t]*photos?([-:\s][^\n]*)?$/m.exec(text)
    if (!m) return ''
    return (m[1] || '').replace(/[-:]/g, ' ').trim()
  }

  /* ---------- URL → metadata ---------- */

  resolve(url, alt) {
    // Notes hold root-relative paths (/img/photos/…) which Obsidian would look for inside the
    // vault, so previews need an absolute URL. The site itself keeps the relative path.
    const absolute = (u) => {
      if (!u || !/^\//.test(u)) return u || ''
      return `${this.displayBase || tidyBase(this.settings.siteBase)}${u}`
    }

    const out = {
      url: absolute(url),
      alt: alt || '',
      width: null,
      height: null,
      srcSet: '',
      avifSrcSet: '',
      full: absolute(url),
      exif: '',
      ratio: null,
    }
    const m = PIPELINE.exec(url || '')
    const it = m ? this.index.get(m[2]) : null
    if (!it) return out

    const widths = (Array.isArray(it.widths) && it.widths.length ? [...it.widths] : [it.width])
      .filter((w) => Number.isFinite(w))
      .sort((a, b) => a - b)
    const base = absolute(out.url.replace(/\/(\d+)\.(?:webp|avif)$/, ''))
    const max = widths[widths.length - 1]

    out.width = it.width ?? null
    out.height = it.height ?? null
    out.full = max ? `${base}/${max}.webp` : out.url
    out.srcSet = widths.map((w) => `${base}/${w}.webp ${w}w`).join(', ')
    if (it.hasAvif) out.avifSrcSet = widths.map((w) => `${base}/${w}.avif ${w}w`).join(', ')
    out.exif = this.settings.showExif ? exifText(it.exif) : ''
    out.ratio = it.width && it.height ? it.width / it.height : null
    return out
  }

  /* ---------- DOM ---------- */

  buildRow(items, opts) {
    const n = items.length
    const { ar, fb } = plan(items, opts)

    const row = document.createElement('div')
    row.className = ['hh-prow', `hh-prow-n${n}`, widthClass(opts.width)].filter(Boolean).join(' ')
    row.setAttribute('style', `--pn:${n}`)
    if (opts.mode === 'masonry') {
      row.classList.add('hh-prow-masonry')
      row.style.setProperty('--pcols', String(Math.min(n, opts.cols || 2)))
    }
    if (opts.mode === 'scroll') row.classList.add('hh-prow-scroll')

    const figures = items.map((it, i) => this.buildFigure(it, ar[i], fb[i], sizesFor(opts.width, n, fb[i]), opts))
    for (const f of figures) row.appendChild(f)

    // One item without metadata changes every column width in the row — replan once images load
    if (items.some((it) => !it.ratio)) {
      ROWS.set(row, { items, opts, figures })
      for (const f of figures) {
        const img = f.querySelector('img')
        if (!img) continue
        const fix = () => this.relayout(row)
        if (img.complete) fix()
        else img.addEventListener('load', fix, { once: true })
      }
    }
    return row
  }

  relayout(row) {
    const state = ROWS.get(row)
    if (!state) return
    let changed = false
    for (const [i, fig] of state.figures.entries()) {
      const img = fig.querySelector('img')
      if (!img || !img.naturalWidth || !img.naturalHeight) continue
      if (state.items[i].ratio) continue
      state.items[i].ratio = img.naturalWidth / img.naturalHeight
      changed = true
    }
    if (!changed) return

    const n = state.items.length
    const { ar, fb } = plan(state.items, state.opts)
    state.figures.forEach((fig, i) => {
      fig.style.setProperty('--ar', String(r3(ar[i])))
      fig.style.setProperty('--fb', String(r3(fb[i])))
    })
    ROWS.delete(row)
  }

  buildFigure(item, ar, fb, sizes, opts) {
    const fig = document.createElement('figure')
    fig.className = 'hh-pfig'
    if (opts.mode !== 'masonry' && opts.mode !== 'scroll') {
      fig.setAttribute('style', `--ar:${r3(ar)};--fb:${r3(fb)}`)
    }

    const img = document.createElement('img')
    img.setAttribute('src', item.full)
    if (item.srcSet) {
      img.setAttribute('srcset', item.srcSet)
      img.setAttribute('sizes', sizes)
    }
    if (item.width) img.setAttribute('width', String(item.width))
    if (item.height) img.setAttribute('height', String(item.height))
    img.setAttribute('alt', item.alt)
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
    img.dataset.exif = item.exif
    fig.appendChild(img)

    if (item.alt || item.exif) {
      const cap = document.createElement('figcaption')
      cap.appendChild(document.createTextNode(item.alt))
      if (item.exif) {
        const span = document.createElement('span')
        span.className = 'hh-pfig-exif'
        span.textContent = item.exif
        cap.appendChild(span)
      }
      fig.appendChild(cap)
    }
    return fig
  }
}

/* ==================== helpers ==================== */

/** Anything in this paragraph besides images and line breaks? Return the images if not. */
function onlyImages(p) {
  const imgs = []
  for (const n of Array.from(p.childNodes)) {
    if (n.nodeType === 3) {
      if (n.textContent.trim()) return null
      continue
    }
    if (n.nodeType !== 1) continue
    if (n.tagName === 'BR') continue
    if (n.tagName === 'IMG') {
      imgs.push(n)
      continue
    }
    return null
  }
  return imgs.length ? imgs : null
}

function extractFenced(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const m = IMG_LINE.exec(s)
    if (m) out.push({ url: m[2], alt: m[1] || m[3] || '', width: null, height: null, srcSet: '', avifSrcSet: '', full: m[2], exif: '', ratio: null })
  }
  return out
}

/* ---------- upload helpers ---------- */

/** Pick the image files out of a paste/drop event (both carry a FileList) */
function imageFilesOf(evt) {
  const dt = evt?.clipboardData || evt?.dataTransfer
  if (!dt) return []
  const raw = dt.files && dt.files.length ? Array.from(dt.files) : Array.from(dt.items ?? [])
  return raw
    .map((f) => (typeof File !== 'undefined' && f instanceof File ? f : f.getAsFile?.()))
    .filter(Boolean)
    .filter((f) => {
      const ext = String(f.name || '').split('.').pop().toLowerCase()
      return (f.type || '').startsWith('image/') || UPLOAD_EXTS.has(ext)
    })
}

const mb = (n) => ((Number(n) || 0) / 1024 / 1024).toFixed(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tidyBase = (u) => String(u || '').replace(/\/+$/, '')

class PhotoLayoutSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('Album index URL')
      .setDesc('JSON map of image hash → width, height, variant widths and EXIF, fetched once at startup. Without it, rows are planned from each image\'s real size once it loads.')
      .addText((t) =>
        t.setValue(this.plugin.settings.dataUrl).onChange(async (v) => {
          this.plugin.settings.dataUrl = v.trim()
          await this.plugin.saveData(this.plugin.settings)
        })
      )

    new Setting(containerEl)
      .setName('Site base URL')
      .setDesc('Prefix added to root-relative image paths in your notes (e.g. /img/photos/…) so previews can load them. Leave empty to leave paths untouched.')
      .addText((t) =>
        t.setValue(this.plugin.settings.siteBase).onChange(async (v) => {
          this.plugin.settings.siteBase = v.trim()
          await this.plugin.saveData(this.plugin.settings)
          await this.plugin.updateDisplayBase()
        })
      )

    new Setting(containerEl)
      .setName('Show capture data under captions')
      .setDesc('Camera, lens, focal length, aperture, shutter and ISO, when the album index has them.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showExif).onChange(async (v) => {
          this.plugin.settings.showExif = v
          await this.plugin.saveData(this.plugin.settings)
          this.plugin.rerenderOpenViews()
        })
      )

    new Setting(containerEl).setName('Image upload').setHeading()

    new Setting(containerEl)
      .setName('Upload pasted and dropped images')
      .setDesc('Off by default. When on, an image you paste or drop is posted to the upload URL and the path it returns is inserted, instead of a copy landing in the vault.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableUpload).onChange(async (v) => {
          this.plugin.settings.enableUpload = v
          await this.plugin.saveData(this.plugin.settings)
        })
      )

    new Setting(containerEl)
      .setName('Upload URL')
      .setDesc('Endpoint that accepts the raw image bytes as a POST body — see the README for the request and response shape.')
      .addText((t) =>
        t.setValue(this.plugin.settings.uploadUrl).onChange(async (v) => {
          this.plugin.settings.uploadUrl = v.trim()
          await this.plugin.saveData(this.plugin.settings)
        })
      )

    new Setting(containerEl)
      .setName('Upload token')
      .setDesc('Sent as an Authorization: Bearer header. Uploads stay disabled without it.')
      .addText((t) => {
        t.setValue(this.plugin.settings.token).onChange(async (v) => {
          this.plugin.settings.token = v.trim()
          await this.plugin.saveData(this.plugin.settings)
        })
        t.inputEl.type = 'password'
        return t
      })

    new Setting(containerEl)
      .setName('Album')
      .setDesc('Album name passed to the upload endpoint.')
      .addText((t) =>
        t.setValue(this.plugin.settings.album).onChange(async (v) => {
          this.plugin.settings.album = v.trim() || DEFAULT_ALBUM
          await this.plugin.saveData(this.plugin.settings)
        })
      )

    new Setting(containerEl).setName('Preview').setHeading()

    new Setting(containerEl)
      .setName('Direct base URL')
      .setDesc('When this base answers, preview images load from it instead of the site base — useful for a LAN or CDN mirror.')
      .addText((t) =>
        t.setValue(this.plugin.settings.directBase).onChange(async (v) => {
          this.plugin.settings.directBase = v.trim()
          await this.plugin.saveData(this.plugin.settings)
          this.plugin.directOk = { at: 0, ok: false }
          await this.plugin.updateDisplayBase()
        })
      )

    new Setting(containerEl)
      .setName('Current preview base')
      .setDesc('Base URL previews actually use right now.')
      .addButton((b) =>
        b.setButtonText('Probe again').onClick(async () => {
          this.plugin.directOk = { at: 0, ok: false }
          b.setButtonText((await this.plugin.updateDisplayBase()) || 'None')
        })
      )

    new Setting(containerEl)
      .setName('Album index')
      .setDesc(`${this.plugin.index.size} images loaded.`)
      .addButton((b) =>
        b.setButtonText('Reload').onClick(async () => {
          const n = await this.plugin.refreshIndex()
          b.setButtonText(n ? `${n} loaded` : 'Failed')
          this.plugin.rerenderOpenViews()
        })
      )
  }
}

// CommonJS: Obsidian loads plugins with module.exports
module.exports = PhotoLayoutPlugin
module.exports.PhotoLayoutPlugin = PhotoLayoutPlugin
module.exports._pure = { parseOpts, plan, sizesFor, widthClass, exifText, onlyImages, extractFenced }
