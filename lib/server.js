const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const fetch = require('node-fetch');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// 載入配置
const configPath = path.join(__dirname, '..', 'config', 'config.yaml');
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

const GATEWAY_URL = config.openclaw.gateway;
const API_BASE = `${GATEWAY_URL}${config.openclaw.apiBase}`;
const GATEWAY_WS = GATEWAY_URL.replace(/^http/, 'ws');

// 取得 gateway token
function getGatewayToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || '';
}

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

// 取得 sessions (從 sessions.json 檔案)
async function fetchSessions() {
  try {
    const sessionsPath = path.join(process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw'), 'agents', 'main', 'sessions', 'sessions.json');
    
    if (!fs.existsSync(sessionsPath)) {
      console.log('Sessions 檔案不存在:', sessionsPath);
      return [];
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    
    // 轉換為陣列並取得 recent sessions
    const sessions = Object.values(sessionsData).map((session, index) => {
      // 找出 key
      const key = Object.keys(sessionsData)[index];
      return {
        key: key,
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        age: session.updatedAt ? Date.now() - session.updatedAt : null,
        inputTokens: session.inputTokens || session.promptTokens,
        outputTokens: session.outputTokens || session.completionTokens,
        totalTokens: session.totalTokens,
        percentUsed: session.percentUsed,
        model: session.model,
        contextTokens: session.contextTokens,
        kind: session.chatType || 'direct',
        systemSent: session.systemSent,
        abortedLastRun: session.abortedLastRun
      };
    });
    
    // 按 updatedAt 排序（新的在前）
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    
    return sessions.slice(0, 20); // 只回傳最新的 20 個
  } catch (error) {
    console.error('取得 sessions 失敗:', error.message);
    return [];
  }
}

// 取得 agents (從 heartbeat 設定)
async function fetchAgents() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw', 'workspace');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    const agentsPath = path.join(workspacePath, 'memory', 'agents');
    
    // 讀取 memory/agents/ 目錄下的 agent 檔案
    const agentMemories = new Map();
    if (fs.existsSync(agentsPath)) {
      const agentFiles = fs.readdirSync(agentsPath).filter(f => f.endsWith('.md'));
      agentFiles.forEach(file => {
        const content = fs.readFileSync(path.join(agentsPath, file), 'utf8');
        // 解析 markdown 取得 name 和 role
        const nameMatch = content.match(/- \*\*Name\*\*:\s*(.+)/);
        const roleMatch = content.match(/- \*\*Role\*\*:\s*(.+)/);
        const statusMatch = content.match(/- \*\*Status\*\*:\s*(.+)/);
        const taskMatch = content.match(/- \*\*Current Task\*\*:\s*(.+)/);
        
        const name = nameMatch ? nameMatch[1].trim() : file.replace('.md', '');
        agentMemories.set(name.toLowerCase(), {
          name: name,
          role: roleMatch ? roleMatch[1].trim() : 'Agent',
          status: statusMatch ? statusMatch[1].trim() : 'active',
          currentTask: taskMatch ? taskMatch[1].trim() : '',
          memoryFile: file,
          memoryContent: content
        });
      });
    }
    
    if (!fs.existsSync(sessionsPath)) {
      // 如果沒有 sessions，仍回傳 memory 中的 agents
      return Array.from(agentMemories.values());
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    
    // 從 sessions 取得 unique agents
    const agentsMap = new Map();
    Object.keys(sessionsData).forEach(key => {
      const agentId = key.split(':')[1] || 'main';
      if (!agentsMap.has(agentId)) {
        // 嘗試從 memory 取得詳細資訊
        const memInfo = agentMemories.get(agentId.toLowerCase());
        agentsMap.set(agentId, {
          id: agentId,
          name: memInfo?.name || agentId,
          status: memInfo?.status || 'online',
          role: memInfo?.role || 'Agent',
          current_task: memInfo?.currentTask || 'Active',
          memoryFile: memInfo?.memoryFile || null,
          hasMemory: !!memInfo
        });
      }
    });
    
    // 加入 memory 中有但 sessions 中沒有的 agents
    agentMemories.forEach((memInfo, key) => {
      const existing = Array.from(agentsMap.values()).find(a => a.name.toLowerCase() === key);
      if (!existing) {
        agentsMap.set(memInfo.name, {
          id: memInfo.name.toLowerCase().replace(/\s+/g, '_'),
          name: memInfo.name,
          status: memInfo.status,
          role: memInfo.role,
          current_task: memInfo.currentTask,
          memoryFile: memInfo.memoryFile,
          hasMemory: true
        });
      }
    });
    
    return Array.from(agentsMap.values());
  } catch (error) {
    console.error('取得 agents 失敗:', error.message);
    return [];
  }
}

// 取得 jobs (從 cron 目錄)
async function fetchJobs() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const cronPath = path.join(workspacePath, 'agents', 'main', 'cron');
    const statePath = path.join(workspacePath, 'agents', 'main', 'cron-state.json');
    
    // 讀取 cron 狀態
    let cronState = {};
    if (fs.existsSync(statePath)) {
      try {
        cronState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (e) {
        cronState = {};
      }
    }
    
    if (!fs.existsSync(cronPath)) {
      return [];
    }
    
    const files = fs.readdirSync(cronPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    const jobs = [];
    
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(cronPath, file), 'utf8');
        const job = yaml.parse(content);
        const jobId = file.replace(/\.(yaml|yml)$/, '');
        
        // 取得狀態
        const jobState = cronState[jobId] || {};
        const status = jobState.status || (job.enabled !== false ? 'pending' : 'completed');
        const lastRun = jobState.lastRun ? new Date(jobState.lastRun).toISOString() : null;
        const nextRun = jobState.nextRun ? new Date(jobState.nextRun).toISOString() : null;
        const lastError = jobState.lastError || null;
        
        // 取得排程描述
        let scheduleDesc = '';
        if (job.schedule) {
          const cronExpr = job.schedule.toString();
          // 簡單的 cron 描述
          if (cronExpr.includes('@hourly')) scheduleDesc = '每小時';
          else if (cronExpr.includes('@daily')) scheduleDesc = '每天';
          else if (cronExpr.includes('@weekly')) scheduleDesc = '每週';
          else if (cronExpr.includes('@monthly')) scheduleDesc = '每月';
          else scheduleDesc = cronExpr;
        }
        
        jobs.push({
          id: jobId,
          name: job.name || jobId,
          status: status,
          description: job.description || job.schedule?.toString() || 'Cron job',
          schedule: scheduleDesc,
          currentAction: jobState.currentAction || (status === 'running' ? '執行中...' : '等待中'),
          created_at: job.created || Date.now(),
          updated_at: lastRun || jobState.updated || Date.now(),
          nextRun: nextRun,
          lastError: lastError,
          enabled: job.enabled !== false
        });
      } catch (e) {
        // 忽略解析錯誤
      }
    }
    
    // 排序：running > pending > completed > failed
    const statusOrder = { running: 0, pending: 1, queued: 2, completed: 3, failed: 4 };
    jobs.sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));
    
    return jobs;
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

