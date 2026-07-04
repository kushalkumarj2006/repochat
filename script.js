// ============================================================
// BACKEND CONFIG - UPDATED FOR NEW BACKEND URL
// ============================================================
const BACKEND_URL = 'https://tempo-agxk.onrender.com';
let SECRET_KEY = localStorage.getItem('askrepo_key') || '';
window.key = function(str) {
  if (str && str.trim()) {
    SECRET_KEY = str.trim();
    localStorage.setItem('askrepo_key', SECRET_KEY);
    console.log('🔑 Key saved');
    return '✅ Key saved';
  }
  console.warn('❌ Provide a valid key');
  return '❌ Invalid';
};
// ============================================================
// DOM REFS
// ============================================================
const setupPanel = document.getElementById('setupPanel');
const hamburgerBtn = document.getElementById('hamburgerBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const endSessionBtn = document.getElementById('endSessionBtn');
const confirmRepoBtn = document.getElementById('confirmRepoBtn');
const repoInput = document.getElementById('repoInput');
const repoDisplay = document.getElementById('repoDisplay');
const repoStatus = document.getElementById('repoStatus');
const cellOutput = document.getElementById('cellOutput');
const cellStatus = document.getElementById('cellStatus');
const setupStatus = document.getElementById('setupStatus');
const indexStatus = document.getElementById('indexStatus');
const fileStats = document.getElementById('fileStats');
const sessionBadge = document.getElementById('sessionBadge');
const step1num = document.getElementById('step1num');
const step3num = document.getElementById('step3num');
const step4num = document.getElementById('step4num');
const chatMessages = document.getElementById('chatMessages');
const questionInput = document.getElementById('questionInput');
const askFastBtn = document.getElementById('askFastBtn');
const askSimpleBtn = document.getElementById('askSimpleBtn');
const chatStatus = document.getElementById('chatStatus');
// ============================================================
// STATE
// ============================================================
let sessionId = null;
let cellRunning = false;
let shouldStop = false;
let repoConfirmed = false;
let repoUrl = '';
let chatEnabled = false;
let currentExecutionId = null;
let pollInterval = null;
let cellsCompleted = { cell1: false, cell2: false, cell3: false, cell4: false };
// RAG state
let ragInitialized = false;
// ============================================================
// CONSTANTS
// ============================================================
const EXECUTION_TIMEOUT = 1200; // 20 minutes in seconds
// ============================================================
// HELPERS
// ============================================================
function parseRepoUrl(input) {
  let s = input.trim().replace(/\/$/, '');
  if (s.includes('github.com')) {
    const m = s.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (m) return { owner: m[1], repo: m[2] };
  }
  const parts = s.split('/');
  if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
  return null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function updateStepNum(el, state) {
  el.className = 'step-num';
  if (state === 'done') el.classList.add('done');
  else if (state === 'active') el.classList.add('active');
}
function consoleLog(msg, type = 'info') {
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`[AskRepo] ${prefix} ${msg}`);
}
// ============================================================
// BACKEND API - UPDATED FOR NEW BACKEND
// ============================================================
async function apiCall(endpoint, body = {}, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (SECRET_KEY) headers['api-secret'] = SECRET_KEY;
  const options = {
    method: method,
    headers,
  };
  if (method !== 'DELETE' && Object.keys(body).length > 0) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${BACKEND_URL}${endpoint}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}
// ============================================================
// SESSION MANAGEMENT
// ============================================================
async function startSession() {
  const data = await apiCall('/new', {});
  if (!data.success) {
    if (data.error === 'Too many assignments' || data.status === 429) {
      throw new Error('Too many active sessions. Please wait or end existing sessions.');
    }
    throw new Error(data.error || 'Session creation failed');
  }
  return data.sessionId;
}
async function stopColabSession() {
  if (!sessionId) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (SECRET_KEY) headers['api-secret'] = SECRET_KEY;
    const response = await fetch(`${BACKEND_URL}/session/${sessionId}`, {
      method: 'DELETE',
      headers
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const data = await response.json();
    consoleLog('Session stopped: ' + JSON.stringify(data), 'success');
    return data;
  } catch (e) {
    consoleLog('Session stop error: ' + e.message, 'warn');
    throw e;
  }
}
// ============================================================
// CODE EXECUTION - WITH TIMEOUT
// ============================================================
async function executeCode(code, cellNo, timeout = EXECUTION_TIMEOUT) {
  const data = await apiCall('/exec', {
    sessionId: sessionId,
    code: code,
    cellNo: cellNo,
    timeout: timeout
  });
  return data;
}
async function checkStatus(executionId) {
  const data = await apiCall('/exec-status', {
    sessionId: sessionId,
    executionId: executionId
  });
  return data;
}
// ============================================================
// CELL EXECUTION ENGINE - WITH TIMEOUT
// ============================================================
async function executeCell(cellId, code, cellNo, params = {}, timeout = EXECUTION_TIMEOUT) {
  let finalCode = code;
  if (typeof code === 'function') {
    finalCode = code(params);
  }
  consoleLog(`▶️ Running cell ${cellNo}...`, 'info');
  cellStatus.textContent = `running cell ${cellNo}...`;
  setupStatus.textContent = `⏳ Running cell ${cellNo}...`;
  cellOutput.textContent = '⏳ Starting execution...';
  const result = await executeCode(finalCode, cellNo, timeout);
  if (result.status === 'processing') {
    currentExecutionId = result.executionId;
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 600;
      pollInterval = setInterval(async () => {
        attempts++;
        try {
          const status = await checkStatus(currentExecutionId);
          if (status.output) {
            cellOutput.textContent = status.output;
          }
          if (status.status === 'completed') {
            clearInterval(pollInterval);
            cellOutput.textContent = status.output || '✅ Completed';
            consoleLog(`✅ Cell ${cellNo} completed`, 'success');
            try {
              await apiCall('/exec-ack', { executionId: currentExecutionId });
            } catch (ackError) {
              consoleLog('Ack error (non-critical): ' + ackError.message, 'warn');
            }
            resolve(status.output);
          } else if (status.status === 'failed') {
            clearInterval(pollInterval);
            cellOutput.textContent = `❌ Failed: ${status.error || 'Unknown error'}`;
            consoleLog(`❌ Cell ${cellNo} failed: ${status.error}`, 'error');
            try {
              await apiCall('/exec-ack', { executionId: currentExecutionId });
            } catch (ackError) {}
            reject(new Error(status.error || 'Execution failed'));
          } else if (status.status === 'running') {
            const elapsed = (status.elapsed / 1000).toFixed(1);
            cellStatus.textContent = `running cell ${cellNo} (${elapsed}s)`;
            setupStatus.textContent = `⏳ Running cell ${cellNo} (${elapsed}s)`;
          } else if (status.status === 'not_found') {
            clearInterval(pollInterval);
            reject(new Error('Execution not found on server'));
          }
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            reject(new Error('Polling timeout - execution took too long'));
          }
          if (shouldStop) {
            clearInterval(pollInterval);
            reject(new Error('Stopped by user'));
          }
        } catch (err) {
          clearInterval(pollInterval);
          reject(err);
        }
      }, 5000);
    });
  } else if (result.success) {
    cellOutput.textContent = result.output || '✅ Completed';
    consoleLog(`✅ Cell ${cellNo} completed`, 'success');
    return result.output;
  } else {
    throw new Error(result.error || 'Execution failed');
  }
}
// ============================================================
// MAIN SETUP
// ============================================================
async function startSetup() {
  if (!SECRET_KEY) {
    setupStatus.textContent = '❌ No API key. Use key("your_secret") in console.';
    consoleLog('No API key set', 'error');
    return;
  }
  if (cellRunning) return;
  cellRunning = true;
  shouldStop = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  endSessionBtn.style.display = 'none';
  try {
    setupStatus.textContent = '⏳ Starting session...';
    consoleLog('Creating session...', 'info');
    sessionId = await startSession();
    sessionBadge.textContent = `session: ${sessionId.slice(0, 12)}...`;
    sessionBadge.style.display = 'inline';
    endSessionBtn.style.display = 'inline';
    consoleLog(`Session created: ${sessionId}`, 'success');
    setupStatus.textContent = '✅ Session ready';
    
    // Cell 1 - Install Ollama
    updateStepNum(step1num, 'active');
    await executeCell('cell1', CELL1, 1, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell1 = true;
    updateStepNum(step1num, 'done');
    
    // Cell 2 - Pull Qwen3-Coder-14B (better model)
    updateStepNum(step1num, 'active');
    await executeCell('cell2', CELL2_QWEN3, 2, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell2 = true;
    updateStepNum(step1num, 'done');
    
    // Wait for repo confirmation
    setupStatus.textContent = '⏳ Waiting for repository...';
    cellStatus.textContent = 'waiting for repo...';
    consoleLog('Waiting for repository confirmation...', 'warn');
    await waitForRepoConfirm();
    
    // Cell 3 - Clone repo
    updateStepNum(step3num, 'active');
    const repoCloneCode = CELL3.replace(
      'https://github.com/kushalkumarj2006/repochat',
      repoUrl
    );
    await executeCell('cell3', repoCloneCode, 3, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell3 = true;
    updateStepNum(step3num, 'done');
    
    // Cell 4 - RAG Indexing (Chromadb + Sentence Transformers)
    updateStepNum(step4num, 'active');
    setupStatus.textContent = '⏳ RAG Indexing files...';
    cellStatus.textContent = 'RAG indexing...';
    await executeCell('cell4', CELL4_RAG, 4, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell4 = true;
    updateStepNum(step4num, 'done');
    
    // Done
    setupPanel.classList.add('collapsed');
    setupStatus.textContent = '✅ RAG + Qwen3-Coder-14B ready!';
    cellStatus.textContent = '✅ RAG ready';
    indexStatus.textContent = '✅ RAG indexed';
    fileStats.textContent = '📄 Vector DB ready';
    
    chatEnabled = true;
    questionInput.disabled = false;
    askFastBtn.disabled = false;
    askSimpleBtn.disabled = false;
    chatStatus.innerHTML = '✅ <span class="ok">RAG + Qwen3-Coder ready</span>';
    consoleLog('🎉 RAG setup complete! Chat enabled.', 'success');
  } catch (err) {
    setupStatus.textContent = `❌ ${err.message}`;
    consoleLog(`Error: ${err.message}`, 'error');
    if (err.message.includes('Stopped')) {
      consoleLog('Stopped by user', 'warn');
    }
  } finally {
    cellRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
}
function waitForRepoConfirm() {
  return new Promise((resolve) => {
    if (repoConfirmed) return resolve();
    const checkInterval = setInterval(() => {
      if (repoConfirmed) {
        clearInterval(checkInterval);
        resolve();
      }
      if (shouldStop) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 300);
  });
}
// ============================================================
// REPO CONFIRM
// ============================================================
confirmRepoBtn.addEventListener('click', () => {
  const raw = repoInput.value.trim();
  if (!raw) {
    repoStatus.textContent = '⚠️ Enter a repository';
    return;
  }
  const parsed = parseRepoUrl(raw);
  if (!parsed) {
    repoStatus.textContent = '❌ Invalid format. Use user/repo or URL';
    return;
  }
  repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
  repoDisplay.textContent = `📁 ${parsed.owner}/${parsed.repo}`;
  repoConfirmed = true;
  repoStatus.textContent = '✅ Repository set';
  consoleLog(`Repository set: ${repoUrl}`, 'success');
});
// ============================================================
// STOP / END SESSION
// ============================================================
stopBtn.addEventListener('click', () => {
  shouldStop = true;
  consoleLog('Stopping...', 'warn');
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  stopBtn.disabled = true;
});
endSessionBtn.addEventListener('click', async () => {
  if (!sessionId) return;
  if (!confirm('End this session? All progress will be lost.')) return;
  endSessionBtn.disabled = true;
  endSessionBtn.textContent = '⏳ Ending...';
  chatStatus.innerHTML = '⏳ <span class="wait">Ending session...</span>';
  try {
    await stopColabSession();
    sessionId = null;
    sessionBadge.style.display = 'none';
    endSessionBtn.style.display = 'none';
    setupPanel.classList.remove('collapsed');
    setupStatus.textContent = '✅ Session ended';
    chatEnabled = false;
    questionInput.disabled = true;
    askFastBtn.disabled = true;
    askSimpleBtn.disabled = true;
    chatStatus.innerHTML = '⏳ <span class="wait">Session ended. Start again.</span>';
    consoleLog('Session ended by user', 'warn');
  } catch (error) {
    consoleLog('Session stop had issues: ' + error.message, 'warn');
    sessionId = null;
    sessionBadge.style.display = 'none';
    endSessionBtn.style.display = 'none';
    setupPanel.classList.remove('collapsed');
    setupStatus.textContent = '⚠️ Session ended (with errors)';
    chatEnabled = false;
    questionInput.disabled = true;
    askFastBtn.disabled = true;
    askSimpleBtn.disabled = true;
    chatStatus.innerHTML = '⚠️ <span class="err">Session ended with errors</span>';
  } finally {
    endSessionBtn.disabled = false;
    endSessionBtn.textContent = '✕ End';
  }
});
// ============================================================
// HAMBURGER
// ============================================================
hamburgerBtn.addEventListener('click', () => {
  setupPanel.classList.toggle('collapsed');
});
// ============================================================
// START BUTTON
// ============================================================
startBtn.addEventListener('click', startSetup);
// ============================================================
// CHAT - With RAG and Qwen3-Coder-14B
// ============================================================
async function askQuestion(mode) {
  if (!chatEnabled) {
    chatStatus.innerHTML = '⏳ <span class="wait">Setup not complete</span>';
    return;
  }
  const q = questionInput.value.trim();
  if (!q) {
    chatStatus.innerHTML = '⚠️ <span class="err">Enter a question</span>';
    return;
  }
  
  const empty = chatMessages.querySelector('.empty');
  if (empty) empty.remove();
  
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.innerHTML = `<div class="label">You</div><div class="content">${escapeHtml(q)}</div>`;
  chatMessages.appendChild(userMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  
  const botMsg = document.createElement('div');
  botMsg.className = `msg bot ${mode === 'simple' ? 'simple' : ''}`;
  botMsg.innerHTML = `<div class="label">${mode === 'fast' ? '⚡ RAG Fast' : '💬 RAG Simple'}</div><div class="content"><span class="partial">🧠 RAG Retrieving...</span></div>`;
  chatMessages.appendChild(botMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  
  questionInput.value = '';
  chatStatus.innerHTML = '🧠 <span class="wait">RAG + thinking...</span>';
  askFastBtn.disabled = true;
  askSimpleBtn.disabled = true;
  
  try {
    // RAG + Qwen3-Coder-14B ask code
    const askCode = `
import json
import subprocess
import sys

def clean_ansi(text):
    import re
    ansi_escape = re.compile(r'\\\\x1b\\\\[[0-9;]*[a-zA-Z]')
    text = ansi_escape.sub('', text)
    text = re.sub(r'\\\\x1b[^m]*m', '', text)
    text = '\\n'.join(line.strip() for line in text.split('\\n') if line.strip())
    return text

question = """${q.replace(/"/g, '\\\\"')}"""

# ============================================
# RAG Retrieval
# ============================================
import chromadb
from sentence_transformers import SentenceTransformer

# Load embedder
embedder = SentenceTransformer('BAAI/bge-m3')

# Load ChromaDB
client = chromadb.PersistentClient(path="/content/chroma_repo")
collection = client.get_collection("repo_chunks")

# Dense retrieval
query_embedding = embedder.encode([question], normalize_embeddings=True)
dense_results = collection.query(
    query_embeddings=query_embedding.tolist(),
    n_results=8
)

# Build context with citations
context_parts = []
sources = []
for i, doc in enumerate(dense_results['documents'][0]):
    meta = dense_results['metadatas'][0][i]
    source = meta.get('file', 'unknown')
    context_parts.append(f"[Source: {source}]\\n{doc}")
    sources.append(source)

context = "\\n\\n---\\n\\n".join(context_parts)

# ============================================
# Qwen3-Coder-14B via Ollama
# ============================================
prompt = f"""<system>
You are a codebase expert with RAG retrieval. Answer based ONLY on the provided context.
Always cite the source file at the start of each claim.
If context lacks info, say "I don't have enough information."
</system>

<context>
{context}
</context>

<question>
{question}
</question>

Answer with citations:
"""
print("🧠 RAG + Qwen3-Coder-14B thinking...")
process = subprocess.Popen(
    ["ollama", "run", "qwen3-coder:14b"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True
)
stdout, _ = process.communicate(input=prompt, timeout=600)
clean_output = clean_ansi(stdout)

# Add sources footer
source_list = list(set(sources))
result = clean_output + "\\n\\n---\\n**Sources:** " + ", ".join(source_list)

print(json.dumps({"answer": result}))
`;
    
    const result = await executeCode(askCode, 99, EXECUTION_TIMEOUT);
    let answer = '';
    
    if (result.status === 'processing') {
      const execId = result.executionId;
      let done = false;
      let attempts = 0;
      const maxPollAttempts = 240;
      while (!done && attempts < maxPollAttempts) {
        await sleep(5000);
        attempts++;
        try {
          const status = await checkStatus(execId);
          if (status.partialOutput || status.output) {
            const outputText = status.partialOutput || status.output || '';
            const partialText = outputText.substring(0, 300) + (outputText.length > 300 ? '...' : '');
            botMsg.querySelector('.content').innerHTML = 
              `<span class="partial">${escapeHtml(partialText)}</span><span class="streaming">▌</span>`;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
          if (status.status === 'completed') {
            try {
              const data = JSON.parse(status.output);
              answer = data.answer || status.output;
            } catch (e) {
              answer = status.output;
            }
            done = true;
            try {
              await apiCall('/exec-ack', { executionId: execId });
            } catch (ackError) {}
          } else if (status.status === 'failed') {
            throw new Error(status.error || 'RAG ask failed');
          } else if (status.status === 'not_found') {
            throw new Error('Execution not found on server');
          }
        } catch (e) {
          if (attempts > 10) throw e;
        }
      }
      if (!done) throw new Error('Timeout - question took too long');
    } else if (result.success) {
      try {
        const data = JSON.parse(result.output);
        answer = data.answer || result.output;
      } catch (e) {
        answer = result.output;
      }
    } else {
      throw new Error(result.error || 'Failed');
    }
    
    botMsg.querySelector('.content').innerHTML = escapeHtml(answer);
    chatStatus.innerHTML = '✅ <span class="ok">RAG answered</span>';
  } catch (err) {
    botMsg.querySelector('.content').innerHTML = `❌ ${escapeHtml(err.message)}`;
    chatStatus.innerHTML = `❌ <span class="err">${escapeHtml(err.message)}</span>`;
    consoleLog(`RAG ask error: ${err.message}`, 'error');
  } finally {
    askFastBtn.disabled = false;
    askSimpleBtn.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}
askFastBtn.addEventListener('click', () => askQuestion('fast'));
askSimpleBtn.addEventListener('click', () => askQuestion('simple'));
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askQuestion('fast');
  }
});
// ============================================================
// WAKE UP
// ============================================================
function wakeUp(attempt = 1) {
  fetch('https://tempo-agxk.onrender.com/health')
    .then(res => res.ok ? res.json() : Promise.reject('Not ready'))
    .then(data => {
      console.log('✅ Server ready:', data.status);
      consoleLog('Server is healthy!', 'success');
    })
    .catch(() => {
      consoleLog(`Wake attempt ${attempt}/5 failed...`, 'warn');
      if (attempt < 5) setTimeout(() => wakeUp(attempt + 1), 3000);
      else consoleLog('❌ Server not responding', 'error');
    });
}
wakeUp();
// ============================================================
// CELL DEFINITIONS - RAG + Qwen3-Coder-14B
// ============================================================
const CELL1 = `import subprocess, time
print("🔧 Installing Ollama...")
subprocess.run("sudo apt-get update -qq && sudo apt-get install -y zstd", shell=True)
subprocess.run("curl -fsSL https://ollama.com/install.sh | sh", shell=True)
subprocess.Popen("ollama serve > /tmp/ollama.log 2>&1", shell=True)
time.sleep(5)
print("✅ Ollama installed and running")`;

const CELL2_QWEN3 = `import subprocess
print("📥 Pulling Qwen3-Coder-14B (Apache 2.0, 256K context)...")
process = subprocess.Popen(
    "ollama pull qwen3-coder:14b",
    shell=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1
)
for line in process.stdout:
    print(line, end='')
print("✅ Qwen3-Coder-14B ready")`;

const CELL3 = `import subprocess, os
repo_dir = '/content/repochat'
if os.path.exists(repo_dir):
    subprocess.run(f"rm -rf {repo_dir}", shell=True)
subprocess.run(f"git clone {repo_url} {repo_dir}", shell=True)
print(f"✅ Repo cloned: {repo_url}")`;

const CELL4_RAG = `import subprocess, json, re, hashlib, os
from pathlib import Path

print("📦 Installing RAG dependencies...")
subprocess.run("pip install chromadb sentence-transformers bm25s -q", shell=True)

import chromadb
from sentence_transformers import SentenceTransformer
import bm25s

print("📁 RAG Indexing with ChromaDB + BGE-M3...")

# 1. Initialize embedder (code-aware, 8K context)
embedder = SentenceTransformer('BAAI/bge-m3')

# 2. Initialize ChromaDB
client = chromadb.PersistentClient(path="/content/chroma_repo")
try:
    client.delete_collection("repo_chunks")
except:
    pass
collection = client.create_collection(
    name="repo_chunks",
    metadata={"hnsw:space": "cosine"}
)

# 3. Index the repo
repo_path = Path("/content/repochat")
extensions = ['*.py', '*.js', '*.json', '*.yaml', '*.yml', '*.md', '*.txt', '*.sh', '*.html', '*.css']

def chunk_code(content, file_path, max_chunk_size=1500):
    chunks = []
    lines = content.split('\\n')
    current_chunk = []
    current_size = 0
    start_line = 0
    
    for idx, line in enumerate(lines):
        current_chunk.append(line)
        current_size += len(line)
        if current_size > max_chunk_size or (line.strip().startswith(('def ', 'class ', '@')) and len(current_chunk) > 5):
            if current_chunk:
                chunks.append({
                    'text': '\\n'.join(current_chunk),
                    'start_line': start_line,
                    'end_line': idx
                })
                current_chunk = []
                current_size = 0
                start_line = idx + 1
    if current_chunk:
        chunks.append({
            'text': '\\n'.join(current_chunk),
            'start_line': start_line,
            'end_line': len(lines) - 1
        })
    return chunks

chunks = []
metadatas = []
ids = []

for ext in extensions:
    for file_path in repo_path.rglob(ext):
        try:
            content = file_path.read_text(encoding='utf-8', errors='ignore')
            rel_path = str(file_path.relative_to(repo_path))
            file_chunks = chunk_code(content, rel_path)
            
            for i, chunk_info in enumerate(file_chunks):
                if len(chunk_info['text'].strip()) < 50:
                    continue
                chunks.append(chunk_info['text'])
                metadatas.append({
                    "file": rel_path,
                    "start_line": chunk_info['start_line'],
                    "end_line": chunk_info['end_line'],
                    "chunk_index": i
                })
                ids.append(hashlib.md5(f"{rel_path}_{i}".encode()).hexdigest())
        except Exception as e:
            print(f"⚠️ Error: {file_path} - {e}")

print(f"✅ Generated {len(chunks)} chunks")

# 4. Embed and store
if chunks:
    print("🧠 Computing embeddings...")
    embeddings = embedder.encode(
        chunks,
        show_progress_bar=True,
        normalize_embeddings=True
    )
    
    print("💾 Storing in ChromaDB...")
    collection.add(
        embeddings=embeddings.tolist(),
        documents=chunks,
        metadatas=metadatas,
        ids=ids
    )
    print(f"✅ Stored {len(chunks)} chunks")

print("""
✅ RAG Indexing Complete!
   - Vector DB: /content/chroma_repo
   - Embedder: BAAI/bge-m3 (8K context)
   - Model: Qwen3-Coder-14B (256K context)
   
📝 Usage: ask_fast(question) or ask_simple(question)
""")`;

// ============================================================
// INIT
// ============================================================
consoleLog('🚀 AskRepo with RAG + Qwen3-Coder-14B loaded.', 'info');
consoleLog('📡 Backend: ' + BACKEND_URL, 'info');
consoleLog('📝 Click Start to begin RAG setup', 'info');
consoleLog('🧠 Model: Qwen3-Coder-14B (Apache 2.0)', 'info');
consoleLog('📚 Vector DB: ChromaDB + BGE-M3 embeddings', 'info');
