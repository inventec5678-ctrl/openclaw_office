// OpenClaw Office - Frontend Application

class OpenClawOffice {
  constructor() {
    this.agents = [];
    this.jobs = [];
    this.sessions = [];
    this.costData = { summary: {}, modelBreakdown: [], dailyBreakdown: [] };
    this.memories = [];
    this.topics = [];
    this.operators = [];
    this.savings = { summary: {} };
    this.vitals = { cpu: {}, memory: {}, disk: {}, system: {} };
    this.privacy = { enabled: false, hiddenTopics: [], hiddenSessions: [], hiddenAgents: [], hideCostData: false };
    this.hero = { totalTokens: 0, totalCost: 0, totalSessions: 0, activeSessions: 0, systemCapacity: 0, recentCost: 0, monthlySavings: 0 };
    this.sseConnected = false;
    this.currentView = 'dashboard'; // dashboard, hero
    
    this.init();
  }

  async init() {
    await this.connectSSE();
    await this.fetchData();
    this.startPolling();
  }

  // 連接 SSE 即時更新
  async connectSSE() {
    try {
      const eventSource = new EventSource('/api/events');
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'connected') {
            console.log('SSE 連線建立');
            this.updateConnectionStatus(true);
          } else if (data.type === 'update') {
            this.agents = data.agents || [];
            this.jobs = data.jobs || [];
            this.sessions = data.sessions || [];
            this.costData = data.costData || { summary: {}, modelBreakdown: [], dailyBreakdown: [] };
            this.topics = data.topics || [];
            this.operators = data.operators || [];
            this.savings = data.savings || { summary: {} };
            this.vitals = data.vitals || { cpu: {}, memory: {}, disk: {}, system: {} };
            this.render();
          }
        } catch (e) {
          console.error('解析 SSE 資料失敗:', e);
        }
      };
      
      eventSource.onerror = () => {
        console.log('SSE 連線中斷，5秒後重連...');
        this.updateConnectionStatus(false);
        eventSource.close();
        setTimeout(() => this.connectSSE(), 5000);
      };
      
    } catch (error) {
      console.error('SSE 連線失敗:', error);
      this.updateConnectionStatus(false);
    }
  }

  // 更新連線狀態顯示
  updateConnectionStatus(connected) {
    const dot = document.getElementById('connectionStatus');
    const text = document.getElementById('connectionText');
    
    if (connected) {
      dot.classList.remove('disconnected');
      text.textContent = '已連線';
    } else {
      dot.classList.add('disconnected');
      text.textContent = '離線';
    }
    
    this.sseConnected = connected;
  }

  // 取得 API 資料
  async fetchData() {
    try {
      const [agentsRes, jobsRes, sessionsRes, costRes, memoryRes, topicsRes, operatorsRes, savingsRes, vitalsRes, privacyRes, stateRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/jobs'),
        fetch('/api/sessions'),
        fetch('/api/cost'),
        fetch('/api/memory'),
        fetch('/api/topics'),
        fetch('/api/operators'),
        fetch('/api/savings'),
        fetch('/api/vitals'),
        fetch('/api/privacy'),
        fetch('/api/state') // 統一狀態 API
      ]);
      
      // 嘗試使用統一狀態 API 回傳資料
      const stateData = await stateRes.json().catch(() => null);
      
      if (stateData && stateData.hero) {
        // 使用統一狀態 API 的資料
        this.hero = stateData.hero;
        this.agents = stateData.agents || [];
        this.jobs = stateData.jobs || [];
        this.sessions = stateData.sessions || [];
        this.costData = stateData.costData || { summary: {}, modelBreakdown: [], dailyBreakdown: [] };
        this.topics = stateData.topics || [];
        this.operators = stateData.operators || [];
        this.savings = stateData.savings || { summary: {} };
        this.vitals = stateData.vitals || { cpu: {}, memory: {}, disk: {}, system: {} };
        this.privacy = stateData.privacy || { enabled: false };
      } else {
        // 使用個別 API
        const agentsData = await agentsRes.json();
        const jobsData = await jobsRes.json();
        const sessionsData = await sessionsRes.json();
        const costData = await costRes.json();
        const memoryData = await memoryRes.json();
        const topicsData = await topicsRes.json();
        const operatorsData = await operatorsRes.json();
        const savingsData = await savingsRes.json();
        const vitalsResponse = await vitalsRes.json();
        const privacyData = await privacyRes.json();
        
        this.agents = agentsData.agents || [];
        this.jobs = jobsData.jobs || [];
        this.sessions = sessionsData.sessions || [];
        this.costData = costData;
        this.memories = memoryData.memories || [];
        this.topics = topicsData.topics || [];
        this.operators = operatorsData.operators || [];
        this.savings = savingsData;
        this.vitals = vitalsResponse;
        this.privacy = privacyData;
        
        // 計算 Hero View 指標
        const activeSessions = this.sessions.filter(s => (s.age || 0) < 300000).length;
        const systemCapacity = this.vitals.memory?.percent ? Math.max(0, 100 - (this.vitals.memory.percent + (this.vitals.cpu?.usage || 0)) / 2) : 100;
        
        this.hero = {
          totalTokens: costData.summary?.totalTokens || 0,
          totalCost: costData.summary?.totalCost || 0,
          totalSessions: this.sessions.length,
          activeSessions: activeSessions,
          systemCapacity: Math.round(systemCapacity),
          recentCost: costData.summary?.recentCost || 0,
          monthlySavings: savingsData.summary?.monthlyEstimate || 0
        };
      }
      
      // 嘗試取得 memory 資料
      try {
        const memoryData = await (await fetch('/api/memory')).json();
        this.memories = memoryData.memories || [];
      } catch (e) {
        this.memories = [];
      }
      
      this.render();
    } catch (error) {
      console.error('取得資料失敗:', error);
    }
  }

  // 定期輪詢備份
  startPolling() {
    setInterval(() => {
      if (!this.sseConnected) {
        this.fetchData();
      }
    }, 30000);
  }

  // 渲染畫面
  render() {
    this.renderHero();
    this.renderVitals();
    this.renderAgents();
    this.renderSessions();
    this.renderJobs();
    this.renderCost();
    this.renderSavings();
    this.renderOperators();
    this.renderMemory();
    this.renderTopics();
    this.updateCounts();
    this.updatePrivacyToggle();
  }

  // ============ Hero View 渲染 ============
  renderHero() {
    const hero = this.hero || {};
    const container = document.getElementById('heroStats');
    
    if (!container) return;
    
    const savings = this.savings?.summary || {};
    const vitals = this.vitals || {};
    
    container.innerHTML = `
      <div class="hero-stat">
        <div class="hero-stat-icon">🎯</div>
        <div class="hero-stat-value">${this.formatNumber(hero.totalTokens || 0)}</div>
        <div class="hero-stat-label">總 Tokens</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-icon">💰</div>
        <div class="hero-stat-value">$${(hero.totalCost || 0).toFixed(4)}</div>
        <div class="hero-stat-label">總費用 (USD)</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-icon">💬</div>
        <div class="hero-stat-value">${hero.activeSessions || 0}/${hero.totalSessions || 0}</div>
        <div class="hero-stat-label">Active Sessions</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-icon">📈</div>
        <div class="hero-stat-value">$${this.formatNumber(savings.monthlyEstimate || 0)}</div>
        <div class="hero-stat-label">每月節省預估</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-icon">🖥️</div>
        <div class="hero-stat-value">${vitals.cpu?.usage?.toFixed(1) || 0}%</div>
        <div class="hero-stat-label">CPU</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-icon">🧠</div>
        <div class="hero-stat-value">${vitals.memory?.percent || 0}%</div>
        <div class="hero-stat-label">記憶體</div>
      </div>
      <div class="hero-stat capacity">
        <div class="hero-stat-icon">⚡</div>
        <div class="hero-stat-value">${hero.systemCapacity || 0}%</div>
        <div class="hero-stat-label">系統容量</div>
      </div>
    `;
  }

  // ============ System Vitals 渲染 ============
  renderVitals() {
    const vitals = this.vitals || {};
    const container = document.getElementById('vitalsGrid');
    
    if (!container) return;
    
    const cpu = vitals.cpu || {};
    const mem = vitals.memory || {};
    const disk = vitals.disk || {};
    const sys = vitals.system || {};
    
    container.innerHTML = `
      <div class="vital-card cpu">
        <div class="vital-header">
          <span class="vital-icon">🖥️</span>
          <span class="vital-title">CPU</span>
        </div>
        <div class="vital-value">${cpu.usage?.toFixed(1) || 0}%</div>
        <div class="vital-details">
          <div class="vital-detail">核心: ${cpu.cores || 0}</div>
          <div class="vital-detail">型號: ${cpu.model?.substring(0, 30) || 'Unknown'}</div>
          <div class="vital-detail">負載: ${cpu.loadAvg ? cpu.loadAvg.map(l => l.toFixed(2)).join(', ') : '-'}</div>
        </div>
      </div>
      <div class="vital-card memory">
        <div class="vital-header">
          <span class="vital-icon">🧠</span>
          <span class="vital-title">記憶體</span>
        </div>
        <div class="vital-value">${mem.percent || 0}%</div>
        <div class="vital-details">
          <div class="vital-detail">已用: ${this.formatFileSize(mem.used || 0)}</div>
          <div class="vital-detail">可用: ${this.formatFileSize(mem.free || 0)}</div>
          <div class="vital-detail">總量: ${this.formatFileSize(mem.total || 0)}</div>
        </div>
      </div>
      <div class="vital-card disk">
        <div class="vital-header">
          <span class="vital-icon">💾</span>
          <span class="vital-title">磁碟</span>
        </div>
        <div class="vital-value">${disk.percent || 0}%</div>
        <div class="vital-details">
          <div class="vital-detail">已用: ${this.formatFileSize(disk.used || 0)}</div>
          <div class="vital-detail">可用: ${this.formatFileSize(disk.free || 0)}</div>
          <div class="vital-detail">總量: ${this.formatFileSize(disk.total || 0)}</div>
        </div>
      </div>
      <div class="vital-card system">
        <div class="vital-header">
          <span class="vital-icon">🔧</span>
          <span class="vital-title">系統</span>
        </div>
        <div class="vital-details">
          <div class="vital-detail">主機名: ${sys.hostname || '-'}</div>
          <div class="vital-detail">平台: ${sys.platform || '-'}</div>
          <div class="vital-detail">架構: ${sys.arch || '-'}</div>
          <div class="vital-detail">運行時間: ${this.formatUptime(sys.uptime || 0)}</div>
        </div>
      </div>
    `;
  }

  // 格式化運行時間
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}天 ${hours}小時`;
    if (hours > 0) return `${hours}小時 ${mins}分`;
    return `${mins}分`;
  }

  // ============ Operators 渲染 ============
  renderOperators() {
    const grid = document.getElementById('operatorsGrid');
    
    if (!grid) return;
    
    document.getElementById('operatorCount').textContent = `${this.operators?.length || 0} 人`;
    
    if (!this.operators || this.operators.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👥</div>
          <p>目前沒有操作者</p>
        </div>
      `;
      return;
    }
    
    const getChannelIcon = (channel) => {
      const icons = {
        'telegram': '📱',
        'discord': '💬',
        'line': '💚',
        'whatsapp': '📱',
        'slack': '💬',
        'messenger': '📘'
      };
      return icons[channel?.toLowerCase()] || '🌐';
    };
    
    grid.innerHTML = this.operators.slice(0, 12).map(op => {
      const lastActivity = this.formatTime(op.lastActivity);
      const isActive = op.lastActivity && (Date.now() - op.lastActivity) < 300000;
      
      return `
        <div class="operator-card ${isActive ? 'active' : ''}" onclick="viewOperatorDetails('${op.id}', '${op.channel}')">
          <div class="operator-header">
            <div class="operator-avatar">${getChannelIcon(op.channel)}</div>
            <div class="operator-info">
              <div class="operator-name">${op.displayName}</div>
              <div class="operator-channel">${op.channel}</div>
            </div>
          </div>
          <div class="operator-stats">
            <div class="operator-stat">
              <span class="operator-stat-value">${op.sessionCount}</span>
              <span class="operator-stat-label">Sessions</span>
            </div>
            <div class="operator-stat">
              <span class="operator-stat-value">${this.formatNumber(op.totalTokens)}</span>
              <span class="operator-stat-label">Tokens</span>
            </div>
          </div>
          <div class="operator-last-activity">
            <span class="activity-dot ${isActive ? 'live' : ''}"></span>
            ${lastActivity}
          </div>
        </div>
      `;
    }).join('');
  }

  // ============ Savings 渲染 ============
  renderSavings() {
    const container = document.getElementById('savingsCards');
    const savings = this.savings?.summary || {};
    
    if (!container) return;
    
    document.getElementById('savingsBadge').textContent = `$${savings.totalSavings || 0}`;
    
    container.innerHTML = `
      <div class="savings-card highlight">
        <div class="savings-value">$${savings.totalSavings || 0}</div>
        <div class="savings-label">總節省 (USD)</div>
      </div>
      <div class="savings-card">
        <div class="savings-value">${savings.recentSessions || 0}</div>
        <div class="savings-label">今日 Sessions</div>
      </div>
      <div class="savings-card">
        <div class="savings-value">$${(savings.recentSavings || 0).toFixed(2)}</div>
        <div class="savings-label">今日節省</div>
      </div>
      <div class="savings-card">
        <div class="savings-value">$${this.formatNumber(savings.monthlyEstimate || 0)}</div>
        <div class="savings-label">本月預估</div>
      </div>
      <div class="savings-card">
        <div class="savings-value">$${this.formatNumber(savings.yearlyEstimate || 0)}</div>
        <div class="savings-label">年度預估</div>
      </div>
    `;
  }

  // 更新隱私控制開關
  updatePrivacyToggle() {
    const toggle = document.getElementById('privacyToggle');
    if (toggle) {
      toggle.checked = this.privacy?.enabled || false;
    }
  }

  // 渲染 Agents
  renderAgents() {
    const grid = document.getElementById('agentsGrid');
    
    if (!this.agents || this.agents.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <p>目前沒有執行中的 Agent</p>
        </div>
      `;
      return;
    }
    
    // 定義 avatar 顏色
    const avatarColors = [
      'linear-gradient(135deg, #667eea, #764ba2)',
      'linear-gradient(135deg, #f093fb, #f5576c)',
      'linear-gradient(135deg, #4facfe, #00f2fe)',
      'linear-gradient(135deg, #43e97b, #38f9d7)',
      'linear-gradient(135deg, #fa709a, #fee140)',
      'linear-gradient(135deg, #a8edea, #fed6e3)',
      'linear-gradient(135deg, #ff9a9e, #fecfef)',
      'linear-gradient(135deg, #ffecd2, #fcb69f)'
    ];
    
    grid.innerHTML = this.agents.map((agent, index) => {
      const initials = this.getInitials(agent.name || agent.id);
      const statusClass = this.getStatusClass(agent.status);
      const task = agent.current_task || agent.task || agent.now_doing || '閒置中';
      const avatarColor = avatarColors[index % avatarColors.length];
      const hasMemory = agent.hasMemory;
      
      return `
        <div class="agent-card ${hasMemory ? 'has-memory' : ''}" ${hasMemory ? `onclick="viewAgentMemory('${agent.id}', '${agent.name}')"` : ''}>
          <div class="agent-header">
            <div class="agent-avatar" style="background: ${avatarColor}">${initials}</div>
            <div class="agent-info">
              <h3>${agent.name || agent.id}</h3>
              <div class="role">${agent.role || 'Agent'}</div>
            </div>
            ${hasMemory ? '<span class="memory-badge" title="有記憶檔案">📝</span>' : ''}
          </div>
          <div class="agent-status ${statusClass}">
            <span class="status-dot-small"></span>
            ${this.translateStatus(agent.status)}
          </div>
          <div class="agent-task">
            <div class="agent-task-label">現在任務</div>
            <div class="agent-task-value">${task}</div>
          </div>
          ${hasMemory ? '<div class="agent-hint">點擊查看記憶</div>' : ''}
        </div>
      `;
    }).join('');
  }

  // 渲染 Sessions
  renderSessions() {
    const grid = document.getElementById('sessionsGrid');
    
    if (!this.sessions || this.sessions.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">💬</div>
          <p>目前沒有活動中的 Session</p>
        </div>
      `;
      return;
    }
    
    grid.innerHTML = this.sessions.map(session => {
      // 判斷 session 狀態
      const age = session.age || 0;
      const isLive = age < 300000; // 5分鐘內
      const isRecent = age < 3600000; // 1小時內
      const statusClass = isLive ? 'live' : (isRecent ? 'recent' : 'idle');
      
      // 解析 key 取得顯示名稱
      const key = session.key || '';
      const displayName = this.parseSessionKey(key);
      
      // Token 統計
      const inputTokens = session.inputTokens || 0;
      const outputTokens = session.outputTokens || 0;
      const totalTokens = session.totalTokens || (inputTokens + outputTokens);
      const percentUsed = session.percentUsed || 0;
      
      // 顯示時間
      const updated = this.formatTime(session.updatedAt);
      
      // 編碼 key 用於 URL
      const encodedKey = encodeURIComponent(key);
      
      return `
        <div class="session-card ${statusClass}" onclick="viewSessionDetail('${encodedKey}')">
          <div class="session-header">
            <span class="session-key" title="${key}">${displayName}</span>
            <span class="session-kind ${session.kind || 'direct'}">${session.kind || 'direct'}</span>
          </div>
          <div class="session-stats">
            <div class="session-stat">
              <span class="session-stat-value">${this.formatNumber(totalTokens)}</span>
              <span class="session-stat-label">Tokens</span>
            </div>
            <div class="session-stat">
              <span class="session-stat-value">${percentUsed}%</span>
              <span class="session-stat-label">Context</span>
            </div>
          </div>
          <div class="session-progress">
            <div class="session-progress-bar" style="width: ${Math.min(percentUsed, 100)}%"></div>
          </div>
          <div class="session-model">
            <span>${session.model || 'MiniMax-M2.5'}</span> · ${updated}
          </div>
        </div>
      `;
    }).join('');
  }
  
  // 解析 session key 為易讀名稱
  parseSessionKey(key) {
    if (!key) return 'Unknown';
    
    // 格式: agent:main:telegram:direct:6330601313
    const parts = key.split(':');
    if (parts.length >= 4) {
      const channel = parts[2]; // telegram, discord, etc.
      const type = parts[3]; // direct, group
      const id = parts[4] || '';
      
      // 擷取 ID 最後幾位
      const shortId = id.length > 6 ? id.substring(id.length - 6) : id;
      
      return `${channel}:${type}:${shortId}`;
    }
    
    return key.length > 20 ? key.substring(0, 20) + '...' : key;
  }
  
  // 格式化數字
  formatNumber(num) {
    if (!num || num === null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  // 渲染 Jobs
  renderJobs() {
    const list = document.getElementById('jobsList');
    
    if (!this.jobs || this.jobs.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>目前沒有執行中的工作</p>
        </div>
      `;
      return;
    }
    
    list.innerHTML = this.jobs.map(job => {
      const statusClass = this.getJobStatusClass(job.status);
      const description = job.description || job.name || job.id;
      const schedule = job.schedule || '';
      const currentAction = job.currentAction || '等待中';
      const created = this.formatTime(job.created_at || job.created || job.started_at);
      const updated = this.formatTime(job.updated_at || job.updated);
      const nextRun = job.nextRun ? this.formatTime(job.nextRun) : null;
      const hasError = job.lastError;
      
      // 狀態圖示
      const statusIcon = {
        'running': '⚡',
        'pending': '⏳',
        'queued': '📋',
        'completed': '✅',
        'failed': '❌'
      }[job.status] || '📋';
      
      return `
        <div class="job-item ${statusClass}">
          <div class="job-header">
            <div class="job-title">
              <span class="job-icon">${statusIcon}</span>
              <span class="job-id">${job.name}</span>
            </div>
            <span class="job-status ${statusClass}">${this.translateJobStatus(job.status)}</span>
          </div>
          <div class="job-current-action">
            <span class="action-label">目前動作:</span>
            <span class="action-value">${currentAction}</span>
          </div>
          <div class="job-description">${description}</div>
          <div class="job-meta">
            <span>📅 建立: ${created}</span>
            ${nextRun ? `<span>⏰ 下次: ${nextRun}</span>` : ''}
          </div>
          ${hasError ? `<div class="job-error">⚠️ 錯誤: ${hasError}</div>` : ''}
          ${schedule ? `<div class="job-schedule">🔄 排程: ${schedule}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // ============ 渲染成本分析 ============
  renderCost() {
    const container = document.getElementById('costCards');
    const summary = this.costData.summary || {};
    
    const totalCost = summary.totalCost || 0;
    const recentCost = summary.recentCost || 0;
    const totalTokens = summary.totalTokens || 0;
    const sessionCount = summary.sessionCount || 0;
    
    // 更新 badge
    document.getElementById('costBadge').textContent = `$${totalCost.toFixed(4)}`;
    
    // 顯示費用卡片
    let html = `
      <div class="cost-card highlight">
        <div class="cost-value">$${totalCost.toFixed(4)}</div>
        <div class="cost-label">總費用 (USD)</div>
      </div>
      <div class="cost-card">
        <div class="cost-value">${this.formatNumber(totalTokens)}</div>
        <div class="cost-label">總 Tokens</div>
      </div>
      <div class="cost-card">
        <div class="cost-value">${sessionCount}</div>
        <div class="cost-label">Sessions</div>
      </div>
    `;
    
    // 如果有模型 breakdown
    const models = this.costData.modelBreakdown || [];
    if (models.length > 0) {
      html += `<div class="cost-breakdown" style="grid-column: span 2; margin-top: 12px;">`;
      html += `<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">模型使用分布</div>`;
      
      models.slice(0, 3).forEach(model => {
        html += `
          <div class="cost-model-item">
            <span class="cost-model-name">${model.model}</span>
            <span class="cost-model-tokens">${this.formatNumber(model.totalTokens)} tokens</span>
          </div>
        `;
      });
      
      html += `</div>`;
    }
    
    container.innerHTML = html;
  }

  // ============ 渲染 Memory Browser ============
  renderMemory() {
    const list = document.getElementById('memoryList');
    
    // 更新計數
    document.getElementById('memoryCount').textContent = `${this.memories.length} 檔案`;
    
    if (!this.memories || this.memories.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🧠</div>
          <p>目前沒有記憶檔案</p>
        </div>
      `;
      return;
    }
    
    list.innerHTML = this.memories.map(mem => {
      const icon = mem.type === 'markdown' ? '📝' : '📄';
      const size = this.formatFileSize(mem.size);
      const modified = this.formatTime(mem.modified);
      
      return `
        <div class="memory-item" onclick="viewMemory('${mem.path}')">
          <div class="memory-name">
            <span class="memory-icon">${icon}</span>
            ${mem.name}
          </div>
          <div class="memory-preview">${mem.preview}</div>
          <div class="memory-meta">
            <span>${size}</span>
            <span>${modified}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ============ 渲染 Cerebro Topics ============
  renderTopics() {
    const grid = document.getElementById('topicsGrid');
    
    // 更新計數
    document.getElementById('topicCount').textContent = `${this.topics.length} 主題`;
    
    if (!this.topics || this.topics.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <p>目前沒有主題數據</p>
        </div>
      `;
      return;
    }
    
    // 取得 channel icon
    const getChannelIcon = (channel) => {
      const icons = {
        'telegram': '📱',
        'discord': '💬',
        'line': '💚',
        'whatsapp': '📱',
        'slack': '💬'
      };
      return icons[channel?.toLowerCase()] || '🌐';
    };
    
    grid.innerHTML = this.topics.map(topic => {
      const icon = getChannelIcon(topic.channel);
      const typeLabel = topic.type === 'direct' ? '私訊' : (topic.type === 'group' ? '群組' : topic.type);
      
      return `
        <div class="topic-card">
          <div class="topic-header">
            <div class="topic-icon ${topic.channel}">${icon}</div>
            <div class="topic-channel">${topic.channel}</div>
          </div>
          <div class="topic-stats">
            <div class="topic-stat">
              <span class="topic-stat-value">${topic.sessionCount}</span>
              <span class="topic-stat-label">Sessions</span>
            </div>
            <div class="topic-stat">
              <span class="topic-stat-value">${this.formatNumber(topic.totalTokens)}</span>
              <span class="topic-stat-label">Tokens</span>
            </div>
          </div>
          <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
            ${typeLabel}
          </div>
        </div>
      `;
    }).join('');
  }

  // 更新計數
  updateCounts() {
    const onlineAgents = this.agents?.filter(a => a.status === 'online' || a.status === 'running').length || 0;
    const runningJobs = this.jobs?.filter(j => j.status === 'running' || j.status === 'pending').length || 0;
    
    // 計算 active sessions (5分鐘內有活動)
    const activeSessions = this.sessions?.filter(s => (s.age || 0) < 300000).length || 0;
    const totalSessions = this.sessions?.length || 0;
    
    document.getElementById('agentCount').textContent = `${onlineAgents} online`;
    document.getElementById('sessionCount').textContent = `${activeSessions}/${totalSessions} active`;
    document.getElementById('jobCount').textContent = `${runningJobs} 執行中`;
  }

  // 工具函數
  getInitials(name) {
    if (!name) return '?';
    return name.substring(0, 2).toUpperCase();
  }

  getStatusClass(status) {
    if (status === 'online' || status === 'running') return 'online';
    if (status === 'busy' || status === 'working') return 'busy';
    return 'offline';
  }

  translateStatus(status) {
    const map = {
      'online': '線上',
      'running': '執行中',
      'busy': '忙碌中',
      'working': '工作中',
      'idle': '閒置',
      'offline': '離線',
      'error': '錯誤'
    };
    return map[status?.toLowerCase()] || status || '未知';
  }

  getJobStatusClass(status) {
    if (status === 'running') return 'running';
    if (status === 'pending' || status === 'queued') return 'pending';
    if (status === 'completed' || status === 'done') return 'completed';
    if (status === 'failed' || status === 'error') return 'failed';
    return 'pending';
  }

  translateJobStatus(status) {
    const map = {
      'running': '執行中',
      'pending': '等待中',
      'queued': '排隊中',
      'completed': '已完成',
      'done': '已完成',
      'failed': '失敗',
      'error': '錯誤',
      'cancelled': '已取消'
    };
    return map[status?.toLowerCase()] || status || '未知';
  }

  formatTime(timestamp) {
    if (!timestamp) return '-';
    
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now - date;
      
      // 小於1分鐘
      if (diff < 60000) return '刚刚';
      // 小於1小時
      if (diff < 3600000) return `${Math.floor(diff / 60000)}分鐘前`;
      // 小於24小時
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}小時前`;
      
      // 超過24小時顯示日期
      return date.toLocaleDateString('zh-TW', { 
        month: 'numeric', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return String(timestamp);
    }
  }

  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}

// Memory Modal Functions
async function viewMemory(filename) {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(filename)}`);
    const data = await res.json();
    
    document.getElementById('modalTitle').textContent = data.filename;
    document.getElementById('modalBody').textContent = data.content;
    document.getElementById('memoryModal').classList.add('active');
  } catch (error) {
    console.error('取得記憶檔案失敗:', error);
    alert('無法載入檔案');
  }
}

// Agent Memory Modal Functions
let currentAgentId = null;

async function viewAgentMemory(agentId, agentName) {
  try {
    currentAgentId = agentId;
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/memory`);
    const data = await res.json();
    
    if (res.ok) {
      document.getElementById('agentModalTitle').textContent = `🤖 ${agentName} - 記憶檔案`;
      document.getElementById('agentModalBody').value = data.content;
      document.getElementById('agentModalFilename').textContent = data.filename;
      document.getElementById('agentMemoryModal').classList.add('active');
    } else {
      alert(data.error || '無法載入記憶檔案');
    }
  } catch (error) {
    console.error('取得 Agent 記憶檔案失敗:', error);
    alert('無法載入檔案');
  }
}

async function saveAgentMemory() {
  if (!currentAgentId) return;
  
  const content = document.getElementById('agentModalBody').value;
  
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      alert('✅ 記憶檔案已儲存');
      closeAgentMemoryModal();
    } else {
      alert('儲存失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (error) {
    console.error('儲存 Agent 記憶檔案失敗:', error);
    alert('儲存失敗');
  }
}

function closeAgentMemoryModal() {
  document.getElementById('agentMemoryModal').classList.remove('active');
  currentAgentId = null;
}

function closeMemoryModal() {
  document.getElementById('memoryModal').classList.remove('active');
}

// ============ Session Detail Modal ============
let currentSessionId = null;

async function viewSessionDetail(sessionKey) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}`);
    const data = await res.json();
    
    if (res.ok) {
      document.getElementById('sessionDetailModal').classList.add('active');
      renderSessionDetail(data);
    } else {
      alert(data.error || '無法載入會話詳情');
    }
  } catch (error) {
    console.error('取得會話詳情失敗:', error);
    alert('無法載入會話詳情');
  }
}

function renderSessionDetail(session) {
  const container = document.getElementById('sessionDetailContent');
  
  if (!container) return;
  
  const toolsUsed = session.toolsUsed || [];
  const toolListHtml = toolsUsed.length > 0 
    ? toolsUsed.map(t => `<span class="tool-tag">${t}</span>`).join('')
    : '<span class="text-muted">無</span>';
  
  container.innerHTML = `
    <div class="session-detail-section">
      <div class="detail-header">
        <h3>📋 基本資訊</h3>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Session ID</span>
          <span class="detail-value">${session.sessionId || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Key</span>
          <span class="detail-value code">${session.key || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Agent</span>
          <span class="detail-value">${session.agent || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Channel</span>
          <span class="detail-value">${session.channel || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Type</span>
          <span class="detail-value">${session.type || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Operator</span>
          <span class="detail-value">${session.operator || '-'}</span>
        </div>
      </div>
    </div>
    
    <div class="session-detail-section">
      <div class="detail-header">
        <h3>📊 使用統計</h3>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Input Tokens</span>
          <span class="detail-value">${session.inputTokens?.toLocaleString() || 0}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Output Tokens</span>
          <span class="detail-value">${session.outputTokens?.toLocaleString() || 0}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Total Tokens</span>
          <span class="detail-value highlight">${session.totalTokens?.toLocaleString() || 0}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Context 使用率</span>
          <span class="detail-value">${session.percentUsed || 0}%</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Model</span>
          <span class="detail-value code">${session.model || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Context Tokens</span>
          <span class="detail-value">${session.contextTokens?.toLocaleString() || 0}</span>
        </div>
      </div>
    </div>
    
    <div class="session-detail-section">
      <div class="detail-header">
        <h3>🔧 工具使用</h3>
      </div>
      <div class="tools-list">
        ${toolListHtml}
      </div>
    </div>
    
    <div class="session-detail-section">
      <div class="detail-header">
        <h3>⏱️ 時間資訊</h3>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">建立時間</span>
          <span class="detail-value">${session.createdAt ? new Date(session.createdAt).toLocaleString('zh-TW') : '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">最後更新</span>
          <span class="detail-value">${session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-TW') : '-'}</span>
        </div>
      </div>
    </div>
  `;
}

function closeSessionDetailModal() {
  document.getElementById('sessionDetailModal').classList.remove('active');
}

// ============ Operator Detail Modal ============
async function viewOperatorDetails(operatorId, channel) {
  try {
    // 顯示 operators 中的詳情
    const app = window.app;
    const operator = app.operators?.find(o => o.id === operatorId && o.channel === channel);
    
    if (operator) {
      document.getElementById('operatorDetailModal').classList.add('active');
      renderOperatorDetail(operator);
    } else {
      alert('找不到操作者資訊');
    }
  } catch (error) {
    console.error('取得操作者詳情失敗:', error);
    alert('無法載入操作者詳情');
  }
}

function renderOperatorDetail(operator) {
  const container = document.getElementById('operatorDetailContent');
  
  if (!container) return;
  
  container.innerHTML = `
    <div class="operator-detail-section">
      <div class="detail-header">
        <h3>👤 基本資訊</h3>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">ID</span>
          <span class="detail-value code">${operator.id || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Channel</span>
          <span class="detail-value">${operator.channel || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Type</span>
          <span class="detail-value">${operator.type || '-'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">最後活動</span>
          <span class="detail-value">${operator.lastActivity ? new Date(operator.lastActivity).toLocaleString('zh-TW') : '-'}</span>
        </div>
      </div>
    </div>
    
    <div class="operator-detail-section">
      <div class="detail-header">
        <h3>📊 統計資訊</h3>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">總 Sessions</span>
          <span class="detail-value highlight">${operator.sessionCount || 0}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">總 Tokens</span>
          <span class="detail-value">${operator.totalTokens?.toLocaleString() || 0}</span>
        </div>
      </div>
    </div>
    
    <div class="operator-detail-section">
      <div class="detail-header">
        <h3>💬 最近 Sessions</h3>
      </div>
      <div class="recent-sessions-list">
        ${(operator.sessions || []).slice(0, 5).map(s => `
          <div class="recent-session-item">
            <span class="session-id">${s.sessionId?.substring(0, 20) || '-'}...</span>
            <span class="session-tokens">${s.tokens?.toLocaleString() || 0} tokens</span>
            <span class="session-time">${s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-TW') : '-'}</span>
          </div>
        `).join('') || '<div class="text-muted">無最近 sessions</div>'}
      </div>
    </div>
  `;
}

function closeOperatorDetailModal() {
  document.getElementById('operatorDetailModal').classList.remove('active');
}

// ============ Privacy Controls ============
async function togglePrivacyControls(enabled) {
  try {
    const app = window.app;
    const currentSettings = app.privacy || {};
    
    const newSettings = {
      ...currentSettings,
      enabled: enabled
    };
    
    const res = await fetch('/api/privacy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });
    
    const data = await res.json();
    
    if (res.ok) {
      app.privacy = data.settings;
      app.fetchData(); // 重新整理資料
    } else {
      alert('設定儲存失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (error) {
    console.error('儲存隱私設定失敗:', error);
    alert('儲存失敗');
  }
}

// 點擊 modal 背景關閉
document.getElementById('memoryModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'memoryModal') {
    closeMemoryModal();
  }
});

// Session Detail Modal 背景關閉
document.getElementById('sessionDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'sessionDetailModal') {
    closeSessionDetailModal();
  }
});

// Operator Detail Modal 背景關閉
document.getElementById('operatorDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'operatorDetailModal') {
    closeOperatorDetailModal();
  }
});

// 鍵盤關閉
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMemoryModal();
    closeAgentMemoryModal();
    closeSessionDetailModal();
    closeOperatorDetailModal();
  }
});

// 啟動應用
document.addEventListener('DOMContentLoaded', () => {
  window.app = new OpenClawOffice();
});
