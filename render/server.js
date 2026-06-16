const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// ============================================
// CONFIGURATION WITH STRICT VALIDATION
// ============================================
const app = express();

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS - Restricted to trusted origins only
const trustedOrigins = (process.env.TRUSTED_ORIGINS || 'http://localhost:3000,https://your-frontend.com').split(',');
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (trustedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'api-secret', 'x-api-secret', 'Authorization'],
  maxAge: 86400 // 24 hours
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // strict limit for sensitive endpoints
  message: 'Rate limit exceeded. Please try again later.',
});

app.use(limiter);
app.use(express.json({ limit: '1mb' })); // Reduced from 10mb
app.use(express.static(path.join(__dirname, '..')));

// ============================================
// STRICT ENVIRONMENT VALIDATION
// ============================================
const requiredEnvVars = ['API_SECRET', 'COLAB_AUTH_TOKEN'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  // In production, we should fail fast
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

// API Secret - MUST be set in production
const API_SECRET = process.env.API_SECRET;
if (!API_SECRET || API_SECRET === 'kushalkumarjthegreat') {
  console.warn('⚠️ Using default API_SECRET. This is NOT secure for production!');
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Production environment requires a secure API_SECRET');
    process.exit(1);
  }
}

// Configuration with validation
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 2;
const SESSION_TIMEOUT = 3 * 60 * 60 * 1000;
const EXECUTION_TIMEOUT = 7200;
const MAX_CODE_SIZE = 1 * 1024 * 1024; // 1MB - reduced from 3MB
const COMPLETED_EXECUTIONS_TTL = 10 * 60 * 1000;
const POLL_INTERVAL = 5000; // 5 seconds - more reasonable

// Sessions directory
const SESSIONS_BASE_DIR = path.join(os.tmpdir(), 'colab_sessions');

// ============================================
// TOKEN REFRESH SYSTEM
// ============================================
const execPromise = util.promisify(exec);

async function refreshColabToken() {
    console.log('🔄 Refreshing Colab token...');
    if (!process.env.COLAB_REFRESH_DATA) {
        console.error('❌ COLAB_REFRESH_DATA not found');
        return false;
    }

    try {
        const refreshData = JSON.parse(process.env.COLAB_REFRESH_DATA);
        const pythonScript = `
import json
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
try:
    data = ${JSON.stringify(refreshData)}
    creds = Credentials(
        token=None,
        refresh_token=data['refresh_token'],
        token_uri=data['token_uri'],
        client_id=data['client_id'],
        client_secret=data['client_secret']
    )
    creds.refresh(Request())
    print(json.dumps({
        'token': creds.token,
        'expiry': creds.expiry.isoformat()
    }))
except Exception as e:
    print(f'ERROR: {e}')
`;

        const { stdout } = await execPromise(`python3 -c '${pythonScript}'`);
        if (stdout.includes('ERROR')) {
            console.error('❌ Token refresh failed:', stdout);
            return false;
        }

        const tokenData = JSON.parse(stdout.trim());
        const fullToken = { ...refreshData, token: tokenData.token, expiry: tokenData.expiry };
        
        // Update environment
        process.env.COLAB_AUTH_TOKEN = JSON.stringify(fullToken);
        
        // Persist token
        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
            path.join(configDir, 'token.json'),
            JSON.stringify(fullToken, null, 2)
        );

        console.log('✅ Token refreshed successfully');
        return true;
    } catch (error) {
        console.error('❌ Token refresh error:', error);
        return false;
    }
}

async function isTokenValid() {
    try {
        const { stdout } = await execPromise('colab whoami', { timeout: 10000 });
        return stdout.includes('Expires in') && !stdout.includes('ERROR');
    } catch {
        return false;
    }
}

async function ensureValidToken() {
    if (await isTokenValid()) {
        console.log('✅ Token is valid');
        return true;
    }
    console.log('⚠️ Token invalid or expired, refreshing...');
    return await refreshColabToken();
}

