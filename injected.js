(function () {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.debug('[fanout-harvest]', ...a);

  // Match any URL under /backend-api that ends in /conversation or /conversation/...
  // Allows zero or more path segments between /backend-api/ and conversation.
  const CONV_RE = /\/backend-api\/(?:[^?#]*\/)?conversation(?:\?|$|\/|#)/;

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input.url === 'string'
          ? input.url
          : '';
    const method =
      (init && init.method) ||
      (input && typeof input === 'object' && input.method) ||
      'GET';

    const isConv = CONV_RE.test(url);

    let userPrompt = null;
    if (isConv && String(method).toUpperCase() === 'POST') {
      userPrompt = extractUserPromptFromBody(init && init.body);
    }

    const response = await originalFetch.apply(this, arguments);

    if (isConv && response && response.body) {
      log('hooking response', method, url);
      try {
        const clone = response.clone();
        consumeAndHarvest(clone, userPrompt, url, method).catch((err) =>
          log('consume error', err)
        );
      } catch (err) {
        log('clone failed', err);
      }
    }

    return response;
  };

  // Also hook XHR as a defensive fallback in case any ChatGPT code paths use it.
  const OrigXHR = window.XMLHttpRequest;
  function HookedXHR() {
    const xhr = new OrigXHR();
    let url = '';
    let method = 'GET';
    let reqBody = null;

    const origOpen = xhr.open;
    xhr.open = function (m, u) {
      method = m;
      url = u;
      return origOpen.apply(xhr, arguments);
    };

    const origSend = xhr.send;
    xhr.send = function (body) {
      reqBody = body;
      xhr.addEventListener('load', function () {
        if (!CONV_RE.test(url)) return;
        log('hooking XHR response', method, url);
        const userPrompt =
          String(method).toUpperCase() === 'POST'
            ? extractUserPromptFromBody(reqBody)
            : null;
        const text =
          typeof xhr.responseText === 'string' ? xhr.responseText : '';
        harvestFromText(text, userPrompt, url);
      });
      return origSend.apply(xhr, arguments);
    };

    return xhr;
  }
  HookedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = HookedXHR;

  function extractUserPromptFromBody(body) {
    if (body == null) return null;
    try {
      let text;
      if (typeof body === 'string') {
        text = body;
      } else if (body instanceof ArrayBuffer) {
        text = new TextDecoder().decode(body);
      } else if (ArrayBuffer.isView(body)) {
        text = new TextDecoder().decode(body.buffer);
      } else {
        return null;
      }
      const parsed = JSON.parse(text);
      const msgs = parsed && parsed.messages;
      if (!Array.isArray(msgs)) return null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const role = (m && m.author && m.author.role) || (m && m.role);
        if (role === 'user') {
          const parts = (m && m.content && m.content.parts) || [];
          return parts
            .map((p) => (typeof p === 'string' ? p : p && p.text ? p.text : ''))
            .join('\n')
            .trim();
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async function consumeAndHarvest(response, userPrompt, url, method) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      let read;
      try {
        read = await reader.read();
      } catch (err) {
        log('reader error', err);
        break;
      }
      if (read.done) break;
      full += decoder.decode(read.value, { stream: true });
    }

    log(
      'response body length',
      full.length,
      'first 200 chars:',
      full.slice(0, 200)
    );

    const harvested = harvestFromText(full, userPrompt, url);
    log('harvested', harvested, 'fan-outs from', method, url);
  }

  // Unified extractor that works on both SSE (data: ... lines) bodies and plain JSON.
  function harvestFromText(text, userPrompt, url) {
    if (!text) return 0;

    const ctx = { conversationId: null, messageId: null, modelSlug: null };
    const seen = new Set();
    let harvestedCount = 0;

    const considerObject = (obj) => {
      updateCtx(obj, ctx);
      // Also walk the whole object for nested context (e.g. inside mapping/messages)
      walkForCtx(obj, ctx);

      if (
        !containsKey(obj, 'search_model_queries') &&
        !containsKey(obj, 'queries')
      ) {
        return;
      }
      const found = [];
      walk(obj, found);
      for (const queries of found) {
        const key =
          (ctx.messageId || '') +
          '|' +
          (ctx.conversationId || '') +
          '|' +
          queries.join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        harvestedCount++;
        postToContentScript('queries', {
          userPrompt,
          queries,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          modelSlug: ctx.modelSlug,
          url,
          capturedAt: new Date().toISOString(),
        });
      }
    };

    // Strategy 1: try full-body JSON parse (covers GET /backend-api/conversation/<id>).
    let parsedWhole = null;
    try {
      parsedWhole = JSON.parse(text);
    } catch (_) {
      // Not plain JSON; fall through to SSE parsing.
    }
    if (parsedWhole) {
      considerObject(parsedWhole);
    } else {
      // Strategy 2: SSE — split on blank lines, parse each event's data: payload.
      const events = text.split(/\n\n+/);
      for (const eventText of events) {
        const dataLines = eventText
          .split('\n')
          .filter((l) => l.startsWith('data:'));
        if (dataLines.length === 0) continue;
        const dataText = dataLines.map((l) => l.slice(5).trim()).join('\n');
        if (!dataText || dataText === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(dataText);
        } catch (_) {
          continue;
        }
        considerObject(obj);
      }
    }

    // Strategy 3: last-resort regex scan over raw text for any "queries":[...]
    // blocks we may have missed due to unusual framing.
    if (harvestedCount === 0) {
      const found = regexScanForQueries(text);
      for (const queries of found) {
        const key =
          (ctx.messageId || '') +
          '|' +
          (ctx.conversationId || '') +
          '|regex|' +
          queries.join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        harvestedCount++;
        postToContentScript('queries', {
          userPrompt,
          queries,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          modelSlug: ctx.modelSlug,
          url: url + ' (regex-fallback)',
          capturedAt: new Date().toISOString(),
        });
      }
    }

    if (harvestedCount === 0) {
      postToContentScript('no_fanout', {
        userPrompt,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        modelSlug: ctx.modelSlug,
        url,
        capturedAt: new Date().toISOString(),
      });
    }

    return harvestedCount;
  }

  function regexScanForQueries(text) {
    const results = [];
    const re = /"(?:search_model_queries|queries)"\s*:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[1];
      // Extract all double-quoted strings, respecting backslash escapes.
      const strRe = /"((?:[^"\\]|\\.)*)"/g;
      const strs = [];
      let sm;
      while ((sm = strRe.exec(inner)) !== null) {
        try {
          strs.push(JSON.parse('"' + sm[1] + '"'));
        } catch (_) {
          strs.push(sm[1]);
        }
      }
      if (strs.length === 0) continue;
      const looks = strs.every(
        (s) => typeof s === 'string' && s.length >= 3 && /\s/.test(s)
      );
      if (!looks) continue;
      results.push(strs);
    }
    return results;
  }

  function walkForCtx(node, ctx, depth) {
    if (!node || typeof node !== 'object') return;
    if ((depth || 0) > 20) return;
    updateCtx(node, ctx);
    if (Array.isArray(node)) {
      for (const item of node) walkForCtx(item, ctx, (depth || 0) + 1);
      return;
    }
    for (const v of Object.values(node)) {
      walkForCtx(v, ctx, (depth || 0) + 1);
    }
  }

  function updateCtx(node, ctx) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.conversation_id === 'string')
      ctx.conversationId = node.conversation_id;
    if (node.message && typeof node.message.id === 'string')
      ctx.messageId = node.message.id;
    if (
      node.message &&
      node.message.metadata &&
      typeof node.message.metadata.model_slug === 'string'
    ) {
      ctx.modelSlug = node.message.metadata.model_slug;
    }
    if (typeof node.model_slug === 'string') ctx.modelSlug = node.model_slug;
  }

  function containsKey(obj, key) {
    try {
      return JSON.stringify(obj).indexOf('"' + key + '"') !== -1;
    } catch (_) {
      return true;
    }
  }

  function walk(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out);
      return;
    }
    for (const key of ['search_model_queries', 'queries']) {
      const arr = node[key];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const normalized = arr
        .map((q) =>
          typeof q === 'string'
            ? q
            : q && typeof q.query === 'string'
              ? q.query
              : q && typeof q.q === 'string'
                ? q.q
                : null
        )
        .filter((s) => typeof s === 'string' && s.length > 0);
      if (normalized.length === 0) continue;
      const looksLikeSearchQueries = normalized.every(
        (s) => s.length >= 3 && /\s/.test(s)
      );
      if (!looksLikeSearchQueries) continue;
      out.push(normalized);
    }
    // Always recurse — current format nests queries inside an object at
    // the `search_model_queries` key, so we must descend into it even
    // though the key itself matched above.
    for (const k of Object.keys(node)) {
      walk(node[k], out);
    }
  }

  function postToContentScript(type, payload) {
    window.postMessage(
      { source: 'cgpt-harvest', type, payload },
      window.location.origin
    );
  }

  log('injected');
})();
