// app.js — client-side state and UI wiring

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {Array<{id:string,action:string,value:string,url:string,domContext:string}>} */
let actions = [];

/** @type {EventSource|null} */
let eventSource = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnStart       = document.getElementById('btn-start');
const btnStop        = document.getElementById('btn-stop');
const btnGenerate    = document.getElementById('btn-generate');
const targetUrlInput = document.getElementById('target-url');
const actionList     = document.getElementById('action-list');
const timelinePanel  = document.getElementById('timeline-panel');

// ── Copy buttons ──────────────────────────────────────────────────────────────
document.querySelectorAll('.btn-copy').forEach((btn) => {
  btn.addEventListener('click', () => {
    const code = document.getElementById(btn.dataset.target)?.textContent ?? '';
    navigator.clipboard.writeText(code).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });
});

// ── State helpers ─────────────────────────────────────────────────────────────
function updateAction(id, field, value) {
  const action = actions.find((a) => a.id === id);
  if (action) action[field] = value;
}

function removeAction(id) {
  actions = actions.filter((a) => a.id !== id);
  const tr = actionList.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (tr) tr.remove();
  // Re-number remaining rows
  actionList.querySelectorAll('.row-num').forEach((cell, i) => {
    cell.textContent = String(i + 1);
  });
}

function clearActions() {
  actions = [];
  actionList.innerHTML = '';
}

// ── Row builder ───────────────────────────────────────────────────────────────
function buildRow(action, index) {
  const tr = document.createElement('tr');
  tr.dataset.id = action.id;

  // Row number
  const tdNum = document.createElement('td');
  tdNum.className = 'row-num';
  tdNum.textContent = String(index + 1);
  tr.appendChild(tdNum);

  // Action label (inline editable)
  const tdAction = document.createElement('td');
  const inputAction = document.createElement('input');
  inputAction.type = 'text';
  inputAction.value = action.action;
  inputAction.addEventListener('input', () =>
    updateAction(action.id, 'action', inputAction.value)
  );
  tdAction.appendChild(inputAction);
  tr.appendChild(tdAction);

  // Value (inline editable)
  const tdValue = document.createElement('td');
  const inputValue = document.createElement('input');
  inputValue.type = 'text';
  inputValue.value = action.value;
  inputValue.addEventListener('input', () =>
    updateAction(action.id, 'value', inputValue.value)
  );
  tdValue.appendChild(inputValue);
  tr.appendChild(tdValue);

  // URL — show only the pathname to keep the column narrow
  const tdUrl = document.createElement('td');
  tdUrl.className = 'action-url';
  tdUrl.title = action.url;
  try {
    tdUrl.textContent = new URL(action.url).pathname || action.url;
  } catch (_) {
    tdUrl.textContent = action.url;
  }
  tr.appendChild(tdUrl);

  // Delete button
  const tdDel = document.createElement('td');
  const btnDel = document.createElement('button');
  btnDel.className = 'btn-delete';
  btnDel.textContent = '✕';
  btnDel.addEventListener('click', () => removeAction(action.id));
  tdDel.appendChild(btnDel);
  tr.appendChild(tdDel);

  return tr;
}

function appendActionRow(action) {
  const tr = buildRow(action, actions.length - 1);
  actionList.appendChild(tr);
  // Scroll the new row into view
  tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── SSE connection ────────────────────────────────────────────────────────────
function connectEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  eventSource = new EventSource('/api/session/events');

  eventSource.onmessage = (e) => {
    try {
      const action = JSON.parse(e.data);
      actions.push(action);
      appendActionRow(action);
    } catch (_) { /* ignore malformed frames */ }
  };

  eventSource.onerror = () => {
    // Connection dropped — either the session ended or the server restarted
    eventSource.close();
    eventSource = null;
    timelinePanel.classList.remove('recording');
  };

  // Server signals that the recording browser was closed by the user
  eventSource.addEventListener('stopped', () => {
    disconnectEventSource();
    btnStart.disabled = false;
    btnStop.disabled = true;
  });
}

function disconnectEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  timelinePanel.classList.remove('recording');
}