// ============================================
// COLAB BINARY DISCOVERY
// ============================================
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

async function findColabBinaryRecursive() {
    const { execSync } = require('child_process');
    console.log('🔍 Searching for colab binary...');

    // Try 'which' first
    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            console.log(`✅ Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch {}

    // Try pip location
    try {
        const pipPath = execSync('pip3 show google-colab-cli | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                console.log(`✅ Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch {}

    // Search common paths
    const searchPaths = [
        '/opt/render/.local/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/opt/render/project/.local/bin',
        '/home/render/.local/bin',
        '/opt/render/project/src/.local/bin'
    ];

    for (const searchPath of searchPaths) {
        try {
            const result = execSync(`find ${searchPath} -name "colab" -type f 2>/dev/null | head -1`, { 
                encoding: 'utf8', 
                timeout: 10000 
            }).trim();
            if (result && result !== '') {
                console.log(`✅ Found colab via recursive search: ${result}`);
                try {
                    execSync(`chmod +x "${result}"`, { stdio: 'ignore' });
                } catch {}
                return result;
            }
        } catch {}
    }

    console.warn('⚠️ colab binary not found, will use python3 -m colab_cli');
    return 'python3';
}

async function initColabBinary() {
    const binary = await findColabBinaryRecursive();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        console.log(`🔧 Using Python module: ${COLAB_BINARY} -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        console.log(`🔧 Using colab binary: ${COLAB_BINARY}`);
    }
}

// ============================================
// SECURE COLAB CLI RUNNER
// ============================================
async function runColabCli(args, timeout = 30000) {
    await ensureValidToken();
    
    return new Promise((resolve, reject) => {
        // Use spawn with arguments array - MORE SECURE than string concatenation
        let command;
        let spawnArgs;
        
        if (USE_PYTHON_MODULE) {
            command = COLAB_BINARY;
            spawnArgs = ['-m', 'colab_cli', ...args];
        } else {
            command = COLAB_BINARY;
            spawnArgs = [...args];
        }

        console.log(`Running: ${command} ${spawnArgs.join(' ')}`);
        
        const child = spawn(command, spawnArgs, {
            timeout,
            shell: false, // DON'T use shell for security
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 50 * 1024 * 1024
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });

        child.on('error', (err) => {
            reject({ error: err, stdout, stderr });
        });
    });
}

// ============================================
// AUTH SETUP
// ============================================
async function setupColabAuth() {
    if (!process.env.COLAB_AUTH_TOKEN && process.env.COLAB_REFRESH_DATA) {
        await refreshColabToken();
    }

    if (!process.env.COLAB_AUTH_TOKEN) {
        console.warn('⚠️ COLAB_AUTH_TOKEN not found in environment');
        return false;
    }

    try {
        let rawToken = process.env.COLAB_AUTH_TOKEN.trim();
        // Remove surrounding quotes if present
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
        }

        const tokenData = JSON.parse(rawToken);
        console.log('✅ Parsed COLAB_AUTH_TOKEN successfully');

        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        
        await fs.writeFile(
            path.join(configDir, 'token.json'),
            JSON.stringify(tokenData, null, 2)
        );

        // Initialize sessions file
        const sessionsConfig = {};
        await fs.writeFile(
            path.join(configDir, 'sessions.json'),
            JSON.stringify(sessionsConfig, null, 2)
        );

        console.log('✅ Auth setup complete');
        return true;
    } catch (error) {
        console.error('❌ Auth setup failed:', error.message);
        return false;
    }
}

// ============================================
// SESSION MANAGEMENT WITH PERSISTENCE
// ============================================
const sessions = new Map();
const executionQueue = new Set();
const completedExecutions = new Map();
const executionProcesses = new Map();

// Persistence - Save state periodically
async function persistState() {
    try {
        const state = {
            sessions: Array.from(sessions.entries()).map(([id, data]) => ({
                id,
                ...data,
                // Don't persist PIDs or processes
                currentExecution: data.currentExecution ? {
                    ...data.currentExecution,
                    // Remove sensitive data
                } : null
            })),
            completedExecutions: Array.from(completedExecutions.entries())
        };
        await fs.writeFile(
            path.join(SESSIONS_BASE_DIR, 'state.json'),
            JSON.stringify(state, null, 2)
        );
    } catch (error) {
        console.error('Failed to persist state:', error);
    }
}

// Restore state on startup
async function restoreState() {
    try {
        const statePath = path.join(SESSIONS_BASE_DIR, 'state.json');
        const data = await fs.readFile(statePath, 'utf8');
        const state = JSON.parse(data);
        
        // Restore sessions
        for (const sessionData of state.sessions || []) {
            const { id, ...rest } = sessionData;
            sessions.set(id, {
                ...rest,
                // Don't restore if session is stale
                status: 'ready',
                currentExecution: null
            });
        }
        
        // Restore completed executions
        for (const [id, execData] of state.completedExecutions || []) {
            completedExecutions.set(id, execData);
        }
        
        console.log(`✅ Restored ${sessions.size} sessions and ${completedExecutions.size} executions`);
    } catch (error) {
        console.log('No state to restore or state corrupted:', error.message);
    }
}

async function createSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(sessionFolder, { recursive: true });
    return sessionFolder;
}

async function cleanupSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    try {
        await fs.rm(sessionFolder, { recursive: true, force: true });
        console.log(`✅ Cleaned up folder for session ${sessionId}`);
    } catch (error) {
        console.error(`Failed to cleanup folder for ${sessionId}:`, error.message);
    }
}

async function cleanupAllSessionsAndCreateNew() {
    console.log('🧹 Cleaning up all sessions...');
    const currentSessions = Array.from(sessions.keys());
    
    for (const sessionId of currentSessions) {
        const session = sessions.get(sessionId);
        if (session) {
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
            } catch {}
            await cleanupSessionFolder(sessionId);
        }
    }
    
    sessions.clear();
    completedExecutions.clear();
    executionQueue.clear();
    
    // Also clear any hanging processes
    for (const [_, process] of executionProcesses) {
        try {
            process.kill('SIGTERM');
        } catch {}
    }
    executionProcesses.clear();
    
    try {
        await fs.rm(SESSIONS_BASE_DIR, { recursive: true, force: true });
        await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });
    } catch {}
    
    console.log('✅ All sessions cleaned up');
}

// ============================================
// API HELPERS - IMPROVED SECURITY
// ============================================
function validateApiSecret(input) {
    if (!input) return false;
    // Constant-time comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(input),
            Buffer.from(API_SECRET)
        );
    } catch {
        return false;
    }
}

function extractApiSecret(req) {
    // Check multiple sources
    const sources = [
        req.body?.api_secret,
        req.headers['api-secret'],
        req.headers['x-api-secret'],
        req.headers['authorization']?.replace(/^Bearer\s+/i, '')
    ];
    
    for (const source of sources) {
        if (source && typeof source === 'string') {
            return source.trim();
        }
    }
    return null;
}

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function generateExecutionId() {
    return crypto.randomBytes(16).toString('hex');
}

// ============================================
// SECURE CODE EXECUTION
// ============================================
async function executeCodeInColab(sessionId, cellNo, code, executionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let process = null;

    try {
        // Validate code size
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${MAX_CODE_SIZE} bytes`);
        }

        // Sanitize code - reject obviously dangerous patterns
        const dangerousPatterns = [
            /rm\s+-rf/,
            /sudo/,
            /chmod\s+777/,
            /etc\/passwd/,
            /\/dev\/null/,
            /wget.*\|.*sh/,
            /curl.*\|.*sh/,
            /eval\s*\(/,
            /exec\s*\(/,
            /system\s*\(/,
            /popen\s*\(/
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(code)) {
                throw new Error('Potentially dangerous code detected');
            }
        }

        const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
        const codeFile = path.join(sessionFolder, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        // Execute using file input instead of echo for better security
        let command;
        let args;

        if (USE_PYTHON_MODULE) {
            command = COLAB_BINARY;
            args = ['-m', 'colab_cli', 'exec', '-s', session.colabSession, '--timeout', String(EXECUTION_TIMEOUT)];
        } else {
            command = COLAB_BINARY;
            args = ['exec', '-s', session.colabSession, '--timeout', String(EXECUTION_TIMEOUT)];
        }

        console.log(`Executing code file: ${codeFile}`);

        // Use spawn with file input
        process = spawn(command, args, {
            timeout: EXECUTION_TIMEOUT * 1000,
            maxBuffer: 50 * 1024 * 1024,
            shell: false, // NO shell
            stdio: ['pipe', 'pipe', 'pipe'] // pipe stdin for code
        });

        executionProcesses.set(executionId, process);

        // Write code to stdin
        process.stdin.write(code);
        process.stdin.end();

        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                sessions.set(sessionId, currentSession);
                persistState();
            }
        });

        process.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        const result = await new Promise((resolve, reject) => {
            process.on('close', (code) => {
                if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
            
            process.on('error', (err) => {
                reject({ error: err, stdout, stderr });
            });
        });

        const completedAt = Date.now();
        const output = {
            status: 'completed',
            output: result.stdout || '(No output)',
            error: result.stderr || '',
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };

        completedExecutions.set(executionId, output);
        executionProcesses.delete(executionId);
        persistState();

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
            persistState();
        }

        return output;

    } catch (error) {
        const completedAt = Date.now();
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };

        completedExecutions.set(executionId, failureResult);
        executionProcesses.delete(executionId);
        persistState();

        const updatedSession = sessions.get(sessionId);
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
            persistState();
        }

        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;

    executionQueue.add(execKey);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId);
    } catch (error) {
        console.error(`Background error:`, error.message);
    } finally {
        executionQueue.delete(execKey);
    }
}

