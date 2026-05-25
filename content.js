(function () {
  'use strict';

  let wasEverPlaying = false;
  let recovering = false;
  let overlay = null;

  function getVideo() { return document.querySelector('video'); }

  function showOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'witchblock-overlay';
    overlay.textContent = 'Skipping ads...';
    Object.assign(overlay.style, {
      position: 'fixed', bottom: '80px', left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.75)', color: '#fff',
      font: '600 14px/1 sans-serif', padding: '8px 16px',
      borderRadius: '4px', zIndex: '9999',
      pointerEvents: 'none', letterSpacing: '0.02em',
    });
    document.body.appendChild(overlay);
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
  }

  function reload() {
    if (recovering) return;
    recovering = true;
    hideOverlay();
    console.log('[WitchBlock] player recovery: reloading');
    window.location.reload();
  }

  function scheduleCheck() {
    const v = getVideo();
    const t0 = v ? v.currentTime : -1;
    setTimeout(() => {
      const v2 = getVideo();
      if (v2 && v2.currentTime > t0) { hideOverlay(); return; }
      reload();
    }, 2500);
  }

  try {
    const bc = new BroadcastChannel('witchblock');
    bc.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'adStart') showOverlay();
      if (data.type === 'adEnd')   scheduleCheck();
    };
  } catch (_) {}

  let lastTime = -1;
  let lastMoved = Date.now();

  setInterval(() => {
    const v = getVideo();
    if (!v) return;

    if (v.currentTime !== lastTime) {
      lastTime = v.currentTime;
      lastMoved = Date.now();
      if (v.currentTime > 0) { wasEverPlaying = true; hideOverlay(); }
      return;
    }

    const ms = Date.now() - lastMoved;

    if ((v.error || v.ended) && wasEverPlaying && ms > 3000) { reload(); return; }
    if (!v.paused && !v.error && !v.ended && ms > 10000)     { reload(); return; }
    if (v.paused && wasEverPlaying && ms > 20000)            { reload(); }
  }, 1000);
})();
