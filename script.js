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
    // Handle rate limiting / too many assignments
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
    // Use DELETE method with the session ID in the URL path
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
    timeout: timeout  // Send timeout in seconds
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
      const maxAttempts = 600; // 600 * 5s = 3000s = 50 minutes
      pollInterval = setInterval(async () => {
        attempts++;
        try {
          const status = await checkStatus(currentExecutionId);
          // CLEAR AND UPDATE output in UI
          if (status.output) {
            cellOutput.textContent = status.output;
          }
          if (status.status === 'completed') {
            clearInterval(pollInterval);
            cellOutput.textContent = status.output || '✅ Completed';
            consoleLog(`✅ Cell ${cellNo} completed`, 'success');
            // Acknowledge the execution to free memory
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
            // Acknowledge the failed execution
            try {
              await apiCall('/exec-ack', { executionId: currentExecutionId });
            } catch (ackError) {}
            reject(new Error(status.error || 'Execution failed'));
          } else if (status.status === 'running') {
            const elapsed = (status.elapsed / 1000).toFixed(1);
            cellStatus.textContent = `running cell ${cellNo} (${elapsed}s)`;
            setupStatus.textContent = `⏳ Running cell ${cellNo} (${elapsed}s)`;
          } else if (status.status === 'not_found') {
            // If not found, it might have been acknowledged or expired
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
      }, 5000); // Poll every 5 seconds
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
    // Start session
    setupStatus.textContent = '⏳ Starting session...';
    consoleLog('Creating session...', 'info');
    sessionId = await startSession();
    sessionBadge.textContent = `session: ${sessionId.slice(0, 12)}...`;
    sessionBadge.style.display = 'inline';
    endSessionBtn.style.display = 'inline';
    consoleLog(`Session created: ${sessionId}`, 'success');
    setupStatus.textContent = '✅ Session ready';
    // Cell 1 - Install Ollama (20 min timeout)
    updateStepNum(step1num, 'active');
    await executeCell('cell1', CELL1, 1, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell1 = true;
    updateStepNum(step1num, 'done');
    // Cell 2 - Pull model (20 min timeout)
    // FIXED: was incorrectly referencing step1num, now using step3num for repo step
    // Cell 2 doesn't have a step number display in the UI, so we skip updating it
    await executeCell('cell2', CELL2, 2, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell2 = true;
    // Wait for repo confirmation
    setupStatus.textContent = '⏳ Waiting for repository...';
    cellStatus.textContent = 'waiting for repo...';
    consoleLog('Waiting for repository confirmation...', 'warn');
    await waitForRepoConfirm();
    // Cell 3 - Clone repo (20 min timeout)
    updateStepNum(step3num, 'active');
    const repoCloneCode = CELL3.replace(
      'https://github.com/kushalkumarj2006/colab-orchestrator',
      repoUrl
    );
    await executeCell('cell3', repoCloneCode, 3, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell3 = true;
    updateStepNum(step3num, 'done');
    // Cell 4 - Index files (20 min timeout)
    updateStepNum(step4num, 'active');
    setupStatus.textContent = '⏳ Indexing files...';
    cellStatus.textContent = 'indexing...';
    await executeCell('cell4', CELL4, 4, {}, EXECUTION_TIMEOUT);
    cellsCompleted.cell4 = true;
    updateStepNum(step4num, 'done');
    // Done - collapse setup panel
    setupPanel.classList.add('collapsed');
    setupStatus.textContent = '✅ All cells completed!';
    cellStatus.textContent = '✅ done';
    indexStatus.textContent = '✅ Ready';
    fileStats.textContent = '📄 Indexed';
    // Enable chat
    chatEnabled = true;
    questionInput.disabled = false;
    askFastBtn.disabled = false;
    askSimpleBtn.disabled = false;
    chatStatus.innerHTML = '✅ <span class="ok">Ready to answer questions</span>';
    consoleLog('🎉 Setup complete! Chat enabled.', 'success');
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
  // Show loading state
  endSessionBtn.disabled = true;
  endSessionBtn.textContent = '⏳ Ending...';
  chatStatus.innerHTML = '⏳ <span class="wait">Ending session...</span>';
  try {
    // Stop the session
    await stopColabSession();
    // Clear session state
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
    // Even if the remote stop fails, clean up local state
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
// CHAT - With streaming support and timeout
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
  // Remove empty state
  const empty = chatMessages.querySelector('.empty');
  if (empty) empty.remove();
  // Add user message
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.innerHTML = `<div class="label">You</div><div class="content">${escapeHtml(q)}</div>`;
  chatMessages.appendChild(userMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // Add bot message placeholder
  const botMsg = document.createElement('div');
  botMsg.className = `msg bot ${mode === 'simple' ? 'simple' : ''}`;
  botMsg.innerHTML = `<div class="label">${mode === 'fast' ? '⚡ Fast' : '💬 Simple'}</div><div class="content"><span class="partial">🧠 Thinking...</span></div>`;
  chatMessages.appendChild(botMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  questionInput.value = '';
  chatStatus.innerHTML = '🧠 <span class="wait">Thinking...</span>';
  askFastBtn.disabled = true;
  askSimpleBtn.disabled = true;
  try {
    // Build ask code with 20 minute timeout
    const askCode = `
import json
import subprocess
def clean_ansi(text):
    import re
    ansi_escape = re.compile(r'\\\\x1b\\\\[[0-9;]*[a-zA-Z]')
    text = ansi_escape.sub('', text)
    text = re.sub(r'\\\\x1b[^m]*m', '', text)
    text = '\\n'.join(line.strip() for line in text.split('\\n') if line.strip())
    return text
question = """${q.replace(/"/g, '\\\\"')}"""
# Use the appropriate ask function
if '${mode}' == 'fast':
    result = ask_fast(question)
else:
    result = ask_simple(question)
# Clean the output
clean_result = clean_ansi(result)
# Output as JSON for parsing
print(json.dumps({"answer": clean_result}))
`;
    // Send with 20 minute timeout (1200 seconds)
    const result = await executeCode(askCode, 99, EXECUTION_TIMEOUT);
    let answer = '';
    if (result.status === 'processing') {
      const execId = result.executionId;
      let done = false;
      let attempts = 0;
      const maxPollAttempts = 240; // 240 * 5s = 1200s = 20 minutes
      while (!done && attempts < maxPollAttempts) {
        await sleep(5000); // Poll every 5 seconds
        attempts++;
        try {
          const status = await checkStatus(execId);
          // UPDATE UI with partial output
          if (status.partialOutput || status.output) {
            const outputText = status.partialOutput || status.output || '';
            // Show partial output with streaming indicator
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
            // Acknowledge the execution
            try {
              await apiCall('/exec-ack', { executionId: execId });
            } catch (ackError) {}
          } else if (status.status === 'failed') {
            throw new Error(status.error || 'Ask failed');
          } else if (status.status === 'not_found') {
            throw new Error('Execution not found on server');
          }
        } catch (e) {
          // Continue polling for transient errors
          if (attempts > 10) throw e;
        }
      }
      if (!done) throw new Error('Timeout - question took too long to answer');
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
    // Final answer - clear and update
    botMsg.querySelector('.content').innerHTML = escapeHtml(answer);
    chatStatus.innerHTML = '✅ <span class="ok">Answered</span>';
  } catch (err) {
    botMsg.querySelector('.content').innerHTML = `❌ ${escapeHtml(err.message)}`;
    chatStatus.innerHTML = `❌ <span class="err">${escapeHtml(err.message)}</span>`;
    consoleLog(`Ask error: ${err.message}`, 'error');
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
// WAKE UP - UPDATED for new backend URL
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
// CELL DEFINITIONS (unchanged)
// ============================================================
const CELL1 = `import subprocess, time
print("🔧 Installing Ollama...")
subprocess.run("sudo apt-get update -qq && sudo apt-get install -y zstd", shell=True)
subprocess.run("curl -fsSL https://ollama.com/install.sh | sh", shell=True)
subprocess.Popen("ollama serve > /tmp/ollama.log 2>&1", shell=True)
time.sleep(5)
print("✅ Ollama installed and running")`;
const CELL2 = `import subprocess
print("📥 Pulling qwen2.5-coder:7b...")
process = subprocess.Popen(
    "ollama pull qwen2.5-coder:7b",
    shell=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1
)
for line in process.stdout:
    print(line, end='')
print("✅ Model ready")`;
const CELL3 = `import subprocess, os
if os.path.exists('/content/colab-orchestrator'):
    subprocess.run("rm -rf /content/colab-orchestrator", shell=True)
subprocess.run("git clone https://github.com/kushalkumarj2006/colab-orchestrator /content/colab-orchestrator", shell=True)
print("✅ Repo cloned")`;
const CELL4 = `import subprocess, json, re, hashlib
from pathlib import Path
# ============================================
# 1. Index files once
# ============================================
print("📁 Indexing files...")
repo_path = Path("/content/colab-orchestrator")
file_contents = {}
extensions = ['*.py', '*.js', '*.json', '*.yaml', '*.yml', '*.md', '*.txt', '*.sh', '*.html', '*.css']
for ext in extensions:
    for file_path in repo_path.rglob(ext):
        try:
            content = file_path.read_text(encoding='utf-8', errors='ignore')
            rel_path = str(file_path.relative_to(repo_path))
            file_contents[rel_path] = content.split('\\n')
        except:
            pass
print(f"✅ Indexed {len(file_contents)} files")
# ============================================
# 2. Cache for questions
# ============================================
cache = {}
def get_cached_answer(question, context_hash):
    key = f"{question[:50]}_{context_hash[:20]}"
    return cache.get(key)
def set_cached_answer(question, context_hash, answer):
    key = f"{question[:50]}_{context_hash[:20]}"
    cache[key] = answer
# ============================================
# 3. Optimized keyword expansion
# ============================================
def expand_keywords(question):
    mappings = {
        'login': ['login', 'sign in', 'auth', 'authenticate', 'credentials', 'log in'],
        'signup': ['signup', 'register', 'create account', 'registration', 'sign up'],
        'password': ['password', 'pass', 'pwd'],
        'auth': ['auth', 'authentication', 'authorization', 'jwt', 'session'],
        'api': ['api', 'endpoint', 'route', 'express'],
        'database': ['database', 'db', 'mongodb', 'mongoose', 'schema'],
        'user': ['user', 'users', 'profile', 'account'],
        'server': ['server', 'app', 'express', 'node', 'backend'],
    }
    words = question.lower().split()
    expanded = set()
    for w in words:
        expanded.add(w)
        for key, values in mappings.items():
            if w in values or w == key:
                expanded.update(values)
                expanded.add(key)
    return list(expanded)
# ============================================
# 4. Fast relevance scoring
# ============================================
def score_files_fast(question, keywords):
    scored = []
    for file_path, lines in file_contents.items():
        score = 0
        path_lower = file_path.lower()
        for kw in keywords[:15]:
            if kw in path_lower:
                score += 3
        for line in lines[:50]:
            line_lower = line.lower()
            for kw in keywords[:15]:
                if kw in line_lower:
                    score += 1
        if score > 0:
            scored.append((score, file_path))
    scored.sort(reverse=True, key=lambda x: x[0])
    return scored[:4]
# ============================================
# 5. Clean ANSI escape sequences
# ============================================
def clean_ansi(text):
    ansi_escape = re.compile(r'\\\\x1b\\\\[[0-9;]*[a-zA-Z]')
    text = ansi_escape.sub('', text)
    text = re.sub(r'\\\\x1b[^m]*m', '', text)
    text = '\\n'.join(line.strip() for line in text.split('\\n') if line.strip())
    return text
# ============================================
# 6. Main ask function
# ============================================
def ask_fast(question):
    print(f"\\n{'='*80}")
    print(f"🤔 {question}")
    print(f"{'='*80}")
    keywords = expand_keywords(question)
    scored_files = score_files_fast(question, keywords)
    if not scored_files:
        print("❌ No relevant files found.")
        return "No relevant files found in the codebase."
    print(f"📁 Found: {[f[1] for f in scored_files[:3]]}")
    context = ""
    for score, file_path in scored_files[:3]:
        lines = file_contents[file_path]
        context += f"\\n📁 {file_path}\\n"
        matches = []
        for i, line in enumerate(lines):
            line_lower = line.lower()
            for kw in keywords[:10]:
                if kw in line_lower:
                    start = max(0, i-5)
                    end = min(len(lines), i+6)
                    matches.append((i, lines[start:end]))
                    break
            if len(matches) >= 10:
                break
        if matches:
            for i, block in matches[:8]:
                context += f"  L{i+1}: {''.join(block)}\\n"
        else:
            context += '\\n'.join(lines[:20]) + "\\n"
    if len(context) > 4000:
        context = context[:4000] + "\\n... (truncated)"
    prompt = f"""Codebase context:
{context}
Question: {question}
Answer briefly and clearly, referencing file names if relevant."""
    print("🧠 Thinking...")
    process = subprocess.Popen(
        ["ollama", "run", "qwen2.5-coder:7b"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True
    )
    stdout, _ = process.communicate(input=prompt, timeout=1200)
    clean_output = clean_ansi(stdout)
    print(clean_output)
    print(f"\\n✅ Done")
    return clean_output
def ask_simple(question):
    print(f"\\n🤔 {question}\\n")
    process = subprocess.Popen(
        ["ollama", "run", "qwen2.5-coder:7b"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True
    )
    stdout, _ = process.communicate(input=question, timeout=1200)
    clean_output = clean_ansi(stdout)
    print(clean_output)
    print("✅ Done")
    return clean_output
print("\\n✅ Ready!")
print("\\n📝 Usage:")`;
// ============================================================
// INIT
// ============================================================
consoleLog('🚀 AskRepo loaded. Use key("your_secret") to set API key.', 'info');
consoleLog('📡 Backend: ' + BACKEND_URL, 'info');
consoleLog('📝 Click Start to begin setup', 'info');
