import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Repeat, Shuffle, ListMusic, Loader2, Wand2, Mic2 } from 'lucide-react';
import { Track } from '../types/music';
import { logger } from '../services/logger';
import { isAndroidWebView, isIOSWebView, isNativeMobile, nativeAudio, nativeSourceFor } from '../services/nativeAudio';
import { publishAndroidMedia, setAndroidMediaCommandHandler, usesAndroidMediaBridge } from '../services/androidMedia';
import { invoke } from '@tauri-apps/api/core';
import { lavalinkService } from '../services/lavalink';
import { getLavalinkBaseUrl } from '../services/lavalinkUrl';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

interface PlayerProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onPlayPauseToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onTrackEnd: () => void;
  queue: Track[];
  onToggleQueue: () => void;
  isAutoMix: boolean;
  isAutoMixLoading?: boolean;
  onToggleAutoMix: () => void;
  onToggleLyrics?: () => void;
  isLyricsOpen?: boolean;
  onTimeUpdate?: (time: number) => void;
  seekTime?: number | null;
  onPlaybackStateChange?: (playing: boolean) => void;
}

type PlaybackStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error';

/**
 * A node either can extract YouTube audio formats or it cannot, and that does not
 * change between songs. Retrying the native path per track made every song on
 * Android wait for the proxy to walk its whole client list — measured at roughly
 * 18s — before the WebView engine took over. Two failures in a row is enough to
 * tell a broken node from one transient blip.
 */
const NATIVE_FAILURE_LIMIT = 2;

/**
 * Native extraction is optional. Never leave the YouTube embed suppressed while
 * Lavalink is unavailable or slow.
 */
const NATIVE_RESOLUTION_TIMEOUT_MS = 5000;

/**
 * YouTube refuses embeds that arrive without an HTTP Referer (error 153). iOS
 * serves the app from tauri://localhost, which WebKit never sends as a Referer,
 * so there the player lives in an HTTPS relay page and is driven by
 * postMessage. Mirrors the subset of YT.Player this component calls.
 */
const YT_RELAY_URL = 'https://devd-z.github.io/utobe-Music-main/yt-relay.html';

class RelayPlayer {
  private frame: HTMLIFrameElement;
  private time = 0;
  private duration = 0;
  private state = -1;

  constructor(host: HTMLElement, options: { events: Record<string, (event: any) => void> }) {
    this.frame = document.createElement('iframe');
    this.frame.src = YT_RELAY_URL;
    this.frame.width = '200';
    this.frame.height = '200';
    this.frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    host.replaceWith(this.frame);
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (event.source !== this.frame.contentWindow || msg?.source !== 'hd-yt-relay') return;
      if (msg.event === 'time') {
        this.time = msg.time;
        this.duration = msg.duration;
        this.state = msg.state;
      } else if (msg.event === 'ready') {
        options.events.onReady?.({ target: this });
      } else if (msg.event === 'state') {
        this.state = msg.data;
        options.events.onStateChange?.({ data: msg.data });
      } else if (msg.event === 'error') {
        options.events.onError?.({ data: msg.data });
      }
    });
  }

  private send(msg: Record<string, unknown>) {
    this.frame.contentWindow?.postMessage({ target: 'hd-yt-relay', ...msg }, '*');
  }

  loadVideoById(arg: { videoId: string; startSeconds?: number }) { this.send({ cmd: 'load', id: arg.videoId, start: arg.startSeconds }); }
  playVideo() { this.send({ cmd: 'play' }); }
  pauseVideo() { this.send({ cmd: 'pause' }); }
  seekTo(time: number) { this.time = time; this.send({ cmd: 'seek', time }); }
  setVolume(value: number) { this.send({ cmd: 'volume', value }); }
  mute() { this.send({ cmd: 'mute' }); }
  unMute() { this.send({ cmd: 'unmute' }); }
  getCurrentTime() { return this.time; }
  getDuration() { return this.duration; }
  getPlayerState() { return this.state; }
}

/**
 * How many consecutive times the embed may be nudged back into playing after it
 * pauses itself in the background. Bounded so a genuine pause — from the
 * notification, a phone call, another app taking audio focus — always wins, and
 * so a hard block cannot turn into an endless pause/play fight.
 */
const MAX_BACKGROUND_RESUMES = 3;

/** Playback that survives this long after a nudge refills the budget above. */
const BACKGROUND_RESUME_CREDIT_MS = 3000;

