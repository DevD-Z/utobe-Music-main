import type { Track } from '../types/music';
import type { NativeAudioState } from 'tauri-plugin-native-audio-api';
import * as nativeAudioApi from 'tauri-plugin-native-audio-api';
import { isTauri } from '@tauri-apps/api/core';
import { logger } from './logger';

const isTauriRuntime = (): boolean =>
  isTauri()
  || window.location.hostname === 'tauri.localhost'
  || window.location.hostname === 'localhost.tauri';

// iPadOS reports a desktop UA in WKWebView, so fall back to the touch check.
const isIpadOs = (): boolean =>
  /Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;

/**
 * tauri-plugin-native-audio only registers command handlers for Android and
 * iOS. `isTauri()` is also true on Windows/macOS/Linux, where every
 * native-audio call rejects with "command not found" — which used to leave the
 * player holding an unplayable native source and never falling back to the
 * WebView engine. Keep this check genuinely mobile-only.
 */
export const isNativeMobile = (): boolean => {
  if (!isTauriRuntime()) return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent) || isIpadOs();
};

const youtubeUrl = /(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/i;

/**
 * Android WebView never bridges `navigator.mediaSession` to a platform
 * MediaSession — verified on-device with `dumpsys media_session`, which only ever
 * lists the native-audio plugin's session. Registering action handlers there buys
 * no lock-screen controls, and it is not merely useless: Chromium invokes the
 * page's `pause` handler whenever it suspends the media session (screen off,
 * audio-focus loss), so locking the screen turned into a real user-level pause
 * that the player then had no reason to recover from.
 */
export const isAndroidWebView = (): boolean =>
  isTauriRuntime() && /android/i.test(navigator.userAgent);

/** iOS/iPadOS WKWebView runtime inside the Tauri app. */
export const isIOSWebView = (): boolean =>
  isTauriRuntime()
  && (/iphone|ipad|ipod/i.test(navigator.userAgent) || isIpadOs());

export function nativeSourceFor(track: Track | null): string | null {
  if (!isNativeMobile() || !track) return null;
  const source = track.playbackUrl || track.uri;
  if (!source || source.startsWith('blob:') || youtubeUrl.test(source)) return null;
  if (/^(https?:\/\/|file:\/\/|asset:\/\/|\/)/i.test(source)) return source;
  return null;
}

let initialization: Promise<NativeAudioState> | null = null;

function initialize(): Promise<NativeAudioState> {
  if (!initialization) {
    initialization = nativeAudioApi.initialize().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

function stableTrackId(identifier: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identifier.length; index += 1) {
    hash ^= identifier.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export const nativeAudio = {
  async prepare(track: Track): Promise<NativeAudioState> {
    const src = nativeSourceFor(track);
    if (!src) throw new Error('Track has no native-playable source');
    await initialize();
    logger.addLog('info', 'Player', `Preparing native audio: ${track.title}`);
    return nativeAudioApi.setSource({
      src,
      id: stableTrackId(track.identifier),
      title: track.title,
      artist: track.author,
      artworkUrl: track.artworkUrl,
    });
  },
  play: async () => { await initialize(); return nativeAudioApi.play(); },
  pause: async () => { await initialize(); return nativeAudioApi.pause(); },
  seekTo: async (seconds: number) => { await initialize(); return nativeAudioApi.seekTo(seconds); },
  state: async () => { await initialize(); return nativeAudioApi.getState(); },
  /**
   * Release the plugin's MediaSessionService. A source the node cannot serve
   * leaves the media3 session in STATE_ERROR while it is still the device's
   * media-button target, so lock-screen and Bluetooth keys reach a dead player
   * instead of the engine that took over (measured with `dumpsys media_session`:
   * `state=7 error=Source error`, and `Avrcp_ext: ... playback state is error,
   * skip updating`). Dropping the session hands those controls back.
   */
  dispose: async (): Promise<void> => {
    const pending = initialization;
    if (!pending) return;
    initialization = null;
    await pending.catch(() => undefined);
    await nativeAudioApi.dispose();
  },
  listen: async (handler: (state: NativeAudioState) => void) => {
    await initialize();
    // v1.0.5's declaration says it returns an unsubscribe function, while
    // Tauri 2 actually returns a PluginListener object. Normalize both shapes.
    const listener = await nativeAudioApi.addStateListener(handler) as unknown as
      | (() => void | Promise<void>)
      | { unregister: () => Promise<void> };
    return () => {
      if (typeof listener === 'function') return listener();
      return listener.unregister();
    };
  },
};