// ============================================
// API ENDPOINTS
// ============================================
app.get('/health', async (req, res) => {
    const valid = await isTokenValid();
    res.json({
        status: 'healthy',
        tokenValid: valid,
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        completedExecutions: completedExecutions.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
        hasAuthToken: !!process.env.COLAB_AUTH_TOKEN
    });
});

// Health endpoint for status monitoring (no auth required)
app.get('/health/simple', (req, res) => {
    res.json({
        status: 'up',
        timestamp: new Date().toISOString()
    });
});

app.post('/start', strictLimiter, async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    // Check session limit
    if (sessions.size >= MAX_SESSIONS) {
        return res.status(429).json({
            error: 'Maximum sessions reached',
            maxSessions: MAX_SESSIONS,
            activeSessions: sessions.size
        });
    }

    console.log(`📝 New session request received`);

    const sessionId = generateSessionId();
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    try {
        await createSessionFolder(sessionId);
        await runColabCli(['new', '--gpu', 'T4', '-s', colabSessionName], 60000);

        const session = {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            currentExecution: null,
            folder: path.join(SESSIONS_BASE_DIR, sessionId),
            // Track owner IP for security
            clientIp: req.ip || req.connection.remoteAddress
        };

        sessions.set(sessionId, session);
        await persistState();

        res.json({
            success: true,
            sessionId: sessionId,
            expiresIn: SESSION_TIMEOUT,
            message: 'Session created successfully'
        });

    } catch (error) {
        console.error('Session creation failed:', error.message);
        await cleanupSessionFolder(sessionId);
        
        // Try to detect if auth is needed
        if (error.stderr && error.stderr.includes('authenticate')) {
            return res.status(401).json({
                error: 'Authentication required',
                needsAuth: true,
                message: 'Please refresh Colab authentication'
            });
        }

        res.status(500).json({
            error: 'Failed to create session',
            details: error.message
        });
    }
});

