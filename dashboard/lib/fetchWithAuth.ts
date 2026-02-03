let sessionExpiredOverlay: HTMLElement | null = null;

function showSessionExpiredOverlay() {
  if (sessionExpiredOverlay) return;
  const overlay = document.createElement('div');
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;
                display:flex;align-items:center;justify-content:center">
      <div style="background:white;padding:2rem;border-radius:0.5rem;text-align:center;
                  max-width:400px">
        <h2 style="margin:0 0 1rem;font-size:1.25rem">Session expired</h2>
        <p style="margin:0 0 1.5rem;color:#666">Your session has expired. Please sign in again.</p>
        <button onclick="window.location.href='/login?redirect=' + encodeURIComponent(window.location.pathname)"
                style="padding:0.5rem 1.5rem;background:#2563eb;color:white;border:none;
                       border-radius:0.375rem;cursor:pointer;font-size:1rem">
          Sign in
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  sessionExpiredOverlay = overlay;
}

function dismissSessionExpiredOverlay() {
  if (!sessionExpiredOverlay) return;
  sessionExpiredOverlay.remove();
  sessionExpiredOverlay = null;
}

let serverErrorBanner: HTMLElement | null = null;

function showServerErrorWarning(status: number) {
  if (serverErrorBanner) return;
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9998;background:#fef3c7;border-bottom:2px solid #f59e0b;padding:0.75rem 1rem;display:flex;align-items:center;justify-content:center;gap:0.5rem;font-size:0.875rem;color:#92400e';
  banner.innerHTML = `
    <span>Server error (${status}). Some data may be unavailable.</span>
    <button style="margin-left:1rem;padding:0.25rem 0.75rem;background:#f59e0b;color:white;border:none;border-radius:0.25rem;cursor:pointer;font-size:0.8rem">
      Dismiss
    </button>`;
  banner.querySelector('button')!.addEventListener('click', () => {
    dismissServerErrorWarning();
  });
  document.body.appendChild(banner);
  serverErrorBanner = banner;
}

function dismissServerErrorWarning() {
  if (!serverErrorBanner) return;
  serverErrorBanner.remove();
  serverErrorBanner = null;
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  const res = await fetch(input, { ...init, headers, redirect: 'follow' });
  if (res.status === 401 || res.status === 403) {
    showSessionExpiredOverlay();
    return new Promise(() => {});
  }
  if (res.status >= 500) {
    showServerErrorWarning(res.status);
  } else if (res.status < 400) {
    dismissServerErrorWarning();
    dismissSessionExpiredOverlay();
  }
  return res;
}
