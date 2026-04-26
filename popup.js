const resultsEl = document.getElementById('results');
const totalEl = document.getElementById('total');
const noFanoutEl = document.getElementById('noFanout');
const rowTemplate = document.getElementById('rowTemplate');

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render(results) {
  resultsEl.innerHTML = '';
  const sorted = [...results].sort((a, b) =>
    (b.capturedAt || '').localeCompare(a.capturedAt || '')
  );

  let captured = 0;
  let noFanout = 0;

  if (sorted.length === 0) {
    resultsEl.innerHTML =
      '<div class="empty">No captures yet.<br>Use ChatGPT as you normally would. Prompts that trigger a web search will show up here.</div>';
    totalEl.textContent = '0';
    noFanoutEl.textContent = '0';
    return;
  }

  for (const r of sorted) {
    if (r.noFanout) noFanout++;
    else captured++;
    const node = rowTemplate.content.cloneNode(true);
    node.querySelector('.time').textContent = formatTime(r.capturedAt);
    const countEl = node.querySelector('.count');
    if (r.noFanout) {
      countEl.textContent = 'no fan-out';
      countEl.classList.add('muted');
    } else {
      countEl.textContent =
        r.queryCount + (r.queryCount === 1 ? ' query' : ' queries');
    }
    node.querySelector('.prompt').textContent =
      r.userPrompt || '(prompt unavailable)';
    const ul = node.querySelector('.queries');
    if (r.queries && r.queries.length) {
      for (const q of r.queries) {
        const li = document.createElement('li');
        li.textContent = q;
        ul.appendChild(li);
      }
    } else {
      ul.remove();
    }
    resultsEl.appendChild(node);
  }

  totalEl.textContent = String(captured);
  noFanoutEl.textContent = String(noFanout);
}

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: 'getResults' });
  render((resp && resp.results) || []);
}

document.getElementById('exportBtn').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'exportCsv' });
  if (!resp || !resp.csv) return;
  const blob = new Blob([resp.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = 'chatgpt-fanouts-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear all captured rows? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'clearResults' });
  load();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'resultAdded') load();
});

load();