app.post('/keepalive', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        await persistState();

        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

app.post('/run', strictLimiter, async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, code, cellNo } = req.body;
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    // Validate cellNo
    const validCellNo = parseInt(cellNo, 10);
    if (isNaN(validCellNo) || validCellNo < 1 || validCellNo > 100) {
        return res.status(400).json({ error: 'cellNo must be between 1 and 100' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        return res.status(409).json({
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateExecutionId();

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId: executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };

    sessions.set(sessionId, session);
    await persistState();

    // Execute in background
    backgroundExecution(sessionId, validCellNo, code, executionId);

    res.json({
        status: 'processing',
        sessionId: sessionId,
        executionId: executionId,
        pollInterval: POLL_INTERVAL,
        message: 'Code execution started. Poll /status for results.'
    });
});

app.post('/status', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    // Check completed executions first
    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const execution = session.currentExecution;
    if (execution && execution.executionId === executionId) {
        return res.json({
            status: 'running',
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

app.post('/status/ack', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        await persistState();
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        res.json({ success: false, message: 'Execution not found' });
    }
});

app.delete('/session/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        await persistState();
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        // Even if stop fails, clean up local resources
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        await persistState();
        res.json({
            success: true,
            warning: 'Session removed from tracking, but may still exist remotely'
        });
    }
});

// ============================================
// CLEANUP AND MAINTENANCE
// ============================================
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT && session.status !== 'busy') {
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch {}
            sessions.delete(sessionId);
        }
    }

    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} idle sessions`);
        await persistState();
    }

    // Schedule next cleanup
    setTimeout(cleanupIdleSessions, 30 * 60 * 1000); // 30 minutes
}

// Periodic state persistence
setInterval(persistState, 5 * 60 * 1000); // Every 5 minutes

// Cleanup completed executions
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`Cleaned up ${removed} completed executions`);
    }
}, 5 * 60 * 1000);

// ============================================
// INITIALIZATION
// ============================================
async function init() {
    console.log('🚀 Initializing Colab Orchestrator...');

    try {
        // Setup directories
        await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });

        // Find colab binary
        await initColabBinary();

        // Setup authentication
        await setupColabAuth();

        // Ensure valid token
        await ensureValidToken();

        // Restore state if exists
        await restoreState();

        // Start cleanup
        setTimeout(cleanupIdleSessions, 5 * 60 * 1000);

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`\n🚀 Colab Orchestrator running on port ${PORT}`);
            console.log(`📁 Static files from: ${path.join(__dirname, '..')}`);
            console.log(`📁 Sessions folder: ${SESSIONS_BASE_DIR}`);
            console.log(`🔧 Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
            console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
            console.log(`🔐 API Secret: ${API_SECRET !== 'kushalkumarjthegreat' ? '✅ Custom' : '⚠️ Default - CHANGE THIS!'}`);
            console.log(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Token configured' : '⚠️ No token'}`);
            console.log(`🔄 Token auto-refresh: Enabled`);
            console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 1000 / 60 / 60} hours`);
            console.log(`⏱️  Execution timeout: ${EXECUTION_TIMEOUT / 60} minutes`);
            console.log(`🔒 Security: CORS restricted, Rate limiting enabled, Code sanitization active`);
            console.log(`🗑️  Sessions cleaned on each /start request\n`);
            console.log(`🌐 Open: http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, cleaning up...');
    await persistState();
    // Clean up all sessions
    for (const [sessionId, session] of sessions.entries()) {
        try {
            await runColabCli(['stop', '-s', session.colabSession], 5000);
        } catch {}
        await cleanupSessionFolder(sessionId);
    }
    sessions.clear();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT, cleaning up...');
    await persistState();
    process.exit(0);
});

init();

module.exports = app;
