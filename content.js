(function () {
  // Inject page-world hook as early as possible.
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(
      script
    );
  } catch (err) {
    console.debug('[fanout-harvest] failed to inject page-world script', err);
  }

  // Relay captures from page world to the service worker.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'cgpt-harvest') return;
    if (data.type !== 'queries' && data.type !== 'no_fanout') return;
    try {
      chrome.runtime
        .sendMessage({ type: data.type, payload: data.payload })
        .catch(() => {
          // Service worker may be asleep; capture is persisted in storage on next wake.
        });
    } catch (_) {
      // Extension context invalidated (e.g. after reload); ignore.
    }
  });
})();
