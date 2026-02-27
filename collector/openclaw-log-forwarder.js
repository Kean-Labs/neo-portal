const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const readline = require('readline');

const LOG_FILE = process.env.OPENCLAW_LOG_FILE || path.join(process.cwd(), 'openclaw.log');
const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:4040/api/events';
const API_TOKEN = process.env.PORTAL_API_TOKEN || '';
const POLL_MS = Number(process.env.OPENCLAW_LOG_POLL_MS || 1000);

let position = 0;

function parseLine(line) {
  const text = line.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (_error) {
    // fall through to loose parser
  }

  const event = {};
  const pairs = text.match(/([a-zA-Z0-9_]+)=([^\s]+)/g) || [];
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    event[key] = value;
  }

  if (!event.agentId && !event.jobId && !event.sessionId) {
    return null;
  }

  return {
    ts: event.ts,
    type: event.type || 'heartbeat',
    agentId: event.agentId,
    model: event.model,
    host: event.host,
    status: event.status,
    jobId: event.jobId,
    jobStatus: event.jobStatus,
    sessionId: event.sessionId,
    sessionStatus: event.sessionStatus,
    usage: {
      inputTokens: Number(event.inputTokens || 0),
      outputTokens: Number(event.outputTokens || 0),
      cachedTokens: Number(event.cachedTokens || 0)
    }
  };
}

function postEvents(events) {
  return new Promise((resolve, reject) => {
    if (!events.length) {
      resolve();
      return;
    }

    const payload = JSON.stringify({ events });
    const target = new URL(PORTAL_URL);
    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    if (API_TOKEN) {
      options.headers.Authorization = `Bearer ${API_TOKEN}`;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`portal responded ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function shipNewLines() {
  if (!fs.existsSync(LOG_FILE)) {
    return;
  }

  const stat = fs.statSync(LOG_FILE);
  if (stat.size < position) {
    position = 0;
  }

  if (stat.size === position) {
    return;
  }

  const stream = fs.createReadStream(LOG_FILE, { start: position, end: stat.size - 1, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const events = [];
  for await (const line of rl) {
    const event = parseLine(line);
    if (event) {
      events.push(event);
    }
  }

  position = stat.size;

  if (events.length > 0) {
    await postEvents(events);
    console.log(`[collector] shipped ${events.length} event(s)`);
  }
}

async function tick() {
  try {
    await shipNewLines();
  } catch (error) {
    console.error(`[collector] ${error.message}`);
  }
}

console.log(`[collector] watching ${LOG_FILE}`);
setInterval(tick, POLL_MS);
tick();
