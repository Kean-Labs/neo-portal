const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 4040);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.OPENCLAW_METRICS_FILE || path.join(__dirname, 'examples', 'sample-metrics.json');
const API_TOKEN = process.env.PORTAL_API_TOKEN || '';
const DB_FILE = process.env.OPENCLAW_DB_FILE || path.join(__dirname, 'data', 'openclaw-metrics.db');
const MAX_EVENTS = 500;

const STATE = {
  lastUpdated: null,
  agents: {},
  jobs: {},
  sessions: {},
  events: []
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, payload, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: Number(usage.inputTokens || 0),
    outputTokens: Number(usage.outputTokens || 0),
    cachedTokens: Number(usage.cachedTokens || 0)
  };
}

function mergeUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens
  };
}

function nowIso() {
  return new Date().toISOString();
}

function isAuthorized(req) {
  if (!API_TOKEN) {
    return true;
  }

  const auth = req.headers.authorization || '';
  const headerToken = req.headers['x-portal-token'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

  let queryToken = '';
  try {
    const u = new URL(req.url, 'http://localhost');
    queryToken = u.searchParams.get('token') || '';
  } catch (_error) {
    queryToken = '';
  }

  return bearer === API_TOKEN || headerToken === API_TOKEN || queryToken === API_TOKEN;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) {
    return true;
  }

  sendJson(res, 401, {
    ok: false,
    error: 'Unauthorized. Send Authorization: Bearer <token> or ?token=...'
  });
  return false;
}

function upsertAgent(event) {
  const id = event.agentId;
  if (!id) {
    return;
  }

  const usage = normalizeUsage(event.usage);
  const existing = STATE.agents[id] || {
    agentId: id,
    model: event.model || 'unknown',
    host: event.host || 'local',
    status: event.status || 'idle',
    jobId: event.jobId || null,
    sessionId: event.sessionId || null,
    updatedAt: nowIso(),
    usageTotal: normalizeUsage(),
    usageByModel: {}
  };

  existing.model = event.model || existing.model;
  existing.host = event.host || existing.host;
  existing.status = event.status || existing.status;
  existing.jobId = event.jobId || existing.jobId;
  existing.sessionId = event.sessionId || existing.sessionId;
  existing.updatedAt = event.ts || nowIso();
  existing.usageTotal = mergeUsage(existing.usageTotal, usage);

  const modelKey = existing.model || 'unknown';
  existing.usageByModel[modelKey] = mergeUsage(
    existing.usageByModel[modelKey] || normalizeUsage(),
    usage
  );

  STATE.agents[id] = existing;
}

function upsertJob(event) {
  if (!event.jobId) {
    return;
  }

  const existing = STATE.jobs[event.jobId] || {
    jobId: event.jobId,
    status: event.jobStatus || 'queued',
    startedAt: event.ts || nowIso(),
    updatedAt: event.ts || nowIso(),
    agentIds: new Set(),
    sessionIds: new Set()
  };

  existing.status = event.jobStatus || event.status || existing.status;
  existing.updatedAt = event.ts || nowIso();
  if (event.agentId) existing.agentIds.add(event.agentId);
  if (event.sessionId) existing.sessionIds.add(event.sessionId);

  STATE.jobs[event.jobId] = existing;
}

function upsertSession(event) {
  if (!event.sessionId) {
    return;
  }

  const usage = normalizeUsage(event.usage);
  const existing = STATE.sessions[event.sessionId] || {
    sessionId: event.sessionId,
    status: event.sessionStatus || 'active',
    createdAt: event.ts || nowIso(),
    updatedAt: event.ts || nowIso(),
    usageTotal: normalizeUsage(),
    agentIds: new Set()
  };

  existing.status = event.sessionStatus || existing.status;
  existing.updatedAt = event.ts || nowIso();
  existing.usageTotal = mergeUsage(existing.usageTotal, usage);
  if (event.agentId) existing.agentIds.add(event.agentId);

  STATE.sessions[event.sessionId] = existing;
}

function canonicalEvent(rawEvent) {
  return {
    ts: rawEvent.ts || nowIso(),
    type: rawEvent.type || 'heartbeat',
    agentId: rawEvent.agentId || null,
    model: rawEvent.model || null,
    host: rawEvent.host || null,
    status: rawEvent.status || null,
    jobId: rawEvent.jobId || null,
    jobStatus: rawEvent.jobStatus || null,
    sessionId: rawEvent.sessionId || null,
    sessionStatus: rawEvent.sessionStatus || null,
    usage: normalizeUsage(rawEvent.usage)
  };
}

function ingestEvent(rawEvent, options = {}) {
  const { persist = true } = options;
  const event = canonicalEvent(rawEvent);

  upsertAgent(event);
  upsertJob(event);
  upsertSession(event);

  STATE.events.unshift(event);
  if (STATE.events.length > MAX_EVENTS) {
    STATE.events = STATE.events.slice(0, MAX_EVENTS);
  }

  STATE.lastUpdated = nowIso();

  if (persist) {
    insertEvent(event);
  }
}

