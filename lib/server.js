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

// 即時廣播函數 - 立即發送更新給所有客戶端
async function broadcastUpdate(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (e) {
      console.error('SSE 客戶端寫入錯誤:', e.message);
      sseClients.delete(client);
    }
  });
}

// 即時追蹤函數 - 獲取最新資料並廣播
async function fetchAndBroadcast() {
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
    await broadcastUpdate({ type: 'update', agents, jobs, sessions, costData, topics, operators, savings, vitals });
  } catch (error) {
    console.error('即時廣播失敗:', error.message);
  }
}

// 檔案監看 - 即時追蹤 sessions.json 變化
let sessionsPath = path.join(process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw'), 'agents', 'main', 'sessions', 'sessions.json');
let sessionsWatcher = null;
let lastBroadcastTime = 0;
const BROADCAST_THROTTLE_MS = 1000; // 節流：1秒內最多廣播一次

function startFileWatcher() {
  const sessionsDir = path.dirname(sessionsPath);
  
  // 確保目錄存在
  if (!fs.existsSync(sessionsDir)) {
    console.log('Sessions 目錄不存在，無法監看:', sessionsDir);
    return;
  }
  
  // 使用 fs.watch 監看目錄變化
  try {
    sessionsWatcher = fs.watch(sessionsDir, { persistent: true }, (eventType, filename) => {
      if (filename && (filename === 'sessions.json' || filename.endsWith('.jsonl'))) {
        const now = Date.now();
        // 節流：避免過於頻繁的廣播
        if (now - lastBroadcastTime > BROADCAST_THROTTLE_MS) {
          lastBroadcastTime = now;
          console.log(`📁 偵測到 sessions 變化 (${eventType}): ${filename}`);
          // 延遲一點點以確保檔案寫入完成
          setTimeout(() => fetchAndBroadcast(), 100);
        }
      }
    });
    
    sessionsWatcher.on('error', (err) => {
      console.error('Sessions 監看錯誤:', err.message);
    });
    
    console.log('✅ 已啟動即時檔案監看 - Session 變更將即時推送');
  } catch (error) {
    console.error('啟動檔案監看失敗:', error.message);
  }
}

// 停止檔案監看
function stopFileWatcher() {
  if (sessionsWatcher) {
    sessionsWatcher.close();
    sessionsWatcher = null;
    console.log('🛑 已停止檔案監看');
  }
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

// 取得 sessions (從所有 agents 的 sessions.json 檔案)
const MAIN_AGENTS = ['ray', 'tiffaney', 'jason', 'louie', 'luka'];

// 從 jsonl 檔案取得最新 user 訊息作為當前任務
function getLatestUserMessage(sessionFilePath) {
  try {
    if (!sessionFilePath || !fs.existsSync(sessionFilePath)) return null;
    const stats = fs.statSync(sessionFilePath);
    const maxBytes = 50 * 1024;
    const readStart = stats.size > maxBytes ? stats.size - maxBytes : 0;
    const fd = fs.openSync(sessionFilePath, 'r');
    const buffer = Buffer.alloc(stats.size - readStart);
    fs.readSync(fd, buffer, 0, buffer.length, readStart);
    fs.closeSync(fd);
    const fileContent = buffer.toString('utf8');
    const lines = fileContent.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'system') continue;
        if (entry.message && entry.message.role === 'user' && entry.message.content) {
          const msgContent = entry.message.content;
          let text = null;
          if (Array.isArray(msgContent)) {
            const textPart = msgContent.find(c => c.type === 'text');
            if (textPart && textPart.text) text = textPart.text;
          } else if (typeof msgContent === 'string') {
            text = msgContent;
          }
          if (text) {
            let cleanText = text.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '');
            cleanText = cleanText.replace(/^Conversation info.*$/gm, '').replace(/^Sender.*$/gm, '').replace(/^System:.*$/gm, '').trim();
            if (cleanText && cleanText.length > 0) {
              return cleanText.replace(/\s+/g, ' ').substring(0, 100);
            }
          }
        }
      } catch (e) { }
    }
  } catch (e) { }
  return null;
}

