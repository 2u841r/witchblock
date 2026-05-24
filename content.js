(function () {
  'use strict';

  let wasEverPlaying = false;
  let recovering = false;

  function getVideo() { return document.querySelector('video'); }

  function reload() {
    if (recovering) return;
    recovering = true;
    console.log('[WitchBlock] player recovery: reloading');
    window.location.reload();
  }

  function scheduleCheck() {
    const v = getVideo();
    const t0 = v ? v.currentTime : -1;
    setTimeout(() => {
      const v2 = getVideo();
      if (v2 && v2.currentTime > t0) return;
      reload();
    }, 2500);
  }

  try {
    new BroadcastChannel('witchblock').onmessage = ({ data }) => {
      if (data && data.type === 'adEnd') scheduleCheck();
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
      if (v.currentTime > 0) wasEverPlaying = true;
      return;
    }

    const ms = Date.now() - lastMoved;

    // Video entered error/ended state after previously playing = post-ad death
    if ((v.error || v.ended) && wasEverPlaying && ms > 3000) { reload(); return; }
    // Stalled while IVS thinks it's playing (buffering stall)
    if (!v.paused && !v.error && !v.ended && ms > 10000) { reload(); return; }
    // Paused with empty buffer for 20s (stall-pause, not user pause)
    if (v.paused && wasEverPlaying && ms > 20000) { reload(); }
  }, 1000);
})();