// API: 取得單一 agent 記憶檔案
app.get('/api/agents/:agentId/memory', async (req, res) => {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw', 'workspace');
    const { agentId } = req.params;
    
    // 嘗試從 memory/agents/ 目錄找檔案
    const agentsPath = path.join(workspacePath, 'memory', 'agents');
    
    if (!fs.existsSync(agentsPath)) {
      return res.status(404).json({ error: '找不到 Agent 記憶目錄' });
    }
    
    // 嘗試直接讀取同名檔案
    const mdFile = path.join(agentsPath, `${agentId}.md`);
    if (fs.existsSync(mdFile)) {
      const content = fs.readFileSync(mdFile, 'utf8');
      return res.json({ content, filename: `${agentId}.md` });
    }
    
    // 搜尋符合的檔案
    const files = fs.readdirSync(agentsPath).filter(f => f.endsWith('.md'));
    const found = files.find(f => f.replace('.md', '').toLowerCase() === agentId.toLowerCase());
    
    if (found) {
      const content = fs.readFileSync(path.join(agentsPath, found), 'utf8');
      return res.json({ content, filename: found });
    }
    
    res.status(404).json({ error: '找不到 Agent 記憶檔案' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 更新 Agent 記憶檔案
app.put('/api/agents/:agentId/memory', async (req, res) => {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw', 'workspace');
    const { agentId } = req.params;
    const { content } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: '缺少內容' });
    }
    
    const agentsPath = path.join(workspacePath, 'memory', 'agents');
    
    // 確保目錄存在
    if (!fs.existsSync(agentsPath)) {
      fs.mkdirSync(agentsPath, { recursive: true });
    }
    
    const mdFile = path.join(agentsPath, `${agentId}.md`);
    fs.writeFileSync(mdFile, content, 'utf8');
    
    res.json({ success: true, filename: `${agentId}.md` });
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

// API: 取得所有 sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await fetchSessions();
    res.json({ sessions });
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

// ============ 成本分析 API ============
const TOKEN_PRICING = {
  'minimax-portal/MiniMax-M2.5': { input: 0.0, output: 0.0 },  // 免費
  'minimax-portal/MiniMax-M2': { input: 0.0, output: 0.0 },
  'minimax-portal/MiniMax-Text-01': { input: 0.0, output: 0.0 },
  'anthropic/claude-3.5-sonnet': { input: 3.0, output: 15.0 },  // 每百萬 tokens
  'anthropic/claude-3-opus': { input: 15.0, output: 75.0 },
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-4-turbo': { input: 10.0, output: 30.0 },
  'default': { input: 1.0, output: 5.0 }  // 預設價格
};

function getTokenPrice(model) {
  return TOKEN_PRICING[model] || TOKEN_PRICING['default'];
}

function calculateCost(tokens, pricing) {
  return (tokens / 1000000) * pricing;
}

async function fetchCostAnalysis() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let sessionCount = 0;
    let modelUsage = {};
    let dailyUsage = {};
    let recentCost = 0;
    
    if (fs.existsSync(sessionsPath)) {
      const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      
      Object.values(sessionsData).forEach(session => {
        const inputTokens = session.inputTokens || session.promptTokens || 0;
        const outputTokens = session.outputTokens || session.completionTokens || 0;
        const model = session.model || 'default';
        
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        sessionCount++;
        
        // Model usage 統計
        if (!modelUsage[model]) {
          modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0, cost: 0 };
        }
        modelUsage[model].inputTokens += inputTokens;
        modelUsage[model].outputTokens += outputTokens;
        modelUsage[model].sessions += 1;
        
        // 計算費用
        const pricing = getTokenPrice(model);
        const cost = calculateCost(inputTokens, pricing.input) + calculateCost(outputTokens, pricing.output);
        totalCost += cost;
        modelUsage[model].cost += cost;
        
        // 計算今日費用 (24小時內)
        if (session.updatedAt && (Date.now() - session.updatedAt) < 86400000) {
          recentCost += cost;
        }
        
        // 每日統計
        if (session.updatedAt) {
          const date = new Date(session.updatedAt).toISOString().split('T')[0];
          if (!dailyUsage[date]) {
            dailyUsage[date] = { inputTokens: 0, outputTokens: 0, cost: 0, sessions: 0 };
          }
          dailyUsage[date].inputTokens += inputTokens;
          dailyUsage[date].outputTokens += outputTokens;
          dailyUsage[date].cost += cost;
          dailyUsage[date].sessions += 1;
        }
      });
    }
    
    // 轉換 modelUsage 為陣列
    const modelBreakdown = Object.entries(modelUsage).map(([model, data]) => ({
      model,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      totalTokens: data.inputTokens + data.outputTokens,
      sessions: data.sessions,
      cost: data.cost
    })).sort((a, b) => b.totalTokens - a.totalTokens);
    
    // 轉換 dailyUsage 為陣列並排序
    const dailyBreakdown = Object.entries(dailyUsage)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7); // 最近7天
    
    return {
      summary: {
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCost,
        sessionCount,
        recentCost
      },
      modelBreakdown,
      dailyBreakdown
    };
  } catch (error) {
    console.error('成本分析失敗:', error.message);
    return { summary: {}, modelBreakdown: [], dailyBreakdown: [] };
  }
}

