const STORAGE_KEY = 'harvestResults';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'queries' || msg.type === 'no_fanout') {
    enqueueCapture(msg);
    return;
  }

  if (msg.type === 'getResults') {
    chrome.storage.local.get(STORAGE_KEY).then((data) => {
      sendResponse({ results: data[STORAGE_KEY] || [] });
    });
    return true;
  }

  if (msg.type === 'clearResults') {
    chrome.storage.local.set({ [STORAGE_KEY]: [] }).then(() => {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'exportCsv') {
    chrome.storage.local.get(STORAGE_KEY).then((data) => {
      const rows = data[STORAGE_KEY] || [];
      sendResponse({ csv: rowsToCsv(rows) });
    });
    return true;
  }
});

let captureQueue = Promise.resolve();
function enqueueCapture(msg) {
  captureQueue = captureQueue
    .then(() => handleCapture(msg))
    .catch((err) => console.debug('handleCapture failed', err));
}

async function handleCapture(msg) {
  const payload = msg.payload || {};
  const dedupeKey =
    (payload.messageId || '') +
    '|' +
    (payload.conversationId || '') +
    '|' +
    (msg.type === 'queries' ? (payload.queries || []).join('||') : 'nofanout');

  const data = await chrome.storage.local.get(STORAGE_KEY);
  const results = data[STORAGE_KEY] || [];
  if (results.some((r) => r._dedupeKey === dedupeKey)) return;

  const row = {
    _dedupeKey: dedupeKey,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    userPrompt: payload.userPrompt || '',
    queries: msg.type === 'queries' ? payload.queries || [] : [],
    queryCount: msg.type === 'queries' ? (payload.queries || []).length : 0,
    conversationId: payload.conversationId || '',
    messageId: payload.messageId || '',
    modelSlug: payload.modelSlug || '',
    noFanout: msg.type === 'no_fanout',
  };
  results.push(row);
  await chrome.storage.local.set({ [STORAGE_KEY]: results });

  chrome.runtime.sendMessage({ type: 'resultAdded', row }).catch(() => {});

  const captured = results.filter((r) => !r.noFanout).length;
  chrome.action.setBadgeText({ text: captured > 0 ? String(captured) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a7a5a' });
}

function rowsToCsv(rows) {
  const headers = [
    'capturedAt',
    'userPrompt',
    'queryCount',
    'queriesJoined',
    'conversationId',
    'messageId',
    'modelSlug',
    'noFanout',
  ];
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.capturedAt,
        r.userPrompt,
        r.queryCount,
        (r.queries || []).join(' || '),
        r.conversationId,
        r.messageId,
        r.modelSlug,
        r.noFanout ? 'true' : 'false',
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\n');
}
