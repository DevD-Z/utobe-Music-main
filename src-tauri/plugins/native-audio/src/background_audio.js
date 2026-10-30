// BackgroundPlay — keep media playing when screen is locked or app is in background.
// Adapted from Brave Browser (brave-core) and Mozilla video-bg-play.
(function () {
  'use strict';

  // 1. Spoof Page Visibility so YouTube never knows the screen locked or app backgrounded
  try {
    Object.defineProperty(Document.prototype, 'hidden', {
      get: function () { return false; },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get: function () { return 'visible'; },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Document.prototype, 'onvisibilitychange', {
      get: function () { return null; },
      set: function () {},
      enumerable: false,
      configurable: true
    });
  } catch (e) {}

  // 2. Wrap HTMLMediaElement.prototype.play and pause to distinguish user vs WebKit pauses
  var pauseRequested = false;
  var nativePlay = null;
  try {
    if (window.HTMLMediaElement && HTMLMediaElement.prototype) {
      nativePlay = HTMLMediaElement.prototype.play;
      var nativePause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        pauseRequested = true;
        return nativePause.apply(this, arguments);
      };
      HTMLMediaElement.prototype.play = function () {
        pauseRequested = false;
        return nativePlay.apply(this, arguments);
      };
    }
  } catch (e) {}

  // Capture real visibility getter before it was spoofed
  var nativeVisibilityGet = null;
  try {
    var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    if (desc && desc.get) { nativeVisibilityGet = desc.get; }
  } catch (e) {}

  function actualVisibility() {
    try {
      if (nativeVisibilityGet) return nativeVisibilityGet.call(document);
    } catch (e) {}
    return 'visible';
  }

  var REPLAY_WINDOW_MS = 2500;
  var lastHiddenAt = -REPLAY_WINDOW_MS;
  var lastVisibleAt = -REPLAY_WINDOW_MS;

  document.addEventListener('visibilitychange', function () {
    var vis = actualVisibility();
    if (vis === 'hidden') { lastHiddenAt = Date.now(); } else { lastVisibleAt = Date.now(); }
  }, true);

  function replay(video) {
    try {
      var result = nativePlay ? nativePlay.call(video) : video.play();
      if (result && typeof result.catch === 'function') { result.catch(function () {}); }
    } catch (e) {}
  }

  // Catch the synchronous pause event WebKit fires upon EnteringBackground interruption
  document.addEventListener('pause', function (event) {
    var video = event.target;
    if (!video || !video.tagName || (video.tagName !== 'VIDEO' && video.tagName !== 'AUDIO')) { return; }
    var now = Date.now();
    if (pauseRequested || video.ended) { return; }

    if (actualVisibility() === 'hidden') {
      if (now - lastHiddenAt < REPLAY_WINDOW_MS) {
        replay(video);
      }
      return;
    }

    if (now - lastVisibleAt < REPLAY_WINDOW_MS) {
      replay(video);
      return;
    }

    var expiry = setTimeout(cleanup, REPLAY_WINDOW_MS);
    function onTransition() {
      if (actualVisibility() !== 'hidden') return;
      cleanup();
      if (!video.ended && !pauseRequested) { replay(video); }
    }
    function cleanup() {
      clearTimeout(expiry);
      document.removeEventListener('visibilitychange', onTransition, true);
    }
    document.addEventListener('visibilitychange', onTransition, true);
  }, true);

  // 3. YouTube activity keepalive
  function refreshLact() {
    try {
      if (window._lact !== undefined) window._lact = Date.now();
    } catch (e) {}
  }
  setInterval(refreshLact, 5 * 60 * 1000);
})();