async function fetchSessions() {
  try {
    const openclawPath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const agentsBasePath = path.join(openclawPath, 'agents');
    const allSessionsArray = [];
    
    for (const agentName of MAIN_AGENTS) {
      const agentSessionsPath = path.join(agentsBasePath, agentName, 'sessions', 'sessions.json');
      if (fs.existsSync(agentSessionsPath)) {
        try {
          const sessionsData = JSON.parse(fs.readFileSync(agentSessionsPath, 'utf8'));
          for (const [key, session] of Object.entries(sessionsData)) {
            allSessionsArray.push({key: key, agentName: agentName, ...session});
          }
        } catch (e) {}
      }
    }
    
    const sessions = allSessionsArray.map((session) => {
      // 找出 key
      const key = session.key;
      // 計算 totalTokens
      const inputTokens = session.inputTokens || session.promptTokens || 0;
      const outputTokens = session.outputTokens || session.completionTokens || 0;
      const totalTokens = session.totalTokens || (inputTokens + outputTokens);
      const contextTokens = session.contextTokens || 200000;
      // 計算 percentUsed
      const percentUsed = session.percentUsed || (contextTokens > 0 ? Math.round((totalTokens / contextTokens) * 100) : 0);
      
      return {
        key: key,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        updatedAt: session.updatedAt,
        age: session.updatedAt ? Date.now() - session.updatedAt : null,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        percentUsed: percentUsed,
        model: session.model,
        contextTokens: contextTokens,
        kind: session.chatType || 'direct',
        systemSent: session.systemSent,
        abortedLastRun: session.abortedLastRun
      };
    }).filter(session => session.sessionFile && fs.existsSync(session.sessionFile));
    
    // 按 updatedAt 排序（新的在前）
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    
    return sessions.slice(0, 20); // 只回傳最新的 20 個
  } catch (error) {
    console.error('取得 sessions 失敗:', error.message);
    return [];
  }
}

