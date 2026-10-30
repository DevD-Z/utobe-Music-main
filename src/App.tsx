import { useState, useEffect, useCallback, useRef } from 'react';
import { Home, Search, History, Settings } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Player } from './components/Player';
import { HomeView } from './components/HomeView';
import { SearchView } from './components/SearchView';
import { HistoryView } from './components/HistoryView';
import { ServerStatusView } from './components/ServerStatusView';
import { ConsoleLogView } from './components/ConsoleLogView';
import { AboutView } from './components/AboutView';
import { SettingsModal } from './components/SettingsModal';
import { QueueDrawer } from './components/QueueDrawer';
import { AppleMusicPlayerModal } from './components/AppleMusicPlayerModal';

import { Track, HistoryItem, LavalinkConfig } from './types/music';
import { lavalinkService } from './services/lavalink';
import { getListeningHistory, addToListeningHistory, clearListeningHistory } from './services/history';
import { fetchAutoMixTracks } from './services/autoMix';
import { logger } from './services/logger';
import { discordPresence } from './services/discordPresence';
import { ThemeMode, applyTheme, getSavedTheme, getSavedAccentColor } from './services/theme';

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getSavedTheme);
  const [accentColor, setAccentColor] = useState<string>(getSavedAccentColor);
  const [activeTab, setActiveTab] = useState<'home' | 'search' | 'history' | 'servers' | 'logs' | 'about'>('home');
  const [isConnected, setIsConnected] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isLyricsOpen, setIsLyricsOpen] = useState(false);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [seekTimeRequested, setSeekTimeRequested] = useState<number | null>(null);
  const [isAutoMix, setIsAutoMix] = useState(true);
  const [isAutoMixLoading, setIsAutoMixLoading] = useState(false);
  const autoMixInFlightRef = useRef<Promise<Track[]> | null>(null);
  const [currentConfig, setCurrentConfig] = useState<LavalinkConfig>(lavalinkService.getConfig());

  // Search & Track states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Player states
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);

  // History state
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);

  // Auto Mix autoplay reaches back into the player, but it is memoised for the
  // lifetime of the app. Keep a live handle instead of capturing a stale closure.
  const handlePlayTrackRef = useRef<(track: Track, fromQueue?: boolean) => void>(() => {});
  // Whatever is playing right now must never also sit in the queue, or it plays
  // twice. Two Auto Mix callers can share one fetch, so filter on commit.
  const currentTrackIdRef = useRef<string | null>(null);

  // Initialize Theme and Accent Colors
  useEffect(() => {
    applyTheme(theme, accentColor);
  }, [theme, accentColor]);

  useEffect(() => {
    setHistoryItems(getListeningHistory());

    lavalinkService.onStatusChange((status) => {
      setIsConnected(status);
    });

    // The hosted node spins down when idle and needs tens of seconds to come
    // back, which the first search used to absorb in full. Wake it while the
    // user is still browsing, then keep it warm for as long as the app is open.
    const ping = () => { void lavalinkService.testConnection().then(res => setIsConnected(res.success)); };
    ping();
    const keepAlive = setInterval(ping, 10 * 60 * 1000);
    return () => clearInterval(keepAlive);
  }, []);

  useEffect(() => {
    const pageNames = {
      home: 'Home', search: 'Search', history: 'History', servers: 'Servers', logs: 'Console', about: 'About',
    } as const;
    const details = currentTrack ? `Listening to ${currentTrack.title}` : 'Using hotdogdot';
    void discordPresence.update(pageNames[activeTab], details, currentTrack, isPlaying);
  }, [activeTab, currentTrack?.identifier, currentTrack?.title, currentTrack?.artworkUrl, isPlaying]);

  useEffect(() => {
    const clearPresence = () => { void discordPresence.clear(); };
    window.addEventListener('beforeunload', clearPresence);
    return () => window.removeEventListener('beforeunload', clearPresence);
  }, []);

  useEffect(() => {
    const handleBack = () => {
      if (isLyricsOpen) return setIsLyricsOpen(false);
      if (isQueueOpen) return setIsQueueOpen(false);
      if (isSettingsOpen) return setIsSettingsOpen(false);
      if (activeTab !== 'home') setActiveTab('home');
    };
    window.addEventListener('popstate', handleBack);
    return () => window.removeEventListener('popstate', handleBack);
  }, [activeTab, isLyricsOpen, isQueueOpen, isSettingsOpen]);

  // Perform search query
  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    setActiveTab('search');
    setIsSearching(true);
    logger.addLog('info', 'System', `User initiated search for: "${query}"`);

    try {
      const results = await lavalinkService.search(query);
      setSearchResults(results);
    } catch (err: any) {
      logger.addLog('error', 'System', `Search failed: ${err.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  // Trigger Auto Mix queue generation (Apple Music style Autoplay)
  const runAutoMix = useCallback((seedTrack: Track, baseQueue: Track[]): Promise<Track[]> => {
    if (autoMixInFlightRef.current) return autoMixInFlightRef.current;

    setIsAutoMixLoading(true);
    const request = fetchAutoMixTracks(seedTrack, baseQueue, 8)
      .catch((err: any) => {
        logger.addLog('warn', 'AutoMix', `Auto Mix generation error: ${err?.message ?? err}`);
        return [] as Track[];
      })
      .finally(() => {
        autoMixInFlightRef.current = null;
        setIsAutoMixLoading(false);
      });

    autoMixInFlightRef.current = request;
    return request;
  }, []);

  const triggerAutoMix = useCallback(async (seedTrack: Track, baseQueue: Track[], autoPlayIfEmpty: boolean = false) => {
    // Background top-ups must not stack, but an explicit "next track" with an
    // empty queue has to produce a song. Dropping that request while a top-up
    // was in flight left the Next button doing nothing at all.
    if (autoMixInFlightRef.current && !autoPlayIfEmpty) return;

    const recs = await runAutoMix(seedTrack, baseQueue);
    if (recs.length === 0) return;

    const appendable = (prevQueue: Track[], candidates: Track[], ...extraIds: string[]) => {
      const existingIds = new Set([
        seedTrack.identifier,
        ...extraIds,
        ...prevQueue.map(q => q.identifier),
      ]);
      return candidates.filter(r => !existingIds.has(r.identifier) && r.identifier !== currentTrackIdRef.current);
    };

    if (autoPlayIfEmpty) {
      const [nextTrack, ...remaining] = recs;
      setQueue(prevQueue => [...prevQueue, ...appendable(prevQueue, remaining, nextTrack.identifier)]);
      handlePlayTrackRef.current(nextTrack, true);
    } else {
      setQueue(prevQueue => [...prevQueue, ...appendable(prevQueue, recs)]);
    }
  }, [runAutoMix]);

  // Play track action
  const handlePlayTrack = (track: Track, fromQueue: boolean = false) => {
    currentTrackIdRef.current = track.identifier;
    logger.addLog('info', 'System', `User selected track to play: "${track.title}" (${track.author})`);
    window.dispatchEvent(new CustomEvent('hotdogdot:play-track', { detail: track }));
    setCurrentTrack(track);
    setIsPlaying(true);

    // Save to Listening History
    const updatedHistory = addToListeningHistory(track);
    setHistoryItems(updatedHistory);

    // Apple Music style auto find next / autoplay
    if (isAutoMix) {
      if (fromQueue) {
        const trackIdx = queue.findIndex(t => t.identifier === track.identifier);
        let remaining = queue;
        if (trackIdx >= 0) {
          remaining = queue.slice(trackIdx + 1);
          setQueue(remaining);
        }
        if (remaining.length < 3) {
          triggerAutoMix(track, remaining);
        }
      } else {
        // Reset queue & immediately generate new playlist recommendations for this song
        setQueue([]);
        triggerAutoMix(track, []);
      }
    }
  };

  handlePlayTrackRef.current = handlePlayTrack;

  // Play/Pause toggle
  const handlePlayPauseToggle = () => {
    if (!currentTrack && searchResults.length > 0) {
      handlePlayTrack(searchResults[0]);
      return;
    }
    setIsPlaying(!isPlaying);
  };

  // Toggle Auto Mix mode
  const handleToggleAutoMix = () => {
    const nextState = !isAutoMix;
    setIsAutoMix(nextState);
    if (nextState && currentTrack && queue.length < 3) {
      triggerAutoMix(currentTrack, queue);
    }
  };

  // Next Track with Auto Mix support
  const handleNextTrack = async () => {
    if (queue.length > 0) {
      const nextTrack = queue[0];
      const remaining = queue.slice(1);
      setQueue(remaining);
      handlePlayTrack(nextTrack, true);
    } else if (currentTrack && isAutoMix) {
      triggerAutoMix(currentTrack, [], true);
    } else if (searchResults.length > 0 && currentTrack) {
      const idx = searchResults.findIndex(t => t.identifier === currentTrack.identifier);
      if (idx >= 0 && idx < searchResults.length - 1) {
        handlePlayTrack(searchResults[idx + 1]);
      }
    }
  };

  // Previous Track
  const handlePreviousTrack = () => {
    if (searchResults.length > 0 && currentTrack) {
      const idx = searchResults.findIndex(t => t.identifier === currentTrack.identifier);
      if (idx > 0) {
        handlePlayTrack(searchResults[idx - 1]);
      }
    }
  };

  // Queue actions
  const handleAddToQueue = (track: Track) => {
    logger.addLog('info', 'System', `Added to queue: "${track.title}"`);
    setQueue((currentQueue) => [...currentQueue, track]);
  };

  const handleRemoveFromQueue = (index: number) => {
    setQueue((currentQueue) => currentQueue.filter((_, idx) => idx !== index));
  };

  const handleClearQueue = () => {
    setQueue([]);
  };

  // Clear History
  const handleClearHistory = () => {
    clearListeningHistory();
    setHistoryItems([]);
  };

  // Lavalink config save & test
  const handleSaveLavalinkConfig = (config: LavalinkConfig) => {
    lavalinkService.updateConfig(config);
    setCurrentConfig(config);
    lavalinkService.testConnection().then(res => setIsConnected(res.success));
  };

  const handleTestLavalink = () => {
    return lavalinkService.testConnection();
  };

  const recentlyPlayedTracks = historyItems.map(h => h.track);

  return (
    <div className={`app-shell theme-${theme} flex h-[100dvh] bg-slate-950 text-slate-100 overflow-hidden font-sans relative`}>

      {/* Sidebar Navigation */}
      <div className="hidden md:block shrink-0">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          openSettings={() => setIsSettingsOpen(true)}
          isConnected={isConnected}
        />
      </div>

      {/* Main Content Area */}
      <div className="app-workspace min-w-0 flex-1 flex flex-col h-[100dvh] overflow-hidden">
        <Header
          onSearchSubmit={handleSearch}
          isConnected={isConnected}
          onOpenSettings={() => setIsSettingsOpen(true)}
          accentColor={accentColor}
        />

        <main className="app-content min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-48 md:pb-24 bg-gradient-to-b from-slate-900/50 via-slate-950 to-slate-950">
          <div key={activeTab} className="animate-page-enter h-full">
            {activeTab === 'home' && (
              <HomeView
                onPlayTrack={handlePlayTrack}
                onSearchQuery={handleSearch}
                recentlyPlayed={recentlyPlayedTracks}
              />
            )}

            {activeTab === 'search' && (
              <SearchView
                searchResults={searchResults}
                isLoading={isSearching}
                onPlayTrack={handlePlayTrack}
                onAddToQueue={handleAddToQueue}
                query={searchQuery}
              />
            )}

            {activeTab === 'history' && (
              <HistoryView
                historyItems={historyItems}
                onPlayTrack={handlePlayTrack}
                onClearHistory={handleClearHistory}
              />
            )}

            {activeTab === 'servers' && (
              <ServerStatusView
                currentConfig={currentConfig}
                onSelectServer={handleSaveLavalinkConfig}
              />
            )}

            {activeTab === 'logs' && (
              <ConsoleLogView />
            )}

            {activeTab === 'about' && (
              <AboutView />
            )}
          </div>
        </main>

        {/* Audio Player Bar */}
        <Player
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onPlayPauseToggle={handlePlayPauseToggle}
          onNext={handleNextTrack}
          onPrevious={handlePreviousTrack}
          onTrackEnd={handleNextTrack}
          queue={queue}
          onToggleQueue={() => setIsQueueOpen(!isQueueOpen)}
          isAutoMix={isAutoMix}
          isAutoMixLoading={isAutoMixLoading}
          onToggleAutoMix={handleToggleAutoMix}
          onToggleLyrics={() => setIsLyricsOpen(!isLyricsOpen)}
          isLyricsOpen={isLyricsOpen}
          onTimeUpdate={(time) => setPlayerCurrentTime(time)}
          seekTime={seekTimeRequested}
          onPlaybackStateChange={setIsPlaying}
        />

        <nav className="mobile-nav md:hidden fixed bottom-0 inset-x-0 z-50 px-1 bg-slate-950/95 border-t border-slate-800 backdrop-blur-xl flex items-center justify-around">
          {[
            { id: 'home' as const, label: 'หน้าหลัก', icon: Home },
            { id: 'search' as const, label: 'ค้นหา', icon: Search },
            { id: 'history' as const, label: 'ประวัติ', icon: History },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`min-w-14 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] transition ${activeTab === id ? 'text-sky-400 bg-sky-500/10' : 'text-slate-500'}`}
            >
              <Icon className="w-5 h-5" />
              <span>{label}</span>
            </button>
          ))}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="min-w-14 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] text-slate-500"
          >
            <Settings className="w-5 h-5" />
            <span>ตั้งค่า</span>
          </button>
        </nav>
      </div>

      {/* Fullscreen Apple Music Player & Synced Karaoke Lyrics */}
      {isLyricsOpen && (
        <AppleMusicPlayerModal
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          currentTime={playerCurrentTime}
          duration={currentTrack?.length ? currentTrack.length / 1000 : 180}
          isAutoMix={isAutoMix}
          isAutoMixLoading={isAutoMixLoading}
          onPlayPauseToggle={handlePlayPauseToggle}
          onNext={handleNextTrack}
          onPrevious={handlePreviousTrack}
          onSeek={(time) => {
            setSeekTimeRequested(time);
            setPlayerCurrentTime(time);
            setTimeout(() => setSeekTimeRequested(null), 100);
          }}
          onToggleAutoMix={handleToggleAutoMix}
          onClose={() => setIsLyricsOpen(false)}
        />
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SettingsModal
          config={currentConfig}
          onSave={handleSaveLavalinkConfig}
          onClose={() => setIsSettingsOpen(false)}
          onTest={handleTestLavalink}
          theme={theme}
          onThemeChange={setTheme}
          accentColor={accentColor}
          onAccentColorChange={setAccentColor}
        />
      )}

      {/* Queue Drawer */}
      {isQueueOpen && (
        <QueueDrawer
          queue={queue}
          currentTrack={currentTrack}
          isAutoMix={isAutoMix}
          isAutoMixLoading={isAutoMixLoading}
          onPlayTrack={(track) => handlePlayTrack(track, true)}
          onRemoveFromQueue={handleRemoveFromQueue}
          onClearQueue={handleClearQueue}
          onClose={() => setIsQueueOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