export const Player: React.FC<PlayerProps> = ({
  currentTrack,
  isPlaying,
  onPlayPauseToggle,
  onNext,
  onPrevious,
  onTrackEnd,
  queue,
  onToggleQueue,
  isAutoMix,
  isAutoMixLoading = false,
  onToggleAutoMix,
  onToggleLyrics,
  isLyricsOpen = false,
  onTimeUpdate,
  seekTime,
  onPlaybackStateChange,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const userPlayRequestedRef = useRef(false);
  const pendingYouTubePlayRef = useRef<string | null>(null);
  const [ytReady, setYtReady] = useState(false);

  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [playerError, setPlayerError] = useState<string | null>(null);
  useEffect(() => { setPlayerError(null); }, [currentTrack?.identifier]);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);
  const [cachedNativeSource, setCachedNativeSource] = useState<{ trackId: string; source: string } | null>(null);
  const [nativeStreamFailedFor, setNativeStreamFailedFor] = useState<string | null>(null);
  const [nativeStreamingDisabled, setNativeStreamingDisabled] = useState(false);
  const nativeFailureStreakRef = useRef(0);
  const prewarmedNativeSourcesRef = useRef<Map<string, string>>(new Map());
  const prewarmingTrackIdsRef = useRef<Set<string>>(new Set());

  const noteNativeFailure = useCallback((trackId: string | undefined) => {
    if (trackId) setNativeStreamFailedFor(trackId);
    nativeFailureStreakRef.current += 1;

    // iOS background playback depends on AVPlayer. Never disable the native
    // engine for the whole session because one bad YouTube extraction would
    // force every later song back into WKWebView, which is exactly where audio
    // becomes fragile when the device locks. The failed track may fall back,
    // while the next track gets a fresh native attempt.
    if (isIOSWebView()) return;

    if (nativeFailureStreakRef.current < NATIVE_FAILURE_LIMIT) return;
    setNativeStreamingDisabled((already) => {
      if (!already) {
        logger.addLog('warn', 'Player', 'Native background playback disabled for this session: the Lavalink node cannot serve audio streams. Playback stays in the WebView, which Android stops when the screen locks.');
      }
      return true;
    });
  }, []);

  // Player engines live longer than a React render. Keep their callbacks fresh
  // without tearing down native/YouTube listeners whenever the parent renders.
  const currentTrackRef = useRef(currentTrack);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onTrackEndRef = useRef(onTrackEnd);
  const onNextRef = useRef(onNext);
  const onPreviousRef = useRef(onPrevious);
  const onPlayPauseToggleRef = useRef(onPlayPauseToggle);
  const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
  const isRepeatRef = useRef(isRepeat);
  const isPlayingRef = useRef(isPlaying);
  currentTrackRef.current = currentTrack;
  onTimeUpdateRef.current = onTimeUpdate;
  onTrackEndRef.current = onTrackEnd;
  onNextRef.current = onNext;
  onPreviousRef.current = onPrevious;
  onPlayPauseToggleRef.current = onPlayPauseToggle;
  onPlaybackStateChangeRef.current = onPlaybackStateChange;
  isRepeatRef.current = isRepeat;
  isPlayingRef.current = isPlaying;

  // The embedded YouTube player pauses itself when the page is hidden, which on a
  // locked screen means silence even though the WebView is still running. Nudge it
  // back, but never in a tight loop — see MAX_BACKGROUND_RESUMES.
  const backgroundResumesRef = useRef(0);
  const backgroundResumeAtRef = useRef(0);

  // Helper to extract YouTube ID
  const getYouTubeId = useCallback((track: Track | null): string | null => {
    if (!track) return null;
    if (track.identifier && !track.identifier.startsWith('demo-') && /^[a-zA-Z0-9_-]{11}$/.test(track.identifier)) {
      return track.identifier;
    }
    if (track.uri) {
      const match = track.uri.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      if (match && match[1]) return match[1];
    }
    return null;
  }, []);

  const ytId = getYouTubeId(currentTrack);
  const cachedSource = currentTrack && cachedNativeSource?.trackId === currentTrack.identifier
    ? cachedNativeSource.source
    : null;
  const nativeTrack = currentTrack && cachedSource
    ? { ...currentTrack, playbackUrl: cachedSource }
    : currentTrack;
  const nativeSrc = nativeSourceFor(nativeTrack);
  const nativeSrcRef = useRef<string | null>(nativeSrc);
  nativeSrcRef.current = nativeSrc;
  // Render can return search metadata while YouTube blocks media extraction from
  // its datacenter IP. On iOS, waiting for that failed native probe also expires
  // the tap's user-activation window, so WKWebView rejects the iframe fallback.
  // Start YouTube immediately there; direct URLs still use AVPlayer.
  const resolvingNativeStream = isNativeMobile() && !isIOSWebView() && Boolean(ytId) && !nativeSrc
    && !nativeStreamingDisabled
    && nativeStreamFailedFor !== currentTrack?.identifier;
  const webYtId = nativeSrc || resolvingNativeStream ? null : ytId;

  useEffect(() => {
    if (!isNativeMobile() || isIOSWebView() || !ytId || !currentTrack || nativeStreamingDisabled) return;
    let cancelled = false;
    const config = lavalinkService.getConfig();

    // Auto Mix prewarms the next item while the current song is still playing.
    // Reusing that already-resolved local stream avoids an extraction pause at
    // the exact moment iOS advances tracks while the screen is locked.
    const prewarmed = prewarmedNativeSourcesRef.current.get(currentTrack.identifier);
    if (prewarmed) {
      prewarmedNativeSourcesRef.current.delete(currentTrack.identifier);
      setCachedNativeSource({ trackId: currentTrack.identifier, source: prewarmed });
      setNativeStreamFailedFor((failed) => failed === currentTrack.identifier ? null : failed);
      return;
    }

    // Stop the previous native item immediately. Waiting for the next stream
    // download made the old song continue and made track selection look stuck.
    void nativeAudio.pause().catch(() => undefined);
    ytPlayerRef.current?.pauseVideo?.();
    setCurrentTime(0);
    setDuration(currentTrack.length ? currentTrack.length / 1000 : 0);
    setPlaybackStatus('loading');
    let timeoutId = 0;
    let resolutionTimedOut = false;
    const resolutionTimeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        resolutionTimedOut = true;
        cancelled = true;
        reject(new Error('Native YouTube stream resolution timed out'));
      }, NATIVE_RESOLUTION_TIMEOUT_MS);
    });
    void Promise.race([
      invoke<string>('prepare_lavalink_stream', {
        videoId: ytId,
        baseUrl: getLavalinkBaseUrl(config),
        password: config.password,
      }),
      resolutionTimeout,
    ]).then((source) => {
      if (!cancelled) {
        setNativeStreamFailedFor((failed) => failed === currentTrack.identifier ? null : failed);
        setCachedNativeSource({ trackId: currentTrack.identifier, source });
      }
    }).catch((error) => {
      if (!resolutionTimedOut && cancelled) return;
      logger.addLog('warn', 'Player', `Native YouTube stream unavailable: ${String(error)}`);
      noteNativeFailure(currentTrack.identifier);
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentTrack?.identifier, ytId, nativeStreamingDisabled]);

  // Resolve the next queued YouTube track ahead of time. This is especially
  // important on iOS: AVPlayer can continue while WKWebView is suspended, but
  // the JS thread may get only a short execution window after a track ends.
  useEffect(() => {
    if (!isNativeMobile() || isIOSWebView() || nativeStreamingDisabled) return;
    const nextTrack = queue[0];
    if (!nextTrack || nextTrack.identifier === currentTrack?.identifier) return;
    if (prewarmedNativeSourcesRef.current.has(nextTrack.identifier)) return;
    if (prewarmingTrackIdsRef.current.has(nextTrack.identifier)) return;

    const nextYtId = getYouTubeId(nextTrack);
    if (!nextYtId) return;

    const config = lavalinkService.getConfig();
    prewarmingTrackIdsRef.current.add(nextTrack.identifier);
    void invoke<string>('prepare_lavalink_stream', {
      videoId: nextYtId,
      baseUrl: getLavalinkBaseUrl(config),
      password: config.password,
    }).then((source) => {
      prewarmedNativeSourcesRef.current.set(nextTrack.identifier, source);
      // Keep memory bounded even when Auto Mix replaces the queue repeatedly.
      while (prewarmedNativeSourcesRef.current.size > 3) {
        const oldest = prewarmedNativeSourcesRef.current.keys().next().value as string | undefined;
        if (!oldest) break;
        prewarmedNativeSourcesRef.current.delete(oldest);
      }
    }).catch((error) => {
      logger.addLog('info', 'Player', `Next-track prewarm skipped: ${String(error)}`);
    }).finally(() => {
      prewarmingTrackIdsRef.current.delete(nextTrack.identifier);
    });
  }, [queue[0]?.identifier, currentTrack?.identifier, nativeStreamingDisabled, getYouTubeId]);

  // Load the YouTube IFrame API and build the player exactly once. The API owns
  // its iframe from here on and every song switch goes through loadVideoById.
  // React used to re-point the iframe `src` on each track, which forced the
  // embed (roughly a megabyte of player JS) to download and redo its jsapi
  // handshake before anything could play — the main reason songs took seconds
  // to start.
  useEffect(() => {
    logger.addLog('info', 'Player', 'Initializing YouTube Engine...');
    let disposed = false;

    const createPlayerInstance = () => {
      if (disposed || ytPlayerRef.current || !ytHostRef.current) return;
      try {
        const Player = isIOSWebView() ? RelayPlayer : window.YT.Player;
        ytPlayerRef.current = new Player(ytHostRef.current, {
          host: 'https://www.youtube-nocookie.com',
          width: '200',
          height: '200',
          playerVars: {
            enablejsapi: 1,
            autoplay: 1,
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            rel: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              const iframe = ytHostRef.current?.querySelector('iframe');
              if (iframe) iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
              logger.addLog('success', 'Player', 'YouTube Player Engine Ready!');
              setYtReady(true);
              const pendingId = pendingYouTubePlayRef.current;
              if (pendingId) {
                ytPlayerRef.current?.loadVideoById({ videoId: pendingId, startSeconds: 0 });
                ytPlayerRef.current?.playVideo?.();
              } else if (isPlayingRef.current && !nativeSrcRef.current) {
                ytPlayerRef.current?.playVideo?.();
              }
            },
            onStateChange: (event: any) => {
              if (event.data === 1) {
                setPlaybackStatus('playing');
                if (!nativeSrcRef.current) onPlaybackStateChangeRef.current?.(true);
              } else if (event.data === 2) {
                setPlaybackStatus('paused');
                // When the device locks or moves to background, WebKit or YouTube
                // may briefly pause the player. If isPlayingRef is still true, the user
                // did not request a pause — nudge it back instead of killing state!
                if (isPlayingRef.current && !nativeSrcRef.current) {
                  if (Date.now() - backgroundResumeAtRef.current > BACKGROUND_RESUME_CREDIT_MS) {
                    backgroundResumesRef.current = 0;
                  }
                  if (backgroundResumesRef.current < MAX_BACKGROUND_RESUMES) {
                    backgroundResumesRef.current += 1;
                    backgroundResumeAtRef.current = Date.now();
                    ytPlayerRef.current?.playVideo?.();
                  } else {
                    onPlaybackStateChangeRef.current?.(false);
                  }
                } else if (!isPlayingRef.current && !nativeSrcRef.current) {
                  onPlaybackStateChangeRef.current?.(false);
                }
              } else if (event.data === 3) {
                setPlaybackStatus('buffering');
              } else if (event.data === 0) {
                setPlaybackStatus('idle');
                if (isRepeatRef.current) {
                  ytPlayerRef.current?.seekTo(0);
                  ytPlayerRef.current?.playVideo();
                } else {
                  onTrackEndRef.current();
                }
              }
            },
            onError: (event: any) => {
              logger.addLog('error', 'Player', `YouTube Player Error Code: ${event.data}`);
              setPlayerError(`YouTube error ${event.data}`);
              setPlaybackStatus('error');
              onPlaybackStateChangeRef.current?.(false);
            },
          },
        });
      } catch (err: any) {
        logger.addLog('error', 'Player', `Failed to attach YT player instance: ${err.message}`);
      }
    };

    if (isIOSWebView() || (window.YT && window.YT.Player)) {
      createPlayerInstance();
    } else {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        createPlayerInstance();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.async = true;
        document.head.appendChild(tag);
      }
    }

    return () => { disposed = true; };
  }, []);

  const hasTrackEndedRef = useRef(false);
  const nativeLoadRevisionRef = useRef(0);
  const nativeHasPlayedRef = useRef(false);

  // Native playback remains alive when the WebView is suspended in the background.
  useEffect(() => {
    if (!isNativeMobile()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenRemote: (() => void) | undefined;

    void nativeAudio.listenRemoteCommand((command) => {
      if (command === 'next') onNextRef.current();
      else onPreviousRef.current();
    }).then((remove) => { unlistenRemote = remove; }).catch((error) => {
      logger.addLog('warn', 'Player', `Native media-button listener unavailable: ${String(error)}`);
    });

    void nativeAudio.listen((state) => {
      if (disposed || !nativeSrcRef.current) return;
      setCurrentTime(state.currentTime || 0);
      if (state.duration > 0) setDuration(state.duration);
      onTimeUpdateRef.current?.(state.currentTime || 0);
      setPlaybackStatus(state.status === 'ended' ? 'idle' : state.status);
      if (state.status === 'error') {
        const failedTrack = currentTrackRef.current;
        logger.addLog('warn', 'Player', `Native stream failed, using YouTube fallback: ${state.error || 'unknown error'}`);
        setCachedNativeSource(null);
        noteNativeFailure(failedTrack?.identifier);
        return;
      }
      if (state.isPlaying) {
        // Native audio really is producing sound, so the node can serve streams
        // after all. Forget any earlier failures.
        nativeFailureStreakRef.current = 0;
        nativeHasPlayedRef.current = true;
        onPlaybackStateChangeRef.current?.(true);
      } else if (state.status === 'ended' || (state.status === 'idle' && nativeHasPlayedRef.current)) {
        onPlaybackStateChangeRef.current?.(false);
      }

      if (state.status === 'ended' && !hasTrackEndedRef.current) {
        hasTrackEndedRef.current = true;
        onTrackEndRef.current();
      }
    }).then((remove) => { unlisten = remove; }).catch((error) => {
      logger.addLog('warn', 'Player', `Native audio listener unavailable: ${String(error)}`);
    });

    const reconcile = () => {
      if (document.visibilityState === 'visible' && nativeSrcRef.current) {
        void nativeAudio.state().then((state) => {
          setCurrentTime(state.currentTime || 0);
          if (state.duration > 0) setDuration(state.duration);
          setPlaybackStatus(state.status === 'ended' ? 'idle' : state.status);
          if (state.isPlaying) onPlaybackStateChangeRef.current?.(true);
          else if (state.status === 'ended' || (state.status === 'idle' && nativeHasPlayedRef.current)) onPlaybackStateChangeRef.current?.(false);
        }).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      disposed = true;
      unlisten?.();
      unlistenRemote?.();
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, []);

  // Once the node is known not to serve streams, the plugin's media3 session is
  // still alive in STATE_ERROR and still the device's media-button target, so
  // lock-screen and Bluetooth keys hit a dead player. Let it go.
  useEffect(() => {
    if (!nativeStreamingDisabled || !isNativeMobile()) return;
    void nativeAudio.dispose().catch(() => undefined);
  }, [nativeStreamingDisabled]);

  // Handle external seek requests (e.g. clicking lyrics line)
  useEffect(() => {
    if (typeof seekTime === 'number' && seekTime >= 0) {
      setCurrentTime(seekTime);
      if (nativeSrc) {
        void nativeAudio.seekTo(seekTime).catch((error) => logger.addLog('error', 'Player', String(error)));
      } else if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
        ytPlayerRef.current.seekTo(seekTime, true);
      }
      if (audioRef.current) {
        audioRef.current.currentTime = seekTime;
      }
    }
  }, [seekTime]);

  // Sync current time & duration with Auto Playhead Status Sync
  useEffect(() => {
    let interval: any;
    if (webYtId && isPlaying) {
      interval = setInterval(() => {
        if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === 'function') {
          const curr = ytPlayerRef.current.getCurrentTime() || 0;
          const dur = ytPlayerRef.current.getDuration() || (currentTrack?.length ? currentTrack.length / 1000 : 0);
          setCurrentTime(curr);
          setDuration(dur);
          onTimeUpdateRef.current?.(curr);

          const state = typeof ytPlayerRef.current.getPlayerState === 'function' ? ytPlayerRef.current.getPlayerState() : -1;
          if (state === 1 || curr > 0.2) {
            setPlaybackStatus('playing');
          }

          // Safety trigger for track ending
          if (dur > 5 && curr >= dur - 0.8 && !hasTrackEndedRef.current) {
            hasTrackEndedRef.current = true;
            if (isRepeatRef.current) {
              ytPlayerRef.current?.seekTo(0);
              ytPlayerRef.current?.playVideo();
            } else {
              onTrackEndRef.current();
            }
          }
        }
      }, 400);
    }
    return () => clearInterval(interval);
  }, [webYtId, isPlaying, currentTrack, isRepeat, onTrackEnd]);

  // Handle Smooth Track Transitioning
  useEffect(() => {
    if (!currentTrack || resolvingNativeStream || (!nativeSrc && webYtId && !ytReady)) return;
    hasTrackEndedRef.current = false;
    backgroundResumesRef.current = 0;

    const currentYtId = webYtId;
    logger.addLog('info', 'Player', `Loading track: "${currentTrack.title}"`, { ytId: currentYtId });

    setPlaybackStatus('loading');

    if (nativeSrc) {
      nativeHasPlayedRef.current = false;
      if (audioRef.current) audioRef.current.pause();
      ytPlayerRef.current?.pauseVideo?.();
      const revision = ++nativeLoadRevisionRef.current;
      void nativeAudio.prepare(nativeTrack!).then(() => {
        if (revision === nativeLoadRevisionRef.current && isPlaying) return nativeAudio.play();
      }).catch((error) => {
        if (revision !== nativeLoadRevisionRef.current) return;
        logger.addLog('warn', 'Player', `Native playback failed, falling back to the WebView engine: ${String(error)}`);
        // Drop the native source as well. Leaving it in place kept `webYtId`
        // null, so the player held an unplayable source and never recovered.
        setCachedNativeSource(null);
        noteNativeFailure(currentTrackRef.current?.identifier);
      });
    } else if (currentYtId) {
      if (audioRef.current) audioRef.current.pause();

      if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === 'function') {
        ytPlayerRef.current.loadVideoById({
          videoId: currentYtId,
          startSeconds: 0,
        });
        ytPlayerRef.current.setVolume(isMuted ? 0 : volume * 100);
        if (isPlaying) {
          ytPlayerRef.current.playVideo();
        }
      }
    } else if (currentTrack.uri) {
      if (ytPlayerRef.current && typeof ytPlayerRef.current.pauseVideo === 'function') {
        ytPlayerRef.current.pauseVideo();
      }

      if (audioRef.current) {
        audioRef.current.src = currentTrack.uri;
        audioRef.current.volume = isMuted ? 0 : volume;
        if (isPlaying) {
          audioRef.current.play().catch(console.error);
        }
      }
    }
  }, [currentTrack, ytReady, nativeSrc, webYtId, resolvingNativeStream]);

  // Play/Pause button toggle
  useEffect(() => {
    if (isPlaying) backgroundResumesRef.current = 0;
    if (nativeSrc) {
      const action = isPlaying ? nativeAudio.play() : nativeAudio.pause();
      void action.catch((error) => logger.addLog('error', 'Player', `Native playback command failed: ${String(error)}`));
    } else if (webYtId && ytPlayerRef.current) {
      if (isPlaying) {
        ytPlayerRef.current.playVideo?.();
      } else {
        ytPlayerRef.current.pauseVideo?.();
      }
    } else if (audioRef.current && audioRef.current.src) {
      if (isPlaying) {
        audioRef.current.play?.().catch(console.error);
      } else {
        audioRef.current.pause?.();
      }
    }
  }, [isPlaying, webYtId, nativeSrc]);

  useEffect(() => {
    const playTrackFromTap = (event: Event) => {
      const track = (event as CustomEvent<Track>).detail;
      const id = getYouTubeId(track);
      if (!id) return;
      userPlayRequestedRef.current = true;
      pendingYouTubePlayRef.current = id;
      if (ytPlayerRef.current) {
        ytPlayerRef.current.loadVideoById({ videoId: id, startSeconds: 0 });
        ytPlayerRef.current.playVideo?.();
      }
    };
    window.addEventListener('hotdogdot:play-track', playTrackFromTap);
    return () => window.removeEventListener('hotdogdot:play-track', playTrackFromTap);
  }, [getYouTubeId]);

  const handlePlayPauseClick = () => {
    // Use the engine state, not the parent's intent state. After iOS rejects
    // autoplay, `isPlaying` can remain true while the iframe is actually paused.
    if (!nativeSrc && ytPlayerRef.current && webYtId) {
      if (playbackStatus === 'playing') {
        ytPlayerRef.current.pauseVideo?.();
        onPlaybackStateChangeRef.current?.(false);
      } else {
        userPlayRequestedRef.current = true;
        ytPlayerRef.current.playVideo?.();
        onPlaybackStateChangeRef.current?.(true);
      }
      return;
    }
    onPlayPauseToggle();
  };

  // Volume Change
  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    setIsMuted(newVol === 0);

    if (ytPlayerRef.current && typeof ytPlayerRef.current.setVolume === 'function') {
      ytPlayerRef.current.setVolume(newVol * 100);
    }
    if (audioRef.current) {
      audioRef.current.volume = newVol;
    }
  };

  const toggleMute = () => {
    if (isMuted) {
      setIsMuted(false);
      if (ytPlayerRef.current && typeof ytPlayerRef.current.unMute === 'function') {
        ytPlayerRef.current.unMute();
        ytPlayerRef.current.setVolume(volume * 100);
      }
      if (audioRef.current) audioRef.current.volume = volume;
    } else {
      setIsMuted(true);
      if (ytPlayerRef.current && typeof ytPlayerRef.current.mute === 'function') {
        ytPlayerRef.current.mute();
      }
      if (audioRef.current) audioRef.current.volume = 0;
    }
  };

  const seekToSeconds = (newTime: number) => {
    setCurrentTime(newTime);

    if (nativeSrc) {
      void nativeAudio.seekTo(newTime).catch((error) => logger.addLog('error', 'Player', String(error)));
    } else if (webYtId && ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
      ytPlayerRef.current.seekTo(newTime, true);
    } else if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekToSeconds(parseFloat(e.target.value));
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const trackDuration = duration || (currentTrack?.length ? currentTrack.length / 1000 : 180);

  // Media keys and Media Session metadata for the WebView/HTML engine. On desktop
  // this drives the OS media keys and the system media popup.
  //
  // Skipped on Android: the handlers never reach the lock screen there, and
  // Chromium calls the `pause` one when it suspends the media session, which
  // turned a screen lock into a pause the player treated as the user's own.
  useEffect(() => {
    if (!('mediaSession' in navigator) || nativeSrc || !currentTrack || isAndroidWebView()) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.author,
      artwork: currentTrack.artworkUrl ? [{ src: currentTrack.artworkUrl }] : undefined,
    });
    navigator.mediaSession.setActionHandler('play', () => onPlayPauseToggleRef.current());
    navigator.mediaSession.setActionHandler('pause', () => onPlayPauseToggleRef.current());
    navigator.mediaSession.setActionHandler('nexttrack', () => onNextRef.current());
    navigator.mediaSession.setActionHandler('previoustrack', () => onPreviousRef.current());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime !== 'number') return;
      if (webYtId) ytPlayerRef.current?.seekTo?.(details.seekTime, true);
      else if (audioRef.current) audioRef.current.currentTime = details.seekTime;
    });
    return () => {
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto'] as MediaSessionAction[]) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [currentTrack, webYtId]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || nativeSrc) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    if (trackDuration > 0 && currentTime >= 0 && currentTime <= trackDuration) {
      try {
        navigator.mediaSession.setPositionState({ duration: trackDuration, position: currentTime, playbackRate: 1 });
      } catch {
        // Some browsers expose Media Session without position state support.
      }
    }
  }, [isPlaying, currentTime, trackDuration, nativeSrc]);

  // Android's replacement for the block above: the page cannot reach the platform
  // MediaSession, so it publishes its state and the activity mirrors it into a
  // real session behind the notification. See services/androidMedia.ts.
  useEffect(() => {
    if (!usesAndroidMediaBridge()) return;
    if (!currentTrack) {
      publishAndroidMedia(null);
      return;
    }
    publishAndroidMedia({
      id: currentTrack.identifier,
      title: currentTrack.title,
      artist: currentTrack.author,
      artwork: currentTrack.artworkUrl || '',
      playing: isPlaying,
      position: Math.max(0, Math.round(currentTime * 1000)),
      duration: Math.max(0, Math.round(trackDuration * 1000)),
    });
  }, [currentTrack, isPlaying, currentTime, trackDuration]);

  useEffect(() => {
    if (!usesAndroidMediaBridge()) return;
    setAndroidMediaCommandHandler((command, value) => {
      if (command === 'next') return onNextRef.current();
      if (command === 'previous') return onPreviousRef.current();
      if (command === 'seek') return seekToSeconds(value / 1000);
      // `stop` is the notification being dismissed; pausing is as far as it goes,
      // so the queue and the position survive being swiped away.
      if ((command === 'play') !== isPlayingRef.current) onPlayPauseToggleRef.current();
    });
    return () => setAndroidMediaCommandHandler(null);
  }, [nativeSrc, webYtId]);

  useEffect(() => () => publishAndroidMedia(null), []);

  return (
    <div className={`player-dock ${currentTrack ? 'has-track' : 'no-track'} h-32 md:h-24 bg-slate-950/95 border-t border-slate-800/80 px-3 md:px-6 py-2 md:py-0 flex flex-wrap md:flex-nowrap items-center justify-between z-40 fixed bottom-16 md:bottom-0 left-0 right-0 backdrop-blur-xl`}>
      {/* HTML Audio element & YT Player iframe */}
      <audio
        ref={audioRef}
        onTimeUpdate={() => {
          if (audioRef.current && !webYtId && !nativeSrc) {
            const curr = audioRef.current.currentTime || 0;
            const dur = audioRef.current.duration || 0;
            setCurrentTime(curr);
            if (dur > 0 && !isNaN(dur)) {
              setDuration(dur);
            }
            onTimeUpdateRef.current?.(curr);
          }
        }}
        onLoadedMetadata={() => {
          if (audioRef.current && !webYtId && !nativeSrc) {
            const dur = audioRef.current.duration || 0;
            if (dur > 0 && !isNaN(dur)) {
              setDuration(dur);
            }
          }
        }}
        onPlay={() => {
          if (!webYtId && !nativeSrc) setPlaybackStatus('playing');
        }}
        onPause={() => {
          if (!webYtId && !nativeSrc && audioRef.current && !audioRef.current.ended) {
            setPlaybackStatus('paused');
          }
        }}
        onEnded={() => {
          if (!webYtId && !nativeSrc) {
            setPlaybackStatus('idle');
            if (isRepeat) {
              if (audioRef.current) {
                audioRef.current.currentTime = 0;
                audioRef.current.play().catch(console.error);
              }
            } else {
              onTrackEndRef.current();
            }
          }
        }}
        onError={() => {
          if (!webYtId && !nativeSrc) {
            logger.addLog('error', 'Player', `Failed to play audio file: ${currentTrack?.title}`);
            setPlaybackStatus('error');
          }
        }}
        className="hidden"
      />
      {/* YouTube playback engine. The IFrame API replaces the inner div with an
          iframe it owns, so React never re-points a `src` and never forces the
          embed to reload between songs. */}
      <div
        aria-hidden="true"
        className="fixed w-[200px] h-[200px] opacity-[0.01] pointer-events-none overflow-hidden"
        style={{ left: '-1px', top: '-1px' }}
      >
        <div ref={ytHostRef} id="yt-player-iframe-element" />
      </div>

      {/* Left: Track Details & Animated Equalizer */}
      <button
        type="button"
        onClick={onToggleLyrics}
        aria-label="เปิดตัวเล่นแบบเต็มหน้าจอ"
        className="player-track text-left flex items-center gap-3 md:gap-4 w-[calc(100%-88px)] md:w-1/3 min-w-0 md:min-w-[240px] order-1 rounded-xl"
      >
        {currentTrack ? (
          <>
            <div className="relative shrink-0 group">
              <img
                src={currentTrack.artworkUrl || '/znight.png'}
                alt={currentTrack.title}
              className="w-11 h-11 md:w-14 md:h-14 rounded-xl object-cover shadow-lg border border-slate-800 transition transform group-hover:scale-105"
              />
            </div>
            <div className="overflow-hidden space-y-0.5 max-w-[calc(100vw-100px)] md:max-w-[210px]">
              {currentTrack.title.length > 20 ? (
                <div className="overflow-hidden w-full relative">
                  <div className="animate-marquee cursor-pointer">
                    <span className="font-bold text-sm text-slate-100 pr-8 hover:text-sky-400 transition">
                      {currentTrack.title}
                    </span>
                    <span className="font-bold text-sm text-slate-100 pr-8 hover:text-sky-400 transition">
                      {currentTrack.title}
                    </span>
                  </div>
                </div>
              ) : (
                <h4 className="font-bold text-sm text-slate-100 truncate hover:text-sky-400 cursor-pointer transition">
                  {currentTrack.title}
                </h4>
              )}
              <p className={`text-xs truncate ${playerError ? 'text-rose-400' : 'text-slate-400'}`}>
                {playerError ?? currentTrack.author}
              </p>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src="/znight.png"
              alt="hotdogdot icon"
              className="w-14 h-14 rounded-xl object-cover shadow-md border border-slate-800 shrink-0"
            />
            <div>
              <p className="text-sm font-medium text-slate-400">ไม่ได้เล่นเพลงอยู่</p>
              <p className="text-xs text-slate-600">เลือกเพลงเพื่อเริ่มฟัง</p>
            </div>
          </div>
        )}
      </button>

      {/* Middle: Playback Controls & Progress Bar */}
      <div className="player-controls flex flex-col items-center gap-1 md:gap-2 max-w-xl w-full order-3 md:order-2">
        <div className="flex items-center gap-3 md:gap-5">
          <button
            onClick={() => setIsShuffle(!isShuffle)}
            className={`hidden sm:block transition p-1.5 rounded-lg active:scale-95 ${isShuffle ? 'text-sky-400 bg-sky-500/10' : 'text-slate-400 hover:text-slate-200'}`}
            title="Shuffle"
          >
            <Shuffle className="w-4 h-4" />
          </button>

          <button
            onClick={onPrevious}
            disabled={!currentTrack}
            className="text-slate-300 hover:text-white transition disabled:opacity-40 p-1 active:scale-95"
            title="Previous Track"
          >
            <SkipBack className="w-5 h-5" />
          </button>

          <button
            onClick={handlePlayPauseClick}
            disabled={!currentTrack}
            className="w-10 h-10 rounded-full bg-sky-500 hover:bg-sky-400 text-slate-950 flex items-center justify-center shadow-lg shadow-sky-500/30 transition transform active:scale-90 disabled:opacity-40"
          >
            {playbackStatus === 'loading' || playbackStatus === 'buffering' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isPlaying ? (
              <Pause className="w-5 h-5 fill-current" />
            ) : (
              <Play className="w-5 h-5 fill-current ml-0.5" />
            )}
          </button>

          <button
            onClick={onNext}
            disabled={!currentTrack}
            className="text-slate-300 hover:text-white transition disabled:opacity-40 p-1 active:scale-95"
            title="Next Track"
          >
            <SkipForward className="w-5 h-5" />
          </button>

          <button
            onClick={() => setIsRepeat(!isRepeat)}
            className={`hidden sm:block transition p-1.5 rounded-lg active:scale-95 ${isRepeat ? 'text-sky-400 bg-sky-500/10' : 'text-slate-400 hover:text-slate-200'}`}
            title="Repeat Track"
          >
            <Repeat className="w-4 h-4" />
          </button>

          {/* Auto Mix Button */}
          <button
            onClick={onToggleAutoMix}
            className={`hidden sm:flex px-2.5 py-1 rounded-full text-xs font-semibold items-center gap-1.5 transition active:scale-95 ${
              isAutoMix
                ? 'bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/30 ring-2 ring-sky-400/30'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Auto Mix Recommendation Engine (Apple Music Autoplay)"
          >
            {isAutoMixLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
            ) : (
              <Wand2 className={`w-3.5 h-3.5 ${isAutoMix ? 'animate-pulse text-white' : ''}`} />
            )}
            <span>Auto Mix</span>
          </button>
        </div>

        {/* Progress Timeline */}
        <div className="player-timeline w-full flex items-center gap-3">
          <span className="text-[11px] font-medium text-zinc-500 w-10 text-right font-mono">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex-1 flex items-center">
            <div className="mini-progress" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.max(0, (currentTime / Math.max(trackDuration, 1)) * 100))}%` }} />
            </div>
            <input
              type="range"
              min={0}
              max={trackDuration || 100}
              value={currentTime}
              onChange={handleSeek}
              disabled={!currentTrack}
              className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-rose-500 hover:h-1.5 transition-all"
            />
          </div>
          <span className="text-[11px] font-medium text-zinc-500 w-10 font-mono">
            {formatTime(trackDuration)}
          </span>
        </div>
      </div>

      {/* Right: Lyrics, Volume & Queue */}
      <div className="player-actions flex items-center justify-end gap-1 md:gap-3 w-[88px] md:w-1/4 md:min-w-[200px] order-2 md:order-3">
        {/* Lyrics Button */}
        <button
          onClick={onToggleLyrics}
          className={`p-2 rounded-xl transition active:scale-95 flex items-center justify-center ${
            isLyricsOpen
              ? 'text-sky-400 bg-sky-500/20 border border-sky-500/30 shadow-md shadow-sky-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
          title="เนื้อเพลง (Lyrics & Karaoke)"
        >
          <Mic2 className="w-5 h-5" />
        </button>

        <button
          onClick={onToggleQueue}
          className="text-slate-400 hover:text-slate-200 p-2 rounded-xl hover:bg-slate-900 transition active:scale-95 relative"
          title="Play Queue"
        >
          <ListMusic className="w-5 h-5" />
          {queue.length > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-sky-400 animate-ping" />
          )}
        </button>

        <div className="hidden md:flex items-center gap-2">
          <button onClick={toggleMute} className="text-slate-400 hover:text-slate-200 active:scale-90 transition">
            {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
            className="w-20 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-400"
          />
        </div>
      </div>
    </div>
  );
};