// 取得 agents (即時追蹤從 sessions，不再只讀取記憶檔案)
// 只顯示 5 個主要 Agent: Ray, Tiffaney, Jason, Louie, Luka
async function fetchAgents() {
  try {
    // sessions 在 ~/.openclaw/agents/main/sessions/
    const openclawPath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const sessionsPath = path.join(openclawPath, 'agents', 'main', 'sessions', 'sessions.json');
    const agentsBasePath = path.join(openclawPath, 'agents');
    // memory 在 ~/.openclaw/workspace/memory/agents/
    const workspacePath = path.join(process.env.HOME, '.openclaw', 'workspace');
    const agentsPath = path.join(workspacePath, 'memory', 'agents');
    
    // 收集每個 agent 的 sessions
    const allAgentSessions = {};
    for (const agentName of MAIN_AGENTS) {
      const agentSessionsPath = path.join(agentsBasePath, agentName, 'sessions', 'sessions.json');
      if (fs.existsSync(agentSessionsPath)) {
        try {
          const agentSessions = JSON.parse(fs.readFileSync(agentSessionsPath, 'utf8'));
          for (const [sessionKey, sessionData] of Object.entries(agentSessions)) {
            allAgentSessions['agent:' + agentName + ':' + sessionKey] = sessionData;
          }
        } catch (e) {}
      }
    }
    
    const agentsList = [];
    const now = Date.now();
    const ACTIVE_THRESHOLD = 300000; // 5分鐘
    
    // 建立記憶檔案對照表 (用於取得基本資料)
    const memoryAgents = new Map();
    if (fs.existsSync(agentsPath)) {
      const agentFiles = fs.readdirSync(agentsPath).filter(f => f.endsWith('.md'));
      
      agentFiles.forEach(file => {
        const content = fs.readFileSync(path.join(agentsPath, file), 'utf8');
        
        // 解析 markdown 取得資訊
        const nameMatch = content.match(/- \*\*Name\*\*:\s*(.+)/);
        const roleMatch = content.match(/- \*\*Role\*\*:\s*(.+)/);
        
        const name = nameMatch ? nameMatch[1].trim() : file.replace('.md', '').replace(/-/g, ' ');
        const agentKey = name.toLowerCase();
        
        memoryAgents.set(agentKey, {
          id: file.replace('.md', '').toLowerCase(),
          name: name,
          role: roleMatch ? roleMatch[1].trim() : 'Agent',
          memoryFile: file,
          hasMemory: true
        });
      });
    }
    
    // 從 sessions 即時追蹤所有 agent 狀態
    if (Object.keys(allAgentSessions).length > 0) {
      // 用於追蹤已處理的 agent - 按名稱正規化
      const processedAgents = new Map();
      
      Object.entries(allAgentSessions).forEach(([sessionKey, session]) => {
          // 解析 session key: agent:main:subagent:uuid 或 agent:main:telegram:direct:xxx
          const parts = sessionKey.split(':');
          const isSubagent = sessionKey.includes('subagent');
          
          // 計算 session 年齡和狀態
          const age = session.updatedAt ? now - session.updatedAt : null;
          const isActive = age !== null && age < ACTIVE_THRESHOLD; // 5分鐘內有活動
          const isRecent = age !== null && age < 3600000; // 1小時內
          
          // 取得 agent 名稱 - 從 label 解析前綴 (如 "ray-backtest" -> "ray")
          let agentName = session.label || '';
          let taskName = '';
          if (agentName && agentName.includes('-')) {
            const parts = agentName.split('-');
            agentName = parts[0]; // ray-backtest -> ray
            taskName = session.label; // 保留完整任務名稱
          }
          
          if (!agentName) {
            if (isSubagent) {
              agentName = `Subagent ${parts[parts.length - 1]?.substring(0, 8)}`;
            } else {
              agentName = parts[1] || 'main';
            }
          }
          
          const agentKey = agentName.toLowerCase();
          
          // 🔥 過濾：只顯示 5 個主要 Agent
          if (!MAIN_AGENTS.includes(agentKey)) {
            return; // 跳過非主要 Agent
          }
          
          // 🔥 過濾：非 active 的 session 不要顯示（但仍記錄狀態為 idle）
          // 如果不是 active session，且不是 recent，則跳過這個 session 的顯示
          // 但我們仍需要記錄這個 agent 存在，只是狀態為 idle
          
          // 嘗試從記憶檔案取得基本資料
          let agentInfo = memoryAgents.get(agentKey);
          if (!agentInfo) {
            // 嘗試模糊匹配
            for (const [key, info] of memoryAgents) {
              if (agentKey.includes(key) || key.includes(agentKey)) {
                agentInfo = info;
                break;
              }
            }
          }
          
          // 決定即時狀態
          let status = 'idle';
          let displayTask = '閒置';
          
          // 取得最新 user 訊息作為當前任務
          let latestUserMessage = null;
          if (session.sessionFile) {
            latestUserMessage = getLatestUserMessage(session.sessionFile);
          }
          
          if (isActive) {
            status = 'running';
            displayTask = latestUserMessage || taskName || '執行中...';
          } else {
            // 非 active 也非 recent -> idle (閒置)
            status = 'idle';
            displayTask = '閒置';
          }
          
          // 檢查是否已處理過這個 agent
          const existingAgentKey = processedAgents.get(agentKey);
          if (existingAgentKey) {
            // 更新現有的 agent 狀態（如果這個更新更有活性）
            const existingAgent = agentsList.find(a => a.name.toLowerCase() === agentKey);
            if (existingAgent && (isActive || (existingAgent.status === 'offline' && status !== 'offline'))) {
              existingAgent.status = status;
              existingAgent.current_task = displayTask;
              existingAgent.lastActivity = session.updatedAt;
              existingAgent.sessionAge = age;
            }
            return;
          }
          processedAgents.set(agentKey, agentKey);
          
          // 建立 agent 物件
          const agent = {
            id: agentInfo?.id || (isSubagent ? sessionKey.substring(0, 8).replace(/[^a-z0-9]/gi, '') : agentKey),
            name: agentInfo?.name || agentName,
            role: agentInfo?.role || (isSubagent ? 'Subagent' : 'Agent'),
            status: status,
            current_task: displayTask,
            lastActivity: session.updatedAt,
            sessionAge: age,
            hasMemory: !!agentInfo?.hasMemory,
            memoryFile: agentInfo?.memoryFile || null
          };
          
          agentsList.push(agent);
        });
    }
    
    // 🔥 確保 5 個主要 Agent 都存在（如果沒有 session，則顯示為 idle）
    for (const mainAgent of MAIN_AGENTS) {
      const exists = agentsList.find(a => a.name.toLowerCase() === mainAgent);
      if (!exists) {
        // 嘗試從記憶檔案取得
        const agentInfo = memoryAgents.get(mainAgent);
        if (agentInfo) {
          agentsList.push({
            id: agentInfo.id,
            name: agentInfo.name,
            role: agentInfo.role,
            status: 'idle',
            current_task: '閒置',
            lastActivity: null,
            sessionAge: null,
            hasMemory: true,
            memoryFile: agentInfo.memoryFile
          });
        } else {
          // 如果沒有記憶檔案，仍加入基本資訊
          agentsList.push({
            id: mainAgent,
            name: mainAgent.charAt(0).toUpperCase() + mainAgent.slice(1),
            role: 'Agent',
            status: 'idle',
            current_task: '閒置',
            lastActivity: null,
            sessionAge: null,
            hasMemory: false,
            memoryFile: null
          });
        }
      }
    }
    
    // 🔥 過濾：確保只顯示 5 個主要 Agent
    const filteredAgents = agentsList.filter(a => MAIN_AGENTS.includes(a.name.toLowerCase()));
    
    // 排序：running > busy > idle > offline
    const statusOrder = { running: 0, busy: 1, idle: 2, offline: 3 };
    filteredAgents.sort((a, b) => (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4));
    
    return filteredAgents;
  } catch (error) {
    console.error('取得 agents 失敗:', error.message);
    return [];
  }
}