app.get('/api/cost', async (req, res) => {
  try {
    const costData = await fetchCostAnalysis();
    res.json(costData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Memory Browser API ============
async function fetchMemoryFiles() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const memoryPath = path.join(workspacePath, 'memory');
    const memories = [];
    
    if (!fs.existsSync(memoryPath)) {
      return memories;
    }
    
    // 遞迴取得記憶檔案
    function scanDirectory(dirPath, prefix = '') {
      const items = fs.readdirSync(dirPath);
      
      items.forEach(item => {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          scanDirectory(fullPath, prefix + item + '/');
        } else if (item.endsWith('.md')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const preview = lines.slice(0, 5).join(' ').substring(0, 150);
          
          memories.push({
            path: prefix + item,
            name: item,
            size: stat.size,
            modified: stat.mtime,
            preview: preview + (content.length > 150 ? '...' : ''),
            type: 'markdown'
          });
        }
      });
    }
    
    scanDirectory(memoryPath);
    
    // 按修改時間排序
    memories.sort((a, b) => b.modified - a.modified);
    
    return memories.slice(0, 50); // 最多50個檔案
  } catch (error) {
    console.error('取得記憶檔案失敗:', error.message);
    return [];
  }
}

app.get('/api/memory', async (req, res) => {
  try {
    const memories = await fetchMemoryFiles();
    res.json({ memories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/memory/:filename', async (req, res) => {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const memoryPath = path.join(workspacePath, 'memory', req.params.filename);
    
    if (!fs.existsSync(memoryPath)) {
      return res.status(404).json({ error: '檔案不存在' });
    }
    
    const content = fs.readFileSync(memoryPath, 'utf8');
    res.json({ content, filename: req.params.filename });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Cerebro Topics API ============
async function fetchCerebroTopics() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    const topics = {};
    
    if (!fs.existsSync(sessionsPath)) {
      return [];
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    
    Object.values(sessionsData).forEach(session => {
      // 從 key 解析 channel 和 type
      if (session.sessionId) {
        const parts = session.sessionId.split(':');
        const channel = parts[2] || 'unknown';
        const type = parts[3] || 'direct';
        
        const topicKey = `${channel}:${type}`;
        
        if (!topics[topicKey]) {
          topics[topicKey] = {
            channel,
            type,
            sessionCount: 0,
            totalTokens: 0,
            lastActivity: 0
          };
        }
        
        topics[topicKey].sessionCount++;
        const tokens = (session.inputTokens || 0) + (session.outputTokens || 0);
        topics[topicKey].totalTokens += tokens;
        
        if (session.updatedAt && session.updatedAt > topics[topicKey].lastActivity) {
          topics[topicKey].lastActivity = session.updatedAt;
        }
      }
    });
    
    return Object.values(topics).sort((a, b) => b.sessionCount - a.sessionCount);
  } catch (error) {
    console.error('取得 Cerebro Topics 失敗:', error.message);
    return [];
  }
}

app.get('/api/topics', async (req, res) => {
  try {
    const topics = await fetchCerebroTopics();
    res.json({ topics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ System Vitals API ============
function getSystemVitals() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  // CPU 使用率計算
  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach(cpu => {
    for (let type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = 100 - (100 * totalIdle / totalTick);
  
  // 磁碟空間 (macOS/Linux)
  let diskInfo = { total: 0, used: 0, free: 0 };
  try {
    // 嘗試讀取磁碟資訊
    if (process.platform === 'darwin') {
      const { execSync } = require('child_process');
      const dfOutput = execSync('df -k /').toString();
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const free = parseInt(parts[3]) * 1024;
        diskInfo = { total, used, free, percent: Math.round((used / total) * 100) };
      }
    } else if (process.platform === 'linux') {
      const statfs = require('fs');
      // Linux 可以用 df
      const { execSync } = require('child_process');
      const dfOutput = execSync('df -k /').toString();
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const free = parseInt(parts[3]) * 1024;
        diskInfo = { total, used, free, percent: Math.round((used / total) * 100) };
      }
    }
  } catch (e) {
    // 忽略錯誤，使用預設值
  }
  
  // 負載平均 (Unix)
  let loadAvg = os.loadavg();
  
  // 系統運行時間
  const uptime = os.uptime();
  
  // 記憶體使用率
  const memPercent = Math.round((usedMem / totalMem) * 100);
  
  return {
    cpu: {
      usage: Math.round(cpuUsage * 10) / 10,
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0,
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100)
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: memPercent
    },
    disk: diskInfo,
    system: {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: uptime,
      type: os.type()
    }
  };
}

app.get('/api/vitals', (req, res) => {
  try {
    const vitals = getSystemVitals();
    res.json(vitals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Operators API ============
async function fetchOperators() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    const operators = {};
    
    if (!fs.existsSync(sessionsPath)) {
      return [];
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    
    Object.values(sessionsData).forEach(session => {
      // 從 key 解析操作者
      // 格式: agent:main:telegram:direct:6330601313
      if (session.sessionId) {
        const parts = session.sessionId.split(':');
        if (parts.length >= 5) {
          const channel = parts[2];
          const type = parts[3];
          const operatorId = parts[4] || 'unknown';
          
          const operatorKey = `${channel}:${operatorId}`;
          
          if (!operators[operatorKey]) {
            operators[operatorKey] = {
              id: operatorId,
              channel: channel,
              type: type,
              displayName: operatorId.length > 8 ? operatorId.substring(0, 8) + '...' : operatorId,
              sessionCount: 0,
              totalTokens: 0,
              lastActivity: 0,
              sessions: []
            };
          }
          
          operators[operatorKey].sessionCount++;
          const tokens = (session.inputTokens || 0) + (session.outputTokens || 0);
          operators[operatorKey].totalTokens += tokens;
          
          if (session.updatedAt && session.updatedAt > operators[operatorKey].lastActivity) {
            operators[operatorKey].lastActivity = session.updatedAt;
          }
          
          // 記錄 session 引用用於後續詳細資訊
          operators[operatorKey].sessions.push({
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            tokens: tokens
          });
        }
      }
    });
    
    // 轉換為陣列並排序
    return Object.values(operators)
      .map(op => ({
        ...op,
        sessions: op.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      }))
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  } catch (error) {
    console.error('取得 Operators 失敗:', error.message);
    return [];
  }
}

app.get('/api/operators', async (req, res) => {
  try {
    const operators = await fetchOperators();
    res.json({ operators });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Savings Projections API ============
// 估算每小時人工成本 (假設為軟體工程師一小時 $50)
const HOURLY_HUMAN_COST = 50;
// AI 每小時處理的 tasks 數量 (估算)
const AI_TASKS_PER_HOUR = 10;
// 每個 task 的平均 tokens 消耗
const AVG_TOKENS_PER_TASK = 5000;

async function fetchSavingsProjections() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    
    let totalTokens = 0;
    let sessionCount = 0;
    let recentTokens = 0;
    let recentSessions = 0;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    if (fs.existsSync(sessionsPath)) {
      const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      
      Object.values(sessionsData).forEach(session => {
        const tokens = (session.inputTokens || 0) + (session.outputTokens || 0);
        totalTokens += tokens;
        sessionCount++;
        
        // 計算最近 24 小時
        if (session.updatedAt && (now - session.updatedAt) < dayMs) {
          recentTokens += tokens;
          recentSessions++;
        }
      });
    }
    
    // 計算節省金額 (相較於人工)
    // 假設: 每 5000 tokens 等於 1 task (估算)
    const tasksByAI = Math.floor(totalTokens / AVG_TOKENS_PER_TASK);
    const humanCostForTasks = tasksByAI * HOURLY_HUMAN_COST; // 這是假設每 task 要一小時
    
    // 更合理的計算: 基於 session 數量
    // 每個 session 假設節省 30 分鐘人工 ($25)
    const savingsPerSession = 25;
    const totalSavings = sessionCount * savingsPerSession;
    
    // 最近 24 小時節省
    const recentSavings = recentSessions * savingsPerSession;
    
    // 每月預估 (基於最近 24 小時推估)
    const monthlyEstimate = recentSavings * 30;
    const yearlyEstimate = recentSavings * 365;
    
    // 每小時處理量估算
    const hoursActive = 24; // 假設 24 小時運行
    const hourlyTasks = recentSessions / hoursActive;
    const hourlyValue = hourlyTasks * savingsPerSession;
    
    return {
      summary: {
        totalSessions: sessionCount,
        totalTokens: totalTokens,
        totalSavings: Math.round(totalSavings),
        recentSessions: recentSessions,
        recentSavings: Math.round(recentSavings),
        monthlyEstimate: Math.round(monthlyEstimate),
        yearlyEstimate: Math.round(yearlyEstimate)
      },
      calculations: {
        savingsPerSession: savingsPerSession,
        avgTokensPerSession: sessionCount > 0 ? Math.round(totalTokens / sessionCount) : 0,
        hourlyTasksProcessed: Math.round(hourlyTasks * 10) / 10,
        hourlyValueGenerated: Math.round(hourlyValue)
      },
      breakdown: [
        { period: 'total', sessions: sessionCount, savings: Math.round(totalSavings) },
        { period: '24h', sessions: recentSessions, savings: Math.round(recentSavings) },
        { period: '30d', sessions: Math.round(recentSessions * 30), savings: Math.round(monthlyEstimate) },
        { period: '365d', sessions: Math.round(recentSessions * 365), savings: Math.round(yearlyEstimate) }
      ]
    };
  } catch (error) {
    console.error('取得 Savings Projections 失敗:', error.message);
    return { summary: {}, calculations: {}, breakdown: [] };
  }
}

app.get('/api/savings', async (req, res) => {
  try {
    const savings = await fetchSavingsProjections();
    res.json(savings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Session Detail API ============
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    const { sessionId } = req.params;
    
    // URL 解碼
    const decodedId = decodeURIComponent(sessionId);
    
    if (!fs.existsSync(sessionsPath)) {
      return res.status(404).json({ error: 'Sessions 檔案不存在' });
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    
    // 嘗試直接匹配或模糊匹配
    let session = null;
    let sessionKey = null;
    
    for (const [key, value] of Object.entries(sessionsData)) {
      if (key === decodedId || key === sessionId || value.sessionId === decodedId || value.sessionId === sessionId) {
        session = value;
        sessionKey = key;
        break;
      }
    }
    
    if (!session) {
      return res.status(404).json({ error: '找不到指定的 session' });
    }
    
    // 解析 session key 取得詳細資訊
    const parts = sessionKey.split(':');
    const details = {
      key: sessionKey,
      agent: parts[1] || 'main',
      channel: parts[2] || 'unknown',
      type: parts[3] || 'direct',
      operator: parts[4] || 'unknown',
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt || session.startedAt,
      inputTokens: session.inputTokens || session.promptTokens || 0,
      outputTokens: session.outputTokens || session.completionTokens || 0,
      totalTokens: session.totalTokens || ((session.inputTokens || 0) + (session.outputTokens || 0)),
      percentUsed: session.percentUsed || 0,
      model: session.model || 'unknown',
      contextTokens: session.contextTokens || 0,
      // 工具使用記錄 (如果有的話)
      toolsUsed: session.toolsUsed || [],
      // 訊息摘要 (如果有的話)
      messageCount: session.messageCount || 0,
      firstMessage: session.firstMessage || null,
      lastMessage: session.lastMessage || null,
      // 系統訊息
      systemSent: session.systemSent || false,
      abortedLastRun: session.abortedLastRun || false
    };
    
    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Privacy Controls ============
// 隱私控制設定儲存
const privacySettingsPath = path.join(__dirname, '..', 'config', 'privacy.json');

// 載入隱私設定
function loadPrivacySettings() {
  try {
    if (fs.existsSync(privacySettingsPath)) {
      return JSON.parse(fs.readFileSync(privacySettingsPath, 'utf8'));
    }
  } catch (e) {
    // 忽略
  }
  return {
    hiddenTopics: [],
    hiddenSessions: [],
    hiddenAgents: [],
    hideCostData: false,
    enabled: false
  };
}

// 儲存隱私設定
function savePrivacySettings(settings) {
  try {
    const dir = path.dirname(privacySettingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(privacySettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('儲存隱私設定失敗:', e.message);
    return false;
  }
}

app.get('/api/privacy', (req, res) => {
  try {
    const settings = loadPrivacySettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/privacy', (req, res) => {
  try {
    const currentSettings = loadPrivacySettings();
    const newSettings = { ...currentSettings, ...req.body };
    
    if (savePrivacySettings(newSettings)) {
      res.json({ success: true, settings: newSettings });
    } else {
      res.status(500).json({ error: '儲存失敗' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Unified State API ============
app.get('/api/state', async (req, res) => {
  try {
    const privacySettings = loadPrivacySettings();
    
    const [agents, jobs, sessions, costData, topics, operators, savings, vitals] = await Promise.all([
      fetchAgents(),
      fetchJobs(),
      fetchSessions(),
      fetchCostAnalysis(),
      fetchCerebroTopics(),
      fetchOperators(),
      fetchSavingsProjections(),
      Promise.resolve(getSystemVitals())
    ]);
    
    // 根據隱私設定過濾資料
    let filteredSessions = sessions;
    let filteredTopics = topics;
    let filteredAgents = agents;
    
    if (privacySettings.enabled) {
      if (privacySettings.hiddenSessions?.length > 0) {
        filteredSessions = sessions.filter(s => !privacySettings.hiddenSessions.includes(s.key));
      }
      if (privacySettings.hiddenTopics?.length > 0) {
        filteredTopics = topics.filter(t => !privacySettings.hiddenTopics.includes(`${t.channel}:${t.type}`));
      }
      if (privacySettings.hiddenAgents?.length > 0) {
        filteredAgents = agents.filter(a => !privacySettings.hiddenAgents.includes(a.id));
      }
    }
    
    // 計算 Hero View 指標
    const activeSessions = filteredSessions.filter(s => (s.age || 0) < 300000).length;
    const systemCapacity = Math.max(0, 100 - (vitals.memory.percent + vitals.cpu.usage) / 2);
    
    res.json({
      hero: {
        totalTokens: costData.summary.totalTokens || 0,
        totalCost: costData.summary.totalCost || 0,
        totalSessions: filteredSessions.length,
        activeSessions: activeSessions,
        systemCapacity: Math.round(systemCapacity),
        recentCost: costData.summary.recentCost || 0,
        monthlySavings: savings.summary.monthlyEstimate || 0
      },
      agents: filteredAgents,
      jobs: jobs,
      sessions: filteredSessions,
      costData: privacySettings.hideCostData ? { summary: {} } : costData,
      topics: filteredTopics,
      operators: operators,
      savings: savings.summary,
      vitals: vitals,
      privacy: privacySettings,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 定期廣播更新
setInterval(async () => {
  try {
    const [agents, jobs, sessions, costData, topics, operators, savings, vitals] = await Promise.all([
      fetchAgents(), 
      fetchJobs(),
      fetchSessions(),
      fetchCostAnalysis(),
      fetchCerebroTopics(),
      fetchOperators(),
      fetchSavingsProjections(),
      Promise.resolve(getSystemVitals())
    ]);
    broadcastUpdate({ type: 'update', agents, jobs, sessions, costData, topics, operators, savings, vitals });
  } catch (error) {
    console.error('廣播更新失敗:', error.message);
  }
}, config.openclaw.pollInterval);

// 啟動伺服器
app.listen(PORT, HOST, () => {
  console.log(`🚀 OpenClaw Office 啟動於 http://${HOST}:${PORT}`);
  console.log(`📡 Gateway: ${GATEWAY_URL}`);
});
