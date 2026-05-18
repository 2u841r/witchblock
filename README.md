# WitchBlock — Firefox Extension

Strips server-side stitched ads from Twitch HLS playlists by injecting a
`fetch` hook into the Amazon IVS WASM worker before it initializes.

## How it works

The IVS worker fetches an M3U8 playlist every few seconds. Ad breaks are
signaled by `#EXT-X-DATERANGE` markers with Twitch-specific attributes. We
prepend a self-contained IIFE to the worker script that wraps `self.fetch`,
reads each M3U8 response, strips ad segments, and returns the cleaned body.

## Development journey

### Goal

Block Twitch stitched (SSAI) ads. Twitch injects ads directly into the HLS
stream as extra video segments, marked with custom M3U8 tags. Removing those
tags and their associated segments before the player sees them means no ad
plays.

### Attempt 1: Tampermonkey

Tampermonkey scripts run in the page's JS context. The natural approach is to
hook `window.fetch` and intercept M3U8 responses.

**Why it fails:** Twitch streams through Amazon IVS, which runs inside a
dedicated Web Worker (`amazon-ivs-wasmworker.min-*.js`). Dedicated workers
have their own global scope (`self`), completely separate from `window`. A
Tampermonkey hook on `window.fetch` never touches the worker's `self.fetch`.
There is no way for page-context JS to reach into a dedicated worker's scope.

### Attempt 2: Firefox extension with `filterResponseData` on `ttvnw.net`

Firefox MV2 extensions can use `browser.webRequest.filterResponseData` to
intercept and rewrite response bodies. The plan was to intercept M3U8
responses from `*.ttvnw.net` (Twitch's CDN) and strip ad segments.

**Why it fails:** Firefox's `webRequest` API does not expose network requests
made from inside dedicated Web Workers. The worker's `fetch()` calls to
`ttvnw.net` are invisible to the extension's `onBeforeRequest` listener.
Confirmed by adding a debug listener on `<all_urls>` — requests from
`assets.twitch.tv` (page-level script loads) appeared, but zero requests from
`ttvnw.net` (worker-level M3U8 fetches) appeared.

### Attempt 3: Intercept the worker script itself

Key insight: while the worker's *fetches* are invisible to `webRequest`, the
worker *script file* is fetched by the page and is visible as a normal
`script` or `other` type request from `assets.twitch.tv`.

The IVS worker captures `self.fetch` at module initialization time:

```js
T = self.fetch.bind(self)
```

If we prepend our hook IIFE to the worker script before that line runs, `T`
becomes our hook. The worker then uses our patched fetch for all its M3U8
requests for the lifetime of the stream.

**Implementation:**

1. Listen for `*://assets.twitch.tv/assets/amazon-ivs-wasmworker*` in
   `onBeforeRequest`.
2. Use `filterResponseData` to buffer the full worker JS response.
3. In `onstop`, prepend the hook IIFE (encoded as UTF-8 bytes) before the
   original script bytes.
4. Write the patched buffer and call `filter.close()`.

**Bug discovered:** The WASM binary (`amazon-ivs-wasmworker.min-*.wasm`) has
the same URL prefix and also matched the listener pattern. The filter was
buffering and rewriting the binary WASM file, corrupting it (`wasm validation
error: at offset 4: failed to match magic number`). Fix: guard the listener
with `if (!details.url.includes('.js')) return;` so WASM and other assets
pass through untouched.

**Result:** Working. The hook intercepts every M3U8 poll, strips ad segments,
and the player receives clean playlists. Confirmed output:

```
[TwitchAdBlock] ad stripped — removed 8 segments from https://aps31.playlist.ttvnw.net/...
```

The player detects a gap where ad segments were removed and jumps over it
(`jumping 14.116s gap`), returning to live content immediately.

### What is NOT blocked

CSAI (client-side ad insertion) is a separate system. Twitch makes a request
to `edge.ads.twitch.tv` to fetch ad metadata and plays a client-side ad
independently of the HLS stream. This extension does not block CSAI. A CORS
error for `edge.ads.twitch.tv` in the console is Twitch's CSAI request being
blocked by uBlock Origin (which was active during testing), not this extension.

---

## Why this approach cannot work in Chromium (Chrome, Brave, Edge)

Chrome deprecated Manifest V2 and requires extensions to use Manifest V3. The
critical difference:

| Capability | MV2 (Firefox) | MV3 (Chrome) |
|---|---|---|
| Modify response body | `filterResponseData` | Not available |
| Block requests | `webRequest` blocking | `declarativeNetRequest` |

MV3's `declarativeNetRequest` can block or redirect requests but **cannot
modify response bodies**. There is no equivalent to `filterResponseData` in
Chrome MV3. Without response body modification, there is no way to intercept
the worker script and prepend code to it.

Firefox continues to support MV2 and `filterResponseData`, which is why this
approach is Firefox-only.

A Chromium-based solution would require either:
- Forking Chromium/Brave and patching the browser itself to add
  response-body interception at the network layer.
- A proxy (e.g., mitmproxy) sitting between the browser and Twitch's CDN,
  which intercepts and rewrites M3U8 responses at the network level. See
  `../twitch/mitmproxy/` for that approach.

---

## Files

```
firefox-twitch/
├── manifest.json       MV2 manifest
├── background.js       worker hook IIFE + onBeforeRequest listener
└── icons/
    ├── icon-48.svg     extension manager icon
    └── icon-96.svg     high-DPI extension manager icon
```

## Install (temporary, for testing)

1. Open `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `manifest.json`

## Install (permanent, signed)

Firefox requires extensions to be signed by Mozilla unless you use Developer
Edition or Nightly with `xpinstall.signatures.required` set to `false` in
`about:config`.

To get a signed `.xpi`:

1. Create an account at [addons.mozilla.org](https://addons.mozilla.org)
2. Install `web-ext`: `npm install -g web-ext`
3. Package and submit for signing:
   ```
   web-ext sign --api-key=<AMO_JWT_ISSUER> --api-secret=<AMO_JWT_SECRET>
   ```
4. AMO returns a signed `.xpi` you can distribute or install directly.

Alternatively, list it publicly on AMO and users can install it from there.

## Note on Manifest Version

This extension uses Manifest V2, not V3. That is intentional.
`browser.webRequest.filterResponseData` (response body rewriting) only exists
in MV2. Chrome removed it in MV3, which is why this extension is
Firefox-only. Firefox continues to support MV2 indefinitely for this reason.