// 取得 jobs (從 cron 目錄 + active sessions)
async function fetchJobs() {
  try {
    const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw');
    const cronPath = path.join(workspacePath, 'agents', 'main', 'cron');
    const statePath = path.join(workspacePath, 'agents', 'main', 'cron-state.json');
    const sessionsPath = path.join(workspacePath, 'agents', 'main', 'sessions', 'sessions.json');
    
    // 讀取 cron 狀態
    let cronState = {};
    if (fs.existsSync(statePath)) {
      try {
        cronState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (e) {
        cronState = {};
      }
    }
    
    const jobs = [];
    
    // 首先讀取 cron jobs
    if (fs.existsSync(cronPath)) {
      const files = fs.readdirSync(cronPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    
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
    }
    
    // 加入 active subagent sessions 作為 jobs
    if (fs.existsSync(sessionsPath)) {
      try {
        const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
        const now = Date.now();
        
        Object.entries(sessionsData).forEach(([sessionKey, session]) => {
          // 檢查是否為 subagent session
          if (sessionKey.includes('subagent')) {
            const age = session.updatedAt ? now - session.updatedAt : null;
            const isActive = age !== null && age < 300000; // 5分鐘內有活動
            
            // 使用 label 作為名稱，如果沒有則用 session key 最後一段
            const label = session.label || '';
            const parts = sessionKey.split(':');
            const agentName = label || parts[parts.length - 1] || 'unknown';
            
            // 取得任務描述 - 嘗試從 label 取得有意義的任務名稱
            let currentAction = label || '處理中...';
            
            // 計算運行時間
            let runtime = '';
            if (session.createdAt || session.startedAt) {
              const startTime = session.createdAt || session.startedAt;
              const elapsed = now - startTime;
              const minutes = Math.floor(elapsed / 60000);
              const hours = Math.floor(minutes / 60);
              
              if (hours > 0) {
                runtime = `${hours}小時${minutes % 60}分`;
              } else if (minutes > 0) {
                runtime = `${minutes}分鐘`;
              } else {
                runtime = '< 1分';
              }
            }
            
            // 決定狀態
            let status = isActive ? 'running' : 'completed';
            if (session.abortedLastRun) status = 'failed';
            
            jobs.push({
              id: session.sessionId ? session.sessionId.substring(0, 8) : sessionKey.substring(0, 8),
              name: agentName,
              agentName: agentName,
              status: status,
              description: `Subagent: ${agentName}`,
              schedule: runtime,
              currentAction: currentAction,
              created_at: session.createdAt || session.startedAt || now,
              updated_at: session.updatedAt || now,
              nextRun: null,
              lastError: null,
              enabled: true,
              isSession: true,
              sessionKey: sessionKey
            });
          }
        });
      } catch (e) {
        console.error('讀取 sessions 失敗:', e.message);
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
    const workspacePath = path.join(process.env.HOME, '.openclaw', 'workspace');
    const { agentId } = req.params;
    
    // 1. 讀取基礎記憶檔案 (memory/agents/)
    const agentsPath = path.join(workspacePath, 'memory', 'agents');
    const basicFile = path.join(agentsPath, `${agentId}.md`);
    let basicContent = null;
    if (fs.existsSync(basicFile)) {
      basicContent = fs.readFileSync(basicFile, 'utf8');
    }
    
    // 2. 讀取工作筆記 (memory/{agent}_*.md)
    const memoryPath = path.join(workspacePath, 'memory');
    let notes = {};
    if (fs.existsSync(memoryPath)) {
      const files = fs.readdirSync(memoryPath).filter(f => f.endsWith('.md') && f.startsWith(agentId));
      for (const file of files) {
        const filePath = path.join(memoryPath, file);
        notes[file] = fs.readFileSync(filePath, 'utf8').substring(0, 3000); // 限制長度
      }
    }
    
    res.json({ 
      basic: basicContent, 
      notes: notes,
      basicFilename: `${agentId}.md`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 更新 Agent 記憶檔案
app.put('/api/agents/:agentId/memory', async (req, res) => {
  try {
    const workspacePath = path.join(process.env.HOME, '.openclaw', 'workspace');
    const { agentId } = req.params;
    const { content, type, filename } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: '缺少內容' });
    }
    
    if (type === 'note' && filename) {
      // 寫入工作筆記
      const memoryPath = path.join(workspacePath, 'memory');
      if (!fs.existsSync(memoryPath)) {
        fs.mkdirSync(memoryPath, { recursive: true });
      }
      const noteFile = path.join(memoryPath, filename);
      fs.writeFileSync(noteFile, content, 'utf8');
      res.json({ success: true, filename: filename });
    } else {
      // 寫入基礎記憶檔案
      const agentsPath = path.join(workspacePath, 'memory', 'agents');
      if (!fs.existsSync(agentsPath)) {
        fs.mkdirSync(agentsPath, { recursive: true });
      }
      const mdFile = path.join(agentsPath, `${agentId}.md`);
      fs.writeFileSync(mdFile, content, 'utf8');
      res.json({ success: true, filename: `${agentId}.md` });
    }
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
    
    // 檢查 session 檔案是否存在
    const sessionFile = session.sessionFile;
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      console.log(`Session 檔案不存在: ${sessionFile}`);
      return res.status(404).json({ error: 'Session 檔案已不存在' });
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

// 定期廣播更新（作為備用，保持定期同步）
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
    console.error('定期廣播失敗:', error.message);
  }
}, config.openclaw.pollInterval);

// 啟動伺服器
app.listen(PORT, HOST, () => {
  console.log(`🚀 OpenClaw Office 啟動於 http://${HOST}:${PORT}`);
  console.log(`📡 Gateway: ${GATEWAY_URL}`);
  
  // 啟動檔案監看以實現即時更新
  startFileWatcher();
});
