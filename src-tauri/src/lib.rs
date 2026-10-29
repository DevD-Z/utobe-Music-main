#[cfg(desktop)]
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::Manager;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Response, StatusCode},
    routing::get,
    Router,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{atomic::{AtomicU64, Ordering}, Arc},
    time::Duration,
};
use tokio::sync::RwLock;

/// Ordered by how likely the node is to return audio formats. A client that
/// cannot serve the video rejects in a fraction of a second, whereas letting the
/// YouTube plugin walk its whole configured list takes upwards of 40s before it
/// gives up — long enough to look like the app had simply frozen.
const YOUTUBE_CLIENTS: [&str; 5] = ["MUSIC", "ANDROID_VR", "IOS", "TV", "WEB"];

/// Upper bound on how long one client may take to produce response headers.
const CLIENT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(9);

/// Deadline for the up-front probe that picks a client. A node that cannot
/// extract formats answers in well under this; measured worst case on the hosted
/// node is 6.2s, and all clients are probed at once, so this bounds the whole
/// resolution step rather than a single attempt.
const CLIENT_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Tokens are kept around after the next song is prepared so range requests the
/// player still has in flight for the current song keep resolving.
const MAX_TRACKED_STREAMS: usize = 16;

#[derive(Clone)]
struct StreamTarget {
    base_url: String,
    video_id: String,
    password: String,
    /// The client that last served this token, tried first on later requests so
    /// seeking does not re-walk the dead ones.
    resolved_client: Option<String>,
}

#[derive(Default)]
struct StreamRegistry {
    entries: HashMap<String, StreamTarget>,
    order: VecDeque<String>,
}

impl StreamRegistry {
    fn insert(&mut self, token: String, target: StreamTarget) {
        while self.order.len() >= MAX_TRACKED_STREAMS {
            match self.order.pop_front() {
                Some(oldest) => { self.entries.remove(&oldest); }
                None => break,
            }
        }
        self.order.push_back(token.clone());
        self.entries.insert(token, target);
    }
}

#[derive(Clone)]
struct StreamProxyState {
    port: u16,
    targets: Arc<RwLock<StreamRegistry>>,
    next_id: Arc<AtomicU64>,
    /// One pooled client for the whole process. Building a client per request
    /// threw away every keep-alive connection, so each range request paid a
    /// fresh TCP and TLS handshake to the node.
    http: reqwest::Client,
}

#[derive(Clone, Default)]
struct AudioProxyState {
    inner: Arc<RwLock<Option<StreamProxyState>>>,
}

async fn proxy_stream(
    State(state): State<StreamProxyState>,
    Path(token): Path<String>,
    request_headers: HeaderMap,
) -> Result<Response<Body>, StatusCode> {
    let target = state.targets.read().await.entries.get(&token).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let range = request_headers.get(header::RANGE).cloned();

    let mut clients: Vec<&str> = Vec::with_capacity(YOUTUBE_CLIENTS.len());
    if let Some(preferred) = target.resolved_client.as_deref() {
        clients.push(preferred);
    }
    clients.extend(
        YOUTUBE_CLIENTS.iter().copied()
            .filter(|name| Some(*name) != target.resolved_client.as_deref()),
    );

    let mut last_status = StatusCode::BAD_GATEWAY;
    for client_name in clients {
        let url = format!(
            "{}/youtube/stream/{}?withClient={}",
            target.base_url, target.video_id, client_name
        );
        let mut request = state.http.get(&url).header(header::AUTHORIZATION, &target.password);
        if let Some(ref value) = range {
            request = request.header(header::RANGE, value);
        }

        // Time out the header phase only. A total request timeout would cut the
        // audio off mid-song.
        let upstream = match tokio::time::timeout(CLIENT_ATTEMPT_TIMEOUT, request.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => { last_status = StatusCode::BAD_GATEWAY; continue; }
            Err(_) => { last_status = StatusCode::GATEWAY_TIMEOUT; continue; }
        };

        let status = upstream.status();
        if !status.is_success() {
            last_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            continue;
        }

        if let Some(entry) = state.targets.write().await.entries.get_mut(&token) {
            entry.resolved_client = Some(client_name.to_string());
        }

        let upstream_headers = upstream.headers().clone();
        let mut response = Response::builder().status(status);
        for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
            if let Some(value) = upstream_headers.get(&name) {
                response = response.header(name, value);
            }
        }
        return response.body(Body::from_stream(upstream.bytes_stream()))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    Err(last_status)
}

