console.log('[WitchBlock] background script loaded');

// Code injected at the top of the IVS worker script.
// Runs before the worker captures self.fetch, so the worker
// ends up calling our hook instead of native fetch.
const WORKER_INJECT = `
(function () {
  'use strict';

  function _isAdStart(l)        { return l.startsWith('#EXT-X-DATERANGE:') && l.includes('CLASS="twitch-stitched-ad"'); }
  function _isAdQuartile(l)     { return l.startsWith('#EXT-X-DATERANGE:') && l.includes('CLASS="twitch-ad-quartile"'); }
  function _isNonLiveSource(l)  { return l.startsWith('#EXT-X-DATERANGE:') && l.includes('CLASS="twitch-stream-source"') && l.includes('X-TV-TWITCH-STREAM-SOURCE="') && !l.includes('X-TV-TWITCH-STREAM-SOURCE="live"'); }
  function _isLiveReturn(l)     { return l.startsWith('#EXT-X-DATERANGE:') && l.includes('CLASS="twitch-stream-source"') && l.includes('X-TV-TWITCH-STREAM-SOURCE="live"'); }
  function _isAdPodStart(l)     { return _isAdStart(l) || _isAdQuartile(l) || _isNonLiveSource(l); }
  function _isNonLiveExtinf(l)  {
    if (!l.startsWith('#EXTINF')) return false;
    const i = l.indexOf(','); if (i === -1) return false;
    const lbl = l.slice(i + 1).trim(); return lbl.length > 0 && lbl !== 'live';
  }

  function _filter(body) {
    const endsNL = body.endsWith('\\n');
    const out = []; let inAd = false, dropDisc = false, skipUrl = false, blocked = false, removed = 0;
    for (const line of body.split('\\n')) {
      const s = line.trim();
      if (_isAdPodStart(s))                                         { if (!inAd) { inAd = true; skipUrl = false; blocked = true; } continue; }
      if (inAd) {
        if (_isLiveReturn(s))                                       { inAd = false; dropDisc = true; skipUrl = false; continue; }
        if (s.startsWith('#EXT-X-TWITCH-PREFETCH:'))                { continue; }
        if (s === '#EXT-X-DISCONTINUITY')                           { continue; }
        if (s.startsWith('#EXTINF'))                                { skipUrl = true; continue; }
        if (s.startsWith('#'))                                      { continue; }
        if (skipUrl)                                                { skipUrl = false; removed++; continue; }
        continue;
      }
      if (dropDisc && s === '#EXT-X-DISCONTINUITY')                 { dropDisc = false; continue; }
      if (s.startsWith('#EXT-X-DATERANGE:') && s.includes('X-TV-TWITCH-AD-')) { continue; }
      if (_isNonLiveExtinf(s))                                      { skipUrl = true; continue; }
      if (skipUrl && !s.startsWith('#'))                            { skipUrl = false; continue; }
      out.push(line);
    }
    const col = []; let pd = false;
    for (const line of out) { const d = line.trim() === '#EXT-X-DISCONTINUITY'; if (d && pd) continue; col.push(line); pd = d; }
    return { text: col.join('\\n') + (endsNL ? '\\n' : ''), blocked, removed };
  }

  const _orig = self.fetch;
  if (!_orig) return;

  self.fetch = async function (input, init) {
    const response = await _orig.call(self, input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('ttvnw.net')) return response;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('mpegurl') && !ct.includes('m3u8')) return response;
    const clone = response.clone();
    try {
      const text = await response.text();
      if (!text.startsWith('#EXTM3U')) return new Response(text, { status: clone.status, headers: { 'content-type': ct } });
      const result = _filter(text);
      if (result.blocked) console.log('[WitchBlock] ad stripped — removed', result.removed, 'segments from', url.slice(0, 100));
      return new Response(result.text, { status: clone.status, headers: { 'content-type': ct } });
    } catch (e) {
      console.warn('[WitchBlock] filter error', e);
      return clone;
    }
  };

  console.log('[WitchBlock] fetch hook active in IVS worker');
})();
`;

// Intercept the IVS worker script and prepend the hook
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.includes('.js')) return;
    console.log('[WitchBlock] Intercepted IVS worker, injecting fetch hook');
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];

    filter.ondata = (event) => chunks.push(new Uint8Array(event.data));

    filter.onstop = () => {
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const original = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) { original.set(chunk, offset); offset += chunk.length; }

      const inject = new TextEncoder().encode(WORKER_INJECT);
      const patched = new Uint8Array(inject.length + original.length);
      patched.set(inject, 0);
      patched.set(original, inject.length);

      filter.write(patched.buffer);
      filter.close();
    };

    filter.onerror = () => console.warn('[WitchBlock] worker inject filter error');
  },
  {
    urls: ['*://assets.twitch.tv/assets/amazon-ivs-wasmworker*'],
    types: ['script', 'other', 'xmlhttprequest']
  },
  ['blocking']
);
