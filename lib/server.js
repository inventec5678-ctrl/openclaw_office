const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// 載入配置
const configPath = path.join(__dirname, '..', 'config', 'config.yaml');
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

const GATEWAY_URL = config.openclaw.gateway;
const API_BASE = `${GATEWAY_URL}${config.openclaw.apiBase}`;

// 中介軟體
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// SSE 客戶端管理
const sseClients = new Set();

function broadcastUpdate(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    client.write(message);
  });
}

// SSE 端點
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 發送初始連線訊息
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);

  // 心跳
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, config.sse.heartbeatInterval);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// 取得 agents
async function fetchAgents() {
  try {
    const response = await fetch(`${API_BASE}/agents`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.agents || data || [];
  } catch (error) {
    console.error('取得 agents 失敗:', error.message);
    return [];
  }
}

// 取得 jobs
async function fetchJobs() {
  try {
    const response = await fetch(`${API_BASE}/jobs`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.jobs || data || [];
  } catch (error) {
    console.error('取得 jobs 失敗:', error.message);
    return [];
  }
}

// API: 取得所有 agents
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await fetchAgents();
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 取得所有 jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await fetchJobs();
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 取得狀態摘要
app.get('/api/status', async (req, res) => {
  try {
    const [agents, jobs] = await Promise.all([fetchAgents(), fetchJobs()]);
    res.json({
      agents,
      jobs,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 定期廣播更新
setInterval(async () => {
  try {
    const [agents, jobs] = await Promise.all([fetchAgents(), fetchJobs()]);
    broadcastUpdate({ type: 'update', agents, jobs });
  } catch (error) {
    console.error('廣播更新失敗:', error.message);
  }
}, config.openclaw.pollInterval);

// 啟動伺服器
app.listen(PORT, config.server.host, () => {
  console.log(`🚀 OpenClaw Office 啟動於 http://localhost:${PORT}`);
  console.log(`📡 Gateway: ${GATEWAY_URL}`);
});