fn start_stream_proxy() -> Result<StreamProxyState, String> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Cannot start audio proxy: {error}"))?;
    listener.set_nonblocking(true)
        .map_err(|error| format!("Cannot configure audio proxy: {error}"))?;
    let port = listener.local_addr()
        .map_err(|error| format!("Cannot read audio proxy address: {error}"))?.port();
    let http = reqwest::Client::builder()
        // Keep the Lavalink TLS connection hot across screen-lock periods and
        // prewarmed track transitions. Reconnecting during a range request is
        // audible on mobile networks, especially when iOS has just suspended
        // the WebView and AVPlayer is the only component still running.
        .connect_timeout(Duration::from_secs(6))
        .pool_idle_timeout(Duration::from_secs(5 * 60))
        .pool_max_idle_per_host(16)
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Cannot build audio proxy client: {error}"))?;
    let targets = Arc::new(RwLock::new(StreamRegistry::default()));
    let state = StreamProxyState {
        port,
        targets: targets.clone(),
        next_id: Arc::new(AtomicU64::new(1)),
        http,
    };
    let router = Router::new()
        .route("/stream/{token}", get(proxy_stream))
        .with_state(state.clone());
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => { let _ = axum::serve(listener, router).await; }
            Err(error) => eprintln!("audio proxy failed: {error}"),
        }
    });
    Ok(state)
}

/// Ask the node for a single byte to learn whether this client can serve the
/// video at all. Only the header phase is awaited — the body is dropped, which
/// cancels the transfer before any audio is downloaded.
async fn client_can_serve(
    http: reqwest::Client,
    base_url: String,
    video_id: String,
    password: String,
    client_name: &'static str,
) -> Option<&'static str> {
    let url = format!("{base_url}/youtube/stream/{video_id}?withClient={client_name}");
    let request = http
        .get(&url)
        .header(header::AUTHORIZATION, password)
        .header(header::RANGE, "bytes=0-0");
    match tokio::time::timeout(CLIENT_PROBE_TIMEOUT, request.send()).await {
        Ok(Ok(response)) if response.status().is_success() => Some(client_name),
        _ => None,
    }
}

/// Probe every client at once and keep whichever answers first.
///
/// `proxy_stream` used to discover this by walking the list one client at a time
/// while the player waited on response headers — measured at 18.7s on the hosted
/// node. androidx.media3's `DefaultHttpDataSource` gives up at roughly 8s, so
/// media3 was guaranteed to time out even when a later client would have worked.
async fn resolve_stream_client(
    http: &reqwest::Client,
    base_url: &str,
    video_id: &str,
    password: &str,
) -> Option<&'static str> {
    let (report, mut results) = tokio::sync::mpsc::channel(YOUTUBE_CLIENTS.len());
    let mut probes = Vec::with_capacity(YOUTUBE_CLIENTS.len());
    for client_name in YOUTUBE_CLIENTS {
        let probe = client_can_serve(
            http.clone(),
            base_url.to_string(),
            video_id.to_string(),
            password.to_string(),
            client_name,
        );
        let report = report.clone();
        probes.push(tauri::async_runtime::spawn(async move {
            let _ = report.send(probe.await).await;
        }));
    }
    // The loop below ends on channel close, so the only remaining sender has to go.
    drop(report);

    let mut winner = None;
    while let Some(outcome) = results.recv().await {
        if outcome.is_some() {
            winner = outcome;
            break;
        }
    }
    for probe in probes {
        probe.abort();
    }
    winner
}

#[tauri::command]
async fn prepare_lavalink_stream(
    state: tauri::State<'_, AudioProxyState>,
    video_id: String,
    base_url: String,
    password: String,
) -> Result<String, String> {
    // Lazily create the loopback proxy on first playback instead of during app
    // startup. This keeps iOS launch free of socket/runtime work and prevents an
    // audio infrastructure failure from taking down the whole application.
    let proxy = if let Some(existing) = state.inner.read().await.clone() {
        existing
    } else {
        let created = start_stream_proxy()?;
        let mut slot = state.inner.write().await;
        if slot.is_none() {
            *slot = Some(created.clone());
        }
        slot.clone().unwrap_or(created)
    };
    if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid YouTube video ID".into());
    }
    let base = reqwest::Url::parse(&base_url).map_err(|_| "Invalid Lavalink URL")?;
    if base.scheme() != "https" {
        return Err("Native streaming requires HTTPS".into());
    }
    let base_url = base_url.trim_end_matches('/').to_string();

    // Settle on a working client before handing out a URL. Returning one blindly
    // meant a node that cannot extract this video still looked playable, and the
    // player only found out when media3 timed out ~19s later.
    let resolved_client = resolve_stream_client(&proxy.http, &base_url, &video_id, &password)
        .await
        .ok_or_else(|| {
            format!("The Lavalink node cannot extract audio for {video_id} with any YouTube client")
        })?;

    let token = format!("{}-{}", video_id, proxy.next_id.fetch_add(1, Ordering::Relaxed));
    proxy.targets.write().await.insert(token.clone(), StreamTarget {
        base_url,
        video_id,
        password,
        resolved_client: Some(resolved_client.to_string()),
    });
    Ok(format!("http://127.0.0.1:{}/stream/{token}", proxy.port))
}

