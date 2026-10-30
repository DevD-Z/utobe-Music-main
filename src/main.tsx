import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css";

// Unregister any stale Service Worker and clear stale caches on desktop
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
    }
  }).catch(() => {});

  if (typeof caches !== 'undefined') {
    caches.keys().then((keys) => {
      for (const key of keys) {
        caches.delete(key);
      }
    }).catch(() => {});
  }
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error: String(error?.message || error) };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('App Crash caught by ErrorBoundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '30px', color: '#fff', backgroundColor: '#090d16', minHeight: '100vh', fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#f43f5e' }}>เกิดข้อผิดพลาดในการโหลด (App Error)</h2>
          <pre style={{ backgroundColor: '#1e293b', padding: '15px', borderRadius: '8px', overflow: 'auto', marginTop: '10px' }}>
            {this.state.error}
          </pre>
          <button
            onClick={() => {
              localStorage.clear();
              window.location.reload();
            }}
            style={{ marginTop: '15px', padding: '10px 20px', borderRadius: '8px', backgroundColor: '#0ea5e9', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
          >
            ล้างแคชและโหลดใหม่ (Reset & Reload)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');

function showBootstrapError(error: unknown) {
  console.error('[BOOT] JavaScript startup failed:', error);
  if (!rootElement) return;
  const message = error instanceof Error ? error.message : String(error);
  rootElement.innerHTML = '';
  const panel = document.createElement('pre');
  panel.style.cssText = 'box-sizing:border-box;margin:0;padding:30px;color:#fff;background:#090d16;min-height:100vh;white-space:pre-wrap;font-family:sans-serif';
  panel.textContent = `เกิดข้อผิดพลาดก่อนโหลดแอป (Startup Error)\n\n${message}`;
  rootElement.appendChild(panel);
}

window.addEventListener('error', (event) => {
  if (!rootElement?.hasChildNodes()) showBootstrapError(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  if (!rootElement?.hasChildNodes()) showBootstrapError(event.reason);
});

if (!rootElement) {
  throw new Error('Missing #root element');
}

console.info('[BOOT] JavaScript entry');
void import('./App').then(({ default: App }) => {
  console.info('[BOOT] React mounting');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}).catch(showBootstrapError);
