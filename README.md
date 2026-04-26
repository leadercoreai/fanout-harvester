# ChatGPT Fan-Out Harvester

Chrome extension that silently captures the hidden search queries ChatGPT runs to ground its answers (the `metadata.search_model_queries` field inside the conversation API response) and exports them to CSV.

You drive ChatGPT normally — paste prompts, read answers, open new chats. The extension watches the network in the background and accumulates every fan-out it sees. When you're done, click **Export CSV**.

## Install

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder (`chatgpt-fanout-harvester`).
4. Pin the extension to your toolbar for easy access.

## Use

1. Open https://chatgpt.com and log in.
2. Run any prompt that triggers a web search (ask about recent news, comparisons, "latest", etc.).
3. Click the extension icon. Each search-triggering prompt appears as a row with the fan-out queries listed below it. Prompts that didn't trigger search show as "no fan-out".
4. Click **Export CSV** to download everything captured so far.
5. Click **Clear** to wipe and start fresh.

CSV columns: `capturedAt, userPrompt, queryCount, queriesJoined, conversationId, messageId, modelSlug, noFanout`.

`queriesJoined` uses ` || ` as the separator between queries.

## How it works

- `content.js` runs on `chatgpt.com` at `document_start` and injects `injected.js` into the page's world.
- `injected.js` monkey-patches `window.fetch`. When ChatGPT POSTs to `/backend-api/.../conversation`, it tees the streaming response, parses the SSE events, and pulls out any `search_model_queries` array it finds.
- The user prompt is read from the POST request body (the last `user` message in the `messages` array).
- Captures are relayed via `window.postMessage` → `content.js` → `chrome.runtime.sendMessage` to the service worker, which persists them in `chrome.storage.local`.
- The popup reads from storage and re-renders live as new captures arrive.

No network traffic originates from the extension — it only observes the site's own requests. No login automation, no DOM typing, no batch orchestration.

## Known limitations

- **Not every prompt produces a fan-out.** The `search_model_queries` field only appears when ChatGPT actually decides to search. Casual/conversational prompts show as "no fan-out".
- **Field location can drift.** OpenAI has reorganized this metadata before. If captures suddenly stop, open DevTools → Network → filter for `conversation`, search response for `search_model_queries` or similar, and update `injected.js` accordingly. The walker in `injected.js` finds the array at any depth, so minor nesting changes are tolerated automatically.
- **Model-dependent visibility.** Some model versions (reportedly GPT-5.3 era) stopped exposing the field in the web payload entirely. If every prompt reports "no fan-out" even for clearly search-triggered ones, the field is probably hidden for your current model — try a different model, or switch to a sanctioned API with grounded search if you need programmatic access.
- **Chromium only.** Uses Chrome MV3 APIs; Firefox port would need adjustment to content-script injection semantics.

## Files

```
manifest.json   MV3 config
background.js   Service worker: storage, CSV export
content.js      Injects injected.js, relays postMessage to background
injected.js     Page-world fetch hook, SSE parser, query extractor
popup.html/js/css   Live results UI + CSV export
```