#[cfg(desktop)]
struct DiscordState {
    client: Mutex<Option<DiscordIpcClient>>,
    started_at: i64,
}

#[cfg(desktop)]
impl Default for DiscordState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default(),
        }
    }
}

#[cfg(desktop)]
fn configured_client_id() -> Result<&'static str, String> {
    option_env!("HOTDOGDOT_DISCORD_CLIENT_ID")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Discord Rich Presence is disabled: DISCORD_CLIENT_ID is not configured".to_string())
}

#[cfg(desktop)]
fn connected_client() -> Result<DiscordIpcClient, String> {
    let mut client = DiscordIpcClient::new(configured_client_id()?).map_err(|error| error.to_string())?;
    client.connect().map_err(|error| error.to_string())?;
    Ok(client)
}

#[tauri::command]
#[cfg(desktop)]
fn discord_initialize(state: tauri::State<'_, DiscordState>) -> Result<(), String> {
    let mut slot = state.client.lock().map_err(|_| "Discord state is unavailable".to_string())?;
    if slot.is_none() { *slot = Some(connected_client()?); }
    Ok(())
}

#[tauri::command]
#[cfg(desktop)]
fn discord_update_activity(
    page: Option<String>,
    details: Option<String>,
    state_text: Option<String>,
    large_image: Option<String>,
    large_text: Option<String>,
    small_image: Option<String>,
    small_text: Option<String>,
    state: tauri::State<'_, DiscordState>,
) -> Result<(), String> {
    let mut slot = state.client.lock().map_err(|_| "Discord state is unavailable".to_string())?;
    if slot.is_none() { *slot = Some(connected_client()?); }
    let details_str = details.unwrap_or_else(|| "Using hotdogdot".to_string());
    let state_str = state_text.or(page).unwrap_or_else(|| "Listening to music".to_string());
    let large_img = large_image.unwrap_or_else(|| "hotdogdot".to_string());
    let large_txt = large_text.unwrap_or_else(|| "hotdogdot".to_string());

    let mut assets = activity::Assets::new()
        .large_image(&large_img)
        .large_text(&large_txt);

    if let Some(ref small_img) = small_image {
        if !small_img.is_empty() {
            assets = assets.small_image(small_img);
            if let Some(ref small_txt) = small_text {
                if !small_txt.is_empty() {
                    assets = assets.small_text(small_txt);
                }
            }
        }
    }

    let activity = activity::Activity::new()
        .details(&details_str)
        .state(&state_str)
        .assets(assets)
        .timestamps(activity::Timestamps::new().start(state.started_at));

    let client = slot.as_mut().ok_or_else(|| "Discord is unavailable".to_string())?;
    if client.set_activity(activity.clone()).is_err() {
        let mut replacement = connected_client()?;
        replacement.set_activity(activity).map_err(|error| error.to_string())?;
        *client = replacement;
    }
    Ok(())
}

#[tauri::command]
#[cfg(desktop)]
fn discord_clear_activity(state: tauri::State<'_, DiscordState>) -> Result<(), String> {
    let mut slot = state.client.lock().map_err(|_| "Discord state is unavailable".to_string())?;
    if let Some(client) = slot.as_mut() { client.clear_activity().map_err(|error| error.to_string())?; }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(AudioProxyState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_native_audio::init());
    #[cfg(desktop)]
    let builder = builder
        .manage(DiscordState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::include_image!("icons/128x128.png");
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![discord_initialize, discord_update_activity, discord_clear_activity, prepare_lavalink_stream])
        ;
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![prepare_lavalink_stream]);
    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("hotdogdot runtime exited with error: {error}");
    }
}