function asListWithSets(items) {
  return Object.values(items).map((item) => ({
    ...item,
    agentIds: item.agentIds ? Array.from(item.agentIds) : undefined,
    sessionIds: item.sessionIds ? Array.from(item.sessionIds) : undefined
  }));
}

function getSnapshot() {
  const agents = Object.values(STATE.agents);
  const jobs = asListWithSets(STATE.jobs);
  const sessions = asListWithSets(STATE.sessions);

  const totals = agents.reduce((acc, agent) => {
    acc.inputTokens += agent.usageTotal.inputTokens;
    acc.outputTokens += agent.usageTotal.outputTokens;
    acc.cachedTokens += agent.usageTotal.cachedTokens;
    return acc;
  }, normalizeUsage());

  const byModel = {};
  for (const agent of agents) {
    for (const [model, usage] of Object.entries(agent.usageByModel || {})) {
      byModel[model] = mergeUsage(byModel[model] || normalizeUsage(), usage);
    }
  }

  return {
    lastUpdated: STATE.lastUpdated,
    totals,
    counts: {
      agents: agents.length,
      jobs: jobs.length,
      sessions: sessions.length
    },
    byModel,
    agents,
    jobs,
    sessions,
    recentEvents: STATE.events.slice(0, 50)
  };
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT,
    agent_id TEXT,
    model TEXT,
    host TEXT,
    status TEXT,
    job_id TEXT,
    job_status TEXT,
    session_id TEXT,
    session_status TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events (
    ts, type, agent_id, model, host, status,
    job_id, job_status, session_id, session_status,
    input_tokens, output_tokens, cached_tokens, payload_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const historyStmt = db.prepare(`
  SELECT
    strftime('%Y-%m-%dT%H:00:00Z', ts) AS hour,
    COALESCE(model, 'unknown') AS model,
    SUM(input_tokens) AS inputTokens,
    SUM(output_tokens) AS outputTokens,
    SUM(cached_tokens) AS cachedTokens
  FROM events
  WHERE datetime(ts) >= datetime('now', ?)
  GROUP BY hour, model
  ORDER BY hour DESC, (SUM(input_tokens) + SUM(output_tokens)) DESC
`);

const loadRecentStmt = db.prepare(`
  SELECT payload_json
  FROM events
  ORDER BY datetime(ts) DESC
  LIMIT ?
`);

function insertEvent(event) {
  insertEventStmt.run(
    event.ts,
    event.type,
    event.agentId,
    event.model,
    event.host,
    event.status,
    event.jobId,
    event.jobStatus,
    event.sessionId,
    event.sessionStatus,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cachedTokens,
    JSON.stringify(event)
  );
}

function getHistory(hoursBack) {
  const interval = `-${Number(hoursBack)} hours`;
  return historyStmt.all(interval);
}

function loadFromDb(limit = 5000) {
  const rows = loadRecentStmt.all(limit);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    try {
      const parsed = JSON.parse(row.payload_json);
      ingestEvent(parsed, { persist: false });
    } catch (_error) {
      // Skip malformed rows.
    }
  }
  if (rows.length > 0) {
    console.log(`[openclaw-portal] restored ${rows.length} events from ${DB_FILE}`);
  }
}

function loadSeedData() {
  if (!fs.existsSync(DATA_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    if (Array.isArray(events)) {
      for (const event of events) ingestEvent(event);
      console.log(`[openclaw-portal] loaded ${events.length} seed events from ${DATA_FILE}`);
    }
  } catch (error) {
    console.error(`[openclaw-portal] failed to load metrics file ${DATA_FILE}:`, error.message);
  }
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(urlPath).replace(/^\.+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';

    sendText(res, 200, content, contentType);
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request too large'));
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function parseHoursFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const value = Number(url.searchParams.get('hours') || 24);
    if (!Number.isFinite(value)) return 24;
    return Math.max(1, Math.min(168, Math.round(value)));
  } catch (_error) {
    return 24;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/health')) {
    sendJson(res, 200, { ok: true, now: nowIso() });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/snapshot')) {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, getSnapshot());
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/history')) {
    if (!requireAuth(req, res)) return;
    const hours = parseHoursFromUrl(req.url);
    sendJson(res, 200, { hours, rows: getHistory(hours) });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/events')) {
    if (!requireAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const events = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload.events) ? payload.events : [payload]);

      let ingested = 0;
      for (const event of events) {
        if (event && typeof event === 'object') {
          ingestEvent(event);
          ingested += 1;
        }
      }

      sendJson(res, 200, { ok: true, ingested, snapshot: getSnapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  serveStatic(req, res);
});

loadFromDb();
if (Object.keys(STATE.agents).length === 0) {
  loadSeedData();
}

server.listen(PORT, () => {
  console.log(`[openclaw-portal] running on http://localhost:${PORT}`);
  console.log(`[openclaw-portal] sqlite store at ${DB_FILE}`);
  if (API_TOKEN) {
    console.log('[openclaw-portal] API token enabled (use Authorization: Bearer <token>)');
  }
});
