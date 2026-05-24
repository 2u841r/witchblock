(function () {
  'use strict';

  let adWasActive = false;
  let recovering = false;

  function getVideo() { return document.querySelector('video'); }

  function reload() {
    if (recovering) return;
    recovering = true;
    console.log('[WitchBlock] player dead after ad, reloading');
    window.location.reload();
  }

  // Check if video is advancing; if not after grace period, reload
  function scheduleCheck() {
    const v = getVideo();
    const t0 = v ? v.currentTime : -1;
    setTimeout(() => {
      const v2 = getVideo();
      if (v2 && v2.currentTime > t0) return; // playing fine
      reload();
    }, 2500);
  }

  try {
    const bc = new BroadcastChannel('witchblock');
    bc.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'adStart') adWasActive = true;
      if (data.type === 'adEnd')   { adWasActive = false; scheduleCheck(); }
    };
  } catch (_) {}

  // Watchdog: catches cases where adEnd BC never fires
  let lastTime = -1;
  let lastMoved = Date.now();

  setInterval(() => {
    const v = getVideo();
    if (!v || v.ended || v.error) { lastMoved = Date.now(); lastTime = -1; return; }

    if (v.currentTime !== lastTime) {
      lastTime = v.currentTime;
      lastMoved = Date.now();
      return;
    }

    const stalledMs = Date.now() - lastMoved;
    // Stalled while player thinks it's playing: 10s threshold
    if (!v.paused && stalledMs > 10000) { reload(); return; }
    // Paused during/after ad for 15s: player probably died
    if (v.paused && adWasActive && stalledMs > 15000) { reload(); }
  }, 1000);
})();
