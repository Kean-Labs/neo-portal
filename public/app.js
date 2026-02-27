const POLL_MS = 2500;
const HISTORY_HOURS = 24;

function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n || 0));
}

function fmtTs(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString();
}

function getToken() {
  return localStorage.getItem('portal_api_token') || '';
}

function setToken(token) {
  localStorage.setItem('portal_api_token', token.trim());
}

function withToken(path) {
  const token = getToken();
  if (!token) return path;
  const suffix = path.includes('?') ? '&' : '?';
  return `${path}${suffix}token=${encodeURIComponent(token)}`;
}

function renderCards(snapshot) {
  const cards = [
    ['Agents', snapshot.counts.agents],
    ['Jobs', snapshot.counts.jobs],
    ['Sessions', snapshot.counts.sessions],
    ['Input tokens', fmt(snapshot.totals.inputTokens)],
    ['Output tokens', fmt(snapshot.totals.outputTokens)],
    ['Cached tokens', fmt(snapshot.totals.cachedTokens)]
  ];

  const html = cards
    .map(([label, value]) => `<article class="card"><h3>${label}</h3><p>${value}</p></article>`)
    .join('');

  document.getElementById('summaryCards').innerHTML = html;
}

function renderModelUsage(snapshot) {
  const rows = Object.entries(snapshot.byModel || {})
    .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
    .map(([model, usage]) => `
      <tr>
        <td>${model}</td>
        <td>${fmt(usage.inputTokens)}</td>
        <td>${fmt(usage.outputTokens)}</td>
        <td>${fmt(usage.cachedTokens)}</td>
      </tr>
    `)
    .join('');

  document.getElementById('modelUsage').innerHTML = `
    <table>
      <thead>
        <tr><th>Model</th><th>Input</th><th>Output</th><th>Cached</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="4">No model data</td></tr>'}</tbody>
    </table>
  `;
}

function renderHistory(rows) {
  const grouped = {};
  for (const row of rows || []) {
    const hour = row.hour;
    grouped[hour] = grouped[hour] || [];
    grouped[hour].push(row);
  }

  const hours = Object.keys(grouped).sort((a, b) => (a < b ? 1 : -1)).slice(0, 12);
  const html = hours
    .map((hour) => {
      const items = grouped[hour]
        .sort((a, b) => (Number(b.inputTokens) + Number(b.outputTokens)) - (Number(a.inputTokens) + Number(a.outputTokens)))
        .slice(0, 4)
        .map((item) => {
          const total = Number(item.inputTokens) + Number(item.outputTokens);
          return `<div class="rowBar"><span>${item.model}</span><strong>${fmt(total)}</strong></div>`;
        })
        .join('');
      return `<div class="historyHour"><h3>${fmtTs(hour)}</h3>${items || '<p>No data</p>'}</div>`;
    })
    .join('');

  document.getElementById('historyUsage').innerHTML = html || '<p>No history data</p>';
}

function renderAgents(snapshot) {
  const rows = (snapshot.agents || [])
    .sort((a, b) => (a.agentId > b.agentId ? 1 : -1))
    .map((agent) => `
      <tr>
        <td>${agent.agentId}</td>
        <td>${agent.model || '-'}</td>
        <td><span class="pill ${agent.status}">${agent.status || '-'}</span></td>
        <td>${agent.jobId || '-'}</td>
        <td>${agent.sessionId || '-'}</td>
        <td>${fmt(agent.usageTotal.inputTokens)}</td>
        <td>${fmt(agent.usageTotal.outputTokens)}</td>
        <td>${fmt(agent.usageTotal.cachedTokens)}</td>
      </tr>
    `)
    .join('');

  document.getElementById('agentsTable').innerHTML = rows || '<tr><td colspan="8">No agents yet</td></tr>';
}

function renderJobs(snapshot) {
  const rows = (snapshot.jobs || [])
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((job) => `
      <tr>
        <td>${job.jobId}</td>
        <td><span class="pill ${job.status}">${job.status}</span></td>
        <td>${(job.agentIds || []).join(', ') || '-'}</td>
        <td>${(job.sessionIds || []).join(', ') || '-'}</td>
        <td>${fmtTs(job.updatedAt)}</td>
      </tr>
    `)
    .join('');

  document.getElementById('jobsTable').innerHTML = rows || '<tr><td colspan="5">No jobs yet</td></tr>';
}

function renderSessions(snapshot) {
  const rows = (snapshot.sessions || [])
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((session) => `
      <tr>
        <td>${session.sessionId}</td>
        <td><span class="pill ${session.status}">${session.status}</span></td>
        <td>${(session.agentIds || []).join(', ') || '-'}</td>
        <td>${fmt(session.usageTotal.inputTokens)}</td>
        <td>${fmt(session.usageTotal.outputTokens)}</td>
        <td>${fmt(session.usageTotal.cachedTokens)}</td>
        <td>${fmtTs(session.updatedAt)}</td>
      </tr>
    `)
    .join('');

  document.getElementById('sessionsTable').innerHTML = rows || '<tr><td colspan="7">No sessions yet</td></tr>';
}

function renderEvents(snapshot) {
  const text = (snapshot.recentEvents || [])
    .slice(0, 12)
    .map((event) => `${event.ts} | ${event.type} | ${event.agentId || '-'} | ${event.model || '-'} | in:${event.usage.inputTokens} out:${event.usage.outputTokens}`)
    .join('\n');
  document.getElementById('eventsList').textContent = text || 'No events yet';
}

async function refresh() {
  try {
    const [snapshotRes, historyRes] = await Promise.all([
      fetch(withToken('/api/snapshot'), { cache: 'no-store' }),
      fetch(withToken(`/api/history?hours=${HISTORY_HOURS}`), { cache: 'no-store' })
    ]);

    if (!snapshotRes.ok) {
      throw new Error(`snapshot ${snapshotRes.status}`);
    }

    const snapshot = await snapshotRes.json();
    document.getElementById('lastUpdated').textContent = `Last updated: ${fmtTs(snapshot.lastUpdated)}`;

    renderCards(snapshot);
    renderModelUsage(snapshot);
    renderAgents(snapshot);
    renderJobs(snapshot);
    renderSessions(snapshot);
    renderEvents(snapshot);

    if (historyRes.ok) {
      const history = await historyRes.json();
      renderHistory(history.rows || []);
    } else {
      document.getElementById('historyUsage').innerHTML = '<p>History unavailable</p>';
    }
  } catch (error) {
    document.getElementById('lastUpdated').textContent = `Failed to load snapshot: ${error.message}`;
  }
}

function setupTokenInput() {
  const input = document.getElementById('apiToken');
  const button = document.getElementById('saveToken');
  input.value = getToken();

  button.addEventListener('click', () => {
    setToken(input.value);
    refresh();
  });
}

setupTokenInput();
refresh();
setInterval(refresh, POLL_MS);