// ── Session controls ──────────────────────────────────────────────────────────
btnStart?.addEventListener('click', async () => {
  const url = targetUrlInput?.value?.trim();
  if (!url) return;

  btnStart.disabled = true;
  btnStop.disabled = false;
  clearActions();

  try {
    const res = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.ok) {
      timelinePanel.classList.add('recording');
      connectEventSource();
    } else {
      const { error } = await res.json();
      alert(`Failed to start session: ${error}`);
      btnStart.disabled = false;
      btnStop.disabled = true;
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
});

btnStop?.addEventListener('click', async () => {
  btnStop.disabled = true;
  disconnectEventSource();

  try {
    const res = await fetch('/api/session/stop', { method: 'POST' });
    if (res.ok) {
      btnStart.disabled = false;
    } else {
      const { error } = await res.json();
      alert(`Failed to stop session: ${error}`);
      btnStop.disabled = false;
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
    btnStop.disabled = false;
  }
});

// ── Stream helpers ────────────────────────────────────────────────────────────

/** Maps a boundary label to the <code> element ID it should populate. */
const BOUNDARY_TARGET = {
  GHERKIN:     'output-gherkin',
  STEPDEFS:    'output-stepdefs',
  PAGEOBJECTS: 'output-pageobjects',
};

/**
 * Write `content` into a code box and trigger Prism syntax highlighting.
 * The copy buttons use `textContent`, which ignores Prism's span wrappers,
 * so they still return raw code regardless of highlighting state.
 */
function flushSection(label, content) {
  const boxId = BOUNDARY_TARGET[label];
  if (!boxId || !content.trim()) return;
  const el = document.getElementById(boxId);
  if (!el) return;
  // Strip any surrounding code-fence markers the LLM may include
  // e.g. ```gherkin\n...\n``` or ```java\n...\n```
  const stripped = content.trim()
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '');
  el.textContent = stripped;
  if (typeof Prism !== 'undefined') {
    Prism.highlightElement(el);
  }
}

// ── Generate ──────────────────────────────────────────────────────────────────
btnGenerate?.addEventListener('click', async () => {
  if (actions.length === 0) {
    alert('No actions recorded. Start a recording session first.');
    return;
  }

  const endpoint = document.getElementById('llm-endpoint')?.value?.trim();
  const model    = document.getElementById('llm-model')?.value?.trim();
  const key      = document.getElementById('llm-key')?.value?.trim() ?? '';

  if (!endpoint || !model) {
    alert('Please configure the LLM endpoint and model identifier.');
    return;
  }

  const outputs = {
    gherkin:     document.getElementById('chk-gherkin')?.checked     ?? false,
    stepDefs:    document.getElementById('chk-stepdefs')?.checked    ?? false,
    pageObjects: document.getElementById('chk-pageobjects')?.checked ?? false,
  };

  if (!outputs.gherkin && !outputs.stepDefs && !outputs.pageObjects) {
    alert('Select at least one output format.');
    return;
  }

  btnGenerate.disabled = true;
  const originalLabel = btnGenerate.textContent;
  btnGenerate.textContent = 'Generating…';

  // Clear previous output
  Object.values(BOUNDARY_TARGET).forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.removeAttribute('class'); el.className = el.id === 'output-gherkin' ? 'language-gherkin' : 'language-typescript'; }
  });

  let response;
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions, outputs, llm: { endpoint, model, key } }),
    });
  } catch (err) {
    alert(`Network error: ${err.message}`);
    btnGenerate.disabled = false;
    btnGenerate.textContent = originalLabel;
    return;
  }

  if (!response.ok) {
    alert(`Server error ${response.status}: ${response.statusText}`);
    btnGenerate.disabled = false;
    btnGenerate.textContent = originalLabel;
    return;
  }

  // ── Read the multipart boundary stream ─────────────────────────────────────
  const reader   = response.body.getReader();
  const decoder  = new TextDecoder();
  let rawBuffer  = '';       // incomplete line carried between chunks
  let currentLabel = null;  // active boundary section (GHERKIN | STEPDEFS | PAGEOBJECTS | ERROR)
  const sectionBufs = {};   // accumulates content per label until next boundary

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });

      // Process all complete lines; keep the last (possibly incomplete) line
      const lines = rawBuffer.split('\n');
      rawBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        const boundaryMatch = trimmed.match(/^---BOUNDARY:(\w+)---$/);

        if (boundaryMatch) {
          // Flush the previous section before switching
          if (currentLabel && sectionBufs[currentLabel]) {
            flushSection(currentLabel, sectionBufs[currentLabel]);
          }
          const nextLabel = boundaryMatch[1];
          if (nextLabel === 'END') {
            currentLabel = null;
            break;
          }
          if (nextLabel === 'ERROR') {
            currentLabel = 'ERROR';
            sectionBufs['ERROR'] = '';
          } else {
            currentLabel = nextLabel;
            sectionBufs[currentLabel] = sectionBufs[currentLabel] ?? '';
          }
        } else if (currentLabel) {
          sectionBufs[currentLabel] += line + '\n';
        }
      }
    }

    // Flush any content still in the buffer after the stream ends
    if (rawBuffer && currentLabel && currentLabel !== 'ERROR') {
      sectionBufs[currentLabel] = (sectionBufs[currentLabel] ?? '') + rawBuffer;
    }
    if (currentLabel && currentLabel !== 'ERROR' && sectionBufs[currentLabel]) {
      flushSection(currentLabel, sectionBufs[currentLabel]);
    }
    if (sectionBufs['ERROR']) {
      alert(`Generation error: ${sectionBufs['ERROR'].trim()}`);
    }
  } catch (err) {
    alert(`Stream error: ${err.message}`);
  } finally {
    btnGenerate.disabled = false;
    btnGenerate.textContent = originalLabel;
  }
});


