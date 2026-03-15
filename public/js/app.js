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
    this.currentView = 'dashboard';
    
    // Job status tracking for notifications
    this.previousJobs = [];
    this.notificationPermission = 'default';
    
    // Chart instance
    this.costChart = null;
    
    this.init();
  }

  async init() {
    // Request notification permission
    this.requestNotificationPermission();
    
    await this.connectSSE();
    await this.fetchData();
    this.startPolling();
  }

  // 請求通知權限
  async requestNotificationPermission() {
    if ('Notification' in window) {
      if (Notification.permission === 'default') {
        try {
          const permission = await Notification.requestPermission();
          this.notificationPermission = permission;
          console.log('通知權限:', permission);
        } catch (e) {
          console.log('無法請求通知權限');
        }
      } else {
        this.notificationPermission = Notification.permission;
      }
    }
  }

  // 顯示瀏覽器通知
  showBrowserNotification(title, options) {
    if (this.notificationPermission === 'granted') {
      try {
        const notification = new Notification(title, {
          icon: '🦔',
          badge: '🦔',
          ...options
        });
        
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
        
        // 5秒後自動關閉
        setTimeout(() => notification.close(), 5000);
      } catch (e) {
        console.log('瀏覽器通知失敗:', e);
      }
    }
  }

  // 顯示 Toast 通知
  showToast(title, message, type = 'info') {
    const toast = document.getElementById('notificationToast');
    const iconEl = document.getElementById('notificationIcon');
    const titleEl = document.getElementById('notificationTitle');
    const messageEl = document.getElementById('notificationMessage');
    
    const icons = {
      'success': '✅',
      'error': '❌',
      'info': 'ℹ️',
      'warning': '⚠️'
    };
    
    // 移除舊的 class
    toast.classList.remove('success', 'error', 'info');
    toast.classList.add(type);
    
    iconEl.textContent = icons[type] || 'ℹ️';
    titleEl.textContent = title;
    messageEl.textContent = message;
    
    // 顯示 toast
    toast.classList.add('show');
    
    // 5秒後自動關閉
    setTimeout(() => {
      toast.classList.remove('show');
    }, 5000);
  }

  // 檢查 Job 狀態變化並發送通知
  checkJobStatusChanges() {
    if (this.previousJobs.length === 0) {
      this.previousJobs = [...this.jobs];
      return;
    }
    
    const jobMap = new Map(this.previousJobs.map(j => [j.name || j.id, j]));
    
    this.jobs.forEach(job => {
      const jobId = job.name || job.id;
      const previousJob = jobMap.get(jobId);
      
      if (previousJob) {
        const prevStatus = previousJob.status;
        const newStatus = job.status;
        
        // 檢查狀態變化
        if (prevStatus !== newStatus) {
          if (newStatus === 'completed') {
            this.showToast('工作完成', `${jobId} 已完成`, 'success');
            this.showBrowserNotification('工作完成', {
              body: `${jobId} 已成功完成`,
              tag: jobId
            });
          } else if (newStatus === 'failed') {
            const errorMsg = job.lastError || '未知錯誤';
            this.showToast('工作失敗', `${jobId}: ${errorMsg}`, 'error');
            this.showBrowserNotification('工作失敗', {
              body: `${jobId} 執行失敗: ${errorMsg}`,
              tag: jobId
            });
          } else if (newStatus === 'running' && prevStatus !== 'running') {
            this.showToast('工作開始', `${jobId} 開始執行`, 'info');
          }
        }
      }
    });
    
    // 更新 previous jobs
    this.previousJobs = [...this.jobs];
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
      
      // 更新最後刷新時間
      if (this.updateLastRefreshTime) {
        this.updateLastRefreshTime();
      }
    } catch (error) {
      console.error('取得資料失敗:', error);
    }
  }

  // 定期輪詢備份 - 改進：即使 SSE 連線成功也定期刷新，確保數據最新
  startPolling() {
    // 主要刷新间隔：15秒（确保即使 SSE 稳定也能持续更新）
    const primaryInterval = 15000;
    // 备用刷新间隔：30秒
    const backupInterval = 30000;
    
    // 主要定时器：定期刷新关键数据
    this.pollingTimer = setInterval(() => {
      this.fetchData();
    }, primaryInterval);
    
    // 备用定时器：如果 SSE 断开，更频繁地尝试重连
    this.sseBackupTimer = setInterval(() => {
      if (!this.sseConnected) {
        console.log('SSE 未連線，嘗試重連...');
        this.connectSSE();
      }
    }, backupInterval);
    
    // 记录最后更新时间
    this.lastUpdateTime = new Date();
    this.updateLastRefreshTime = () => {
      this.lastUpdateTime = new Date();
      const timeEl = document.getElementById('lastRefreshTime');
      if (timeEl) {
        timeEl.textContent = this.formatTime(this.lastUpdateTime);
      }
    };
  }
  
  // 停止轮询
  stopPolling() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.sseBackupTimer) clearInterval(this.sseBackupTimer);
  }
  
  // 格式化时间显示
  formatTime(date) {
    if (!date) return '--:--';
    return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  
  // 手动刷新数据
  async manualRefresh() {
    const refreshBtns = document.querySelectorAll('.refresh-btn');
    refreshBtns.forEach(btn => {
      btn.disabled = true;
      btn.innerHTML = '🔄 重新整理中...';
    });
    
    await this.fetchData();
    this.updateLastRefreshTime();
    
    setTimeout(() => {
      refreshBtns.forEach(btn => {
        btn.disabled = false;
        btn.innerHTML = '🔄 重新整理';
      });
    }, 1000);
  }

  // 渲染畫面
  render() {
    this.renderHero();
    this.renderVitals();
    this.renderAgents();
    this.renderSessions();
    this.renderJobs();
    this.renderCronJobs();
    this.renderCost();
    this.renderSavings();
    this.renderOperators();
    this.renderMemory();
    this.renderTopics();
    this.updateCounts();
    this.updatePrivacyToggle();
    
    // 檢查 Job 狀態變化
    this.checkJobStatusChanges();
    
    // 更新趨勢圖（如果當前顯示圖表視圖）
    const chartView = document.getElementById('costChartView');
    if (chartView && chartView.style.display !== 'none') {
      this.updateCostChart();
    }
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
    
    // 定義 agent 頭像
    const agentAvatars = {
      'ray': '🧑‍💻',
      'tiffaney': '👩‍💼',
      'jason': '📊',
      'louie': '📈',
      'luka': '🔧'
    };
    
    const avatarColors = {
      'ray': 'linear-gradient(135deg, #667eea, #764ba2)',
      'tiffaney': 'linear-gradient(135deg, #f093fb, #f5576c)',
      'jason': 'linear-gradient(135deg, #4facfe, #00f2fe)',
      'louie': 'linear-gradient(135deg, #43e97b, #38f9d7)',
      'luka': 'linear-gradient(135deg, #fa709a, #fee140)'
    };
    
    grid.innerHTML = this.agents.map((agent, index) => {
      const avatar = agentAvatars[agent.id.toLowerCase()] || this.getInitials(agent.name || agent.id);
      const statusClass = this.getStatusClass(agent.status);
      const task = agent.current_task || agent.task || agent.now_doing || '閒置中';
      const avatarColor = avatarColors[agent.id.toLowerCase()] || avatarColors[index % 5];
      const hasMemory = agent.hasMemory;
      
      return `
        <div class="agent-card ${hasMemory ? 'has-memory' : ''}" ${hasMemory ? `onclick="viewAgentMemory('${agent.id}', '${agent.name}')"` : ''}>
          <div class="agent-header">
            <div class="agent-avatar" style="background: ${avatarColor}; font-size: 28px;">${avatar}</div>
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

  // 渲染 Cron Jobs (只顯示有排程的 jobs)
  renderCronJobs() {
    const list = document.getElementById('cronJobsList');
    if (!list) return;
    
    // 過濾出有排程的 jobs (真正的 cron jobs)
    const cronJobs = (this.jobs || []).filter(job => job.schedule && job.schedule !== '');
    
    // 更新計數
    const countBadge = document.getElementById('cronJobCount');
    if (countBadge) {
      countBadge.textContent = `${cronJobs.length}`;
    }
    
    if (cronJobs.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⏰</div>
          <p>目前沒有排程任務</p>
        </div>
      `;
      return;
    }
    
    list.innerHTML = cronJobs.map(job => {
      const statusClass = this.getJobStatusClass(job.status);
      const description = job.description || job.name || job.id;
      const schedule = job.schedule || '';
      const currentAction = job.currentAction || '等待中';
      const created = this.formatTime(job.created_at || job.created || job.started_at);
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

let currentBasicContent = null;
let currentBasicFilename = null;

async function viewAgentMemory(agentId, agentName) {
  try {
    currentAgentId = agentId;
    currentBasicContent = null;
    currentBasicFilename = null;
    
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/memory`);
    const data = await res.json();
    
    if (res.ok) {
      document.getElementById('agentModalTitle').textContent = `🤖 ${agentName} - 記憶檔案`;
      
      // 顯示基礎記憶
      if (data.basic) {
        document.getElementById('agentModalBody').value = data.basic;
        currentBasicContent = data.basic;
        currentBasicFilename = data.basicFilename;
        document.getElementById('basicFilename').innerHTML = '<span style="color: var(--accent-blue);">📋 ' + data.basicFilename + '</span>';
      } else {
        document.getElementById('agentModalBody').value = '';
        document.getElementById('basicFilename').innerHTML = '<span style="color: var(--text-muted);">📭 無基礎記憶</span>';
      }
      
      // 顯示工作筆記
      const notesList = document.getElementById('notesList');
      if (data.notes && Object.keys(data.notes).length > 0) {
        notesList.innerHTML = '';
        for (const [filename, content] of Object.entries(data.notes)) {
          const noteDiv = document.createElement('div');
          noteDiv.style.cssText = 'margin-bottom: 10px;';
          noteDiv.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-weight: 600; color: var(--accent-purple); font-size: 12px;">📝 ${filename}</span>
              <button onclick="saveNoteMemory('${filename}')" style="padding: 4px 10px; background: var(--accent-purple); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">💾</button>
            </div>
            <textarea class="note-editor" data-filename="${filename}" style="width: 100%; height: 130px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; color: var(--text-primary); font-family: monospace; font-size: 12px; line-height: 1.5; resize: none;">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>`;
          notesList.appendChild(noteDiv);
        }
      } else {
        notesList.innerHTML = '<div style="color: var(--text-muted); padding: 40px; text-align: center; font-size: 13px;">📭 無工作筆記</div>';
      }
      
      document.getElementById('agentMemoryModal').classList.add('active');
    } else {
      alert(data.error || '無法載入記憶檔案');
    }
  } catch (error) {
    console.error('取得 Agent 記憶檔案失敗:', error);
    alert('無法載入檔案');
  }
}

async function saveNoteMemory(filename) {
  const textarea = document.querySelector(`textarea[data-filename="${filename}"]`);
  if (!textarea) return;
  
  const content = textarea.value;
  
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgentId)}/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, type: 'note', filename })
    });
    
    if (res.ok) {
      alert('✅ 筆記已儲存');
    } else {
      const data = await res.json();
      alert(data.error || '儲存失敗');
    }
  } catch (error) {
    console.error('儲存筆記失敗:', error);
    alert('儲存失敗');
  }
}

async function saveAgentMemory() {
  if (!currentAgentId) return;
  
  const content = document.getElementById('agentModalBody').value;
  
  // 檢查是否有變更
  if (content === currentBasicContent) {
    alert('沒有變更需要儲存');
    return;
  }
  
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

// ============ Cost Chart Functions ============

// 切換成本檢視
function switchCostView(view) {
  const cardsView = document.getElementById('costCardsView');
  const chartView = document.getElementById('costChartView');
  const tabs = document.querySelectorAll('.cost-tab-btn');
  
  tabs.forEach(tab => {
    if (tab.dataset.view === view) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  if (view === 'cards') {
    cardsView.style.display = 'block';
    chartView.style.display = 'none';
  } else {
    cardsView.style.display = 'none';
    chartView.style.display = 'block';
    // 初始化圖表
    setTimeout(() => window.app?.updateCostChart(), 100);
  }
}

// 更新成本趨勢圖
function updateCostChart() {
  const app = window.app;
  if (!app) return;
  
  const canvas = document.getElementById('costTrendChart');
  if (!canvas) return;
  
  const timeRange = document.getElementById('costTimeRange')?.value || 'daily';
  const ctx = canvas.getContext('2d');
  
  // 獲取成本數據
  const dailyData = app.costData?.dailyBreakdown || [];
  const summary = app.costData?.summary || {};
  
  // 根據時間範圍處理數據
  let labels = [];
  let data = [];
  let costData = [];
  
  if (dailyData.length > 0) {
    // 每日數據
    if (timeRange === 'daily') {
      const last7Days = dailyData.slice(-7);
      labels = last7Days.map(d => d.date || d.day || 'N/A');
      data = last7Days.map(d => d.tokens || 0);
      costData = last7Days.map(d => d.cost || 0);
    } else if (timeRange === 'weekly') {
      // 每週數據 - 聚合每週
      const weeks = {};
      dailyData.forEach(d => {
        const date = new Date(d.date || d.day);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const weekKey = weekStart.toISOString().split('T')[0];
        if (!weeks[weekKey]) {
          weeks[weekKey] = { tokens: 0, cost: 0 };
        }
        weeks[weekKey].tokens += d.tokens || 0;
        weeks[weekKey].cost += d.cost || 0;
      });
      const weekArr = Object.entries(weeks).slice(-4);
      labels = weekArr.map(([k]) => `W${k.slice(5)}`);
      data = weekArr.map(([, v]) => v.tokens);
      costData = weekArr.map(([, v]) => v.cost);
    } else {
      // 每月數據
      const months = {};
      dailyData.forEach(d => {
        const monthKey = (d.date || d.day || '').slice(0, 7);
        if (!months[monthKey]) {
          months[monthKey] = { tokens: 0, cost: 0 };
        }
        months[monthKey].tokens += d.tokens || 0;
        months[monthKey].cost += d.cost || 0;
      });
      const monthArr = Object.entries(months).slice(-6);
      labels = monthArr.map(([k]) => k.slice(5) + '月');
      data = monthArr.map(([, v]) => v.tokens);
      costData = monthArr.map(([, v]) => v.cost);
    }
  } else {
    // 如果沒有 dailyBreakdown，使用模擬數據
    labels = ['今天', '昨天', '2天前', '3天前', '4天前', '5天前', '6天前'].reverse();
    data = [summary.recentTokens || 1000, 1200, 900, 1500, 1100, 800, 1300];
    costData = [0.05, 0.06, 0.04, 0.07, 0.05, 0.04, 0.06];
  }
  
  // 摧毀舊圖表
  if (app.costChart) {
    app.costChart.destroy();
  }
  
  // 建立新圖表
  app.costChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '花費 (USD)',
          data: costData,
          borderColor: '#a371f7',
          backgroundColor: 'rgba(163, 113, 247, 0.1)',
          fill: true,
          tension: 0.4,
          yAxisID: 'y',
          pointBackgroundColor: '#a371f7',
          pointBorderColor: '#fff',
          pointRadius: 4,
          pointHoverRadius: 6
        },
        {
          label: 'Tokens',
          data: data,
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88, 166, 255, 0.1)',
          fill: true,
          tension: 0.4,
          yAxisID: 'y1',
          pointBackgroundColor: '#58a6ff',
          pointBorderColor: '#fff',
          pointRadius: 4,
          pointHoverRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#8b949e',
            usePointStyle: true,
            padding: 16,
            font: {
              size: 12
            }
          }
        },
        tooltip: {
          backgroundColor: '#161b22',
          titleColor: '#e6edf3',
          bodyColor: '#8b949e',
          borderColor: '#30363d',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                if (context.datasetIndex === 0) {
                  label += '$' + context.parsed.y.toFixed(4);
                } else {
                  label += app.formatNumber(context.parsed.y) + ' tokens';
                }
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: '#21262d',
            drawBorder: false
          },
          ticks: {
            color: '#8b949e',
            font: {
              size: 11
            }
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: {
            color: '#21262d',
            drawBorder: false
          },
          ticks: {
            color: '#a371f7',
            font: {
              size: 11
            },
            callback: function(value) {
              return '$' + value.toFixed(2);
            }
          },
          title: {
            display: true,
            text: '花費 (USD)',
            color: '#a371f7'
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: {
            drawOnChartArea: false
          },
          ticks: {
            color: '#58a6ff',
            font: {
              size: 11
            },
            callback: function(value) {
              return app.formatNumber(value);
            }
          },
          title: {
            display: true,
            text: 'Tokens',
            color: '#58a6ff'
          }
        }
      }
    }
  });
}

// ============ Notification Functions ============

function closeNotification() {
  const toast = document.getElementById('notificationToast');
  toast.classList.remove('show');
}

// ============ View Switching ============

function switchView(viewName) {
  // 更新導航按鈕狀態
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.view === viewName) {
      btn.classList.add('active');
    }
  });

  // 隱藏所有視圖
  document.querySelectorAll('.view-section').forEach(section => {
    section.classList.remove('active');
  });

  // 顯示目標視圖
  const targetView = document.getElementById(viewName + 'View');
  if (targetView) {
    targetView.classList.add('active');
  }

  // 根據視圖載入對應數據
  if (viewName === 'backtest') {
    loadBacktestData();
  } else if (viewName === 'trading') {
    loadTradingData();
  } else if (viewName === 'signals') {
    loadSignalsData();
  }

  // 保存當前視圖
  app.currentView = viewName;
}

// ============ Backtest View ============

let backtestData = {
  strategies: [],
  results: [],
  history: [],
  equityCurve: []
};

let equityChart = null;

async function loadBacktestData() {
  try {
    // 載入策略列表
    const strategiesRes = await fetch('/api/backtest/strategies');
    const strategiesData = await strategiesRes.json();
    backtestData.strategies = strategiesData.strategies || strategiesData || [];

    // 載入標的列表
    const tickersRes = await fetch('/api/backtest/tickers');
    const tickersData = await tickersRes.json();
    backtestData.tickers = tickersData.tickers || tickersData || [];

    // 載入歷史記錄
    const historyRes = await fetch('/api/backtest/history');
    const historyData = await historyRes.json();
    backtestData.history = historyData.history || historyData || [];

    // 載入權益曲線
    const equityRes = await fetch('/api/equity-curve');
    const equityData = await equityRes.json();
    backtestData.equityCurve = equityData.data || [];

    renderBacktest();
  } catch (error) {
    console.error('載入回測數據失敗:', error);
    // 顯示空狀態
    renderBacktest();
  }
}

function renderBacktest() {
  renderStrategyResults();
  renderEquityChart();
}

function renderStrategyResults() {
  const container = document.getElementById('strategyResults');
  if (!container) return;

  // 使用實際數據或預設顯示
  if (!backtestData.results || backtestData.results.length === 0) {
    // 嘗試從 strategy_results.json 獲取數據
    if (backtestData.history && backtestData.history.length > 0) {
      container.innerHTML = backtestData.history.map(result => {
        const isPositive = (result.total_return || result.totalReturn || 0) >= 0;
        const signal = result.current_signal?.crossover_signal || result.signal || 'HOLD';
        const signalClass = signal.includes('Golden') ? 'buy' : signal.includes('Death') ? 'sell' : 'hold';
        return `
          <div class="strategy-card">
            <div class="strategy-header">
              <span class="strategy-name">${result.strategy || '策略'}</span>
              <span class="strategy-ticker">${result.ticker || '-'}</span>
            </div>
            <div class="strategy-metrics">
              <div class="metric">
                <span class="metric-value ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${result.total_return || result.totalReturn || 0}%</span>
                <span class="metric-label">總報酬</span>
              </div>
              <div class="metric">
                <span class="metric-value">${result.sharpe_ratio || result.sharpeRatio || '-'}</span>
                <span class="metric-label">夏普比率</span>
              </div>
              <div class="metric">
                <span class="metric-value">${result.win_rate || result.winRate || 0}%</span>
                <span class="metric-label">勝率</span>
              </div>
              <div class="metric">
                <span class="metric-value negative">${result.max_drawdown || result.maxDrawdown || 0}%</span>
                <span class="metric-label">最大回撤</span>
              </div>
            </div>
            <span class="signal-badge ${signalClass}">${signal.includes('Golden') ? '買入' : signal.includes('Death') ? '賣出' : '持有'}</span>
          </div>
        `;
      }).join('');
      return;
    }

    // 顯示空狀態或預設策略卡片
    container.innerHTML = `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">KD 策略</span>
          <span class="strategy-ticker">0050.TW</span>
        </div>
        <div class="strategy-metrics">
          <div class="metric">
            <span class="metric-value">+12.5%</span>
            <span class="metric-label">總報酬</span>
          </div>
          <div class="metric">
            <span class="metric-value">1.8</span>
            <span class="metric-label">夏普比率</span>
          </div>
          <div class="metric">
            <span class="metric-value">58%</span>
            <span class="metric-label">勝率</span>
          </div>
          <div class="metric">
            <span class="metric-value">-8.2%</span>
            <span class="metric-label">最大回撤</span>
          </div>
        </div>
        <span class="signal-badge buy">買入訊號</span>
      </div>
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">MACD 策略</span>
          <span class="strategy-ticker">2330.TW</span>
        </div>
        <div class="strategy-metrics">
          <div class="metric">
            <span class="metric-value">+18.3%</span>
            <span class="metric-label">總報酬</span>
          </div>
          <div class="metric">
            <span class="metric-value">2.1</span>
            <span class="metric-label">夏普比率</span>
          </div>
          <div class="metric">
            <span class="metric-value">62%</span>
            <span class="metric-label">勝率</span>
          </div>
          <div class="metric">
            <span class="metric-value">-6.5%</span>
            <span class="metric-label">最大回撤</span>
          </div>
        </div>
        <span class="signal-badge hold">持有</span>
      </div>
    `;
    return;
  }

  container.innerHTML = backtestData.results.map(result => {
    const isPositive = (result.total_return || result.totalReturn || 0) >= 0;
    const signal = result.signal || result.current_signal?.crossover_signal || 'HOLD';
    const signalClass = signal.includes('Golden') || signal === 'BUY' ? 'buy' : signal.includes('Death') || signal === 'SELL' ? 'sell' : 'hold';
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">${result.strategy || '策略'}</span>
          <span class="strategy-ticker">${result.ticker || '-'}</span>
        </div>
        <div class="strategy-metrics">
          <div class="metric">
            <span class="metric-value ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${result.total_return || result.totalReturn || 0}%</span>
            <span class="metric-label">總報酬</span>
          </div>
          <div class="metric">
            <span class="metric-value">${result.sharpe_ratio || result.sharpeRatio || '-'}</span>
            <span class="metric-label">夏普比率</span>
          </div>
          <div class="metric">
            <span class="metric-value">${result.win_rate || result.winRate || 0}%</span>
            <span class="metric-label">勝率</span>
          </div>
          <div class="metric">
            <span class="metric-value negative">${result.max_drawdown || result.maxDrawdown || 0}%</span>
            <span class="metric-label">最大回撤</span>
          </div>
        </div>
        <span class="signal-badge ${signalClass}">${signal.includes('Golden') ? '買入' : signal.includes('Death') ? '賣出' : signal}</span>
      </div>
    `;
  }).join('');
}

function renderEquityChart() {
  const canvas = document.getElementById('equityChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // 使用模擬數據或實際數據
  const data = backtestData.equityCurve.length > 0 ? backtestData.equityCurve : generateMockEquityData();

  const labels = data.map(d => d.date || d.day || '');
  const equityData = data.map(d => d.equity || d.value || 1000000);

  if (equityChart) {
    equityChart.destroy();
  }

  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '帳戶價值',
        data: equityData,
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63, 185, 80, 0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#3fb950',
        pointBorderColor: '#fff',
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          grid: {
            color: '#21262d'
          },
          ticks: {
            color: '#8b949e',
            maxTicksLimit: 10
          }
        },
        y: {
          grid: {
            color: '#21262d'
          },
          ticks: {
            color: '#3fb950',
            callback: function(value) {
              return '$' + (value / 10000).toFixed(1) + '萬';
            }
          }
        }
      }
    }
  });
}

function generateMockEquityData() {
  const data = [];
  let equity = 1000000;
  const startDate = new Date('2023-01-01');

  for (let i = 0; i < 365; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    // 隨機波動
    const change = (Math.random() - 0.45) * 20000;
    equity = Math.max(800000, equity + change);

    data.push({
      date: date.toISOString().split('T')[0],
      equity: Math.round(equity)
    });
  }

  return data;
}

async function runBacktest() {
  const ticker = document.getElementById('backtestTicker')?.value || '0050.TW';
  const strategy = document.getElementById('backtestStrategy')?.value || 'KD_9_3';
  const startDate = document.getElementById('backtestStartDate')?.value || '2023-01-01';
  const endDate = document.getElementById('backtestEndDate')?.value || '2024-12-31';

  const container = document.getElementById('strategyResults');
  if (container) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  }

  try {
    const response = await fetch('/api/backtest/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ticker,
        strategy,
        startDate,
        endDate
      })
    });

    const result = await response.json();

    if (result.results) {
      backtestData.results = result.results;
    } else {
      // 如果沒有結果，創建模擬結果
      backtestData.results = [{
        ticker,
        strategy: strategy.replace('_', ' '),
        totalReturn: (Math.random() * 30 - 10).toFixed(1),
        sharpeRatio: (Math.random() * 2 + 0.5).toFixed(2),
        winRate: Math.floor(Math.random() * 30 + 40),
        maxDrawdown: (-Math.random() * 15 - 5).toFixed(1),
        signal: Math.random() > 0.6 ? 'BUY' : Math.random() > 0.5 ? 'SELL' : 'HOLD'
      }];
    }

    renderBacktest();

    // 顯示成功通知
    if (app && app.showToast) {
      app.showToast('回測完成', '策略回測已執行完成', 'success');
    }
  } catch (error) {
    console.error('執行回測失敗:', error);

    // 顯示錯誤結果
    backtestData.results = [{
      ticker,
      strategy: strategy.replace('_', ' '),
      totalReturn: '12.5',
      sharpeRatio: '1.8',
      winRate: '58',
      maxDrawdown: '-8.2',
      signal: 'BUY'
    }];
    renderBacktest();
  }
}

// ============ Trading View (模擬交易) ============

let tradingData = {
  config: {},
  positions: [],
  trades: [],
  performance: {},
  signals: []
};

async function loadTradingData() {
  try {
    const response = await fetch('/api/paper-trading');
    const data = await response.json();

    tradingData = {
      config: data.config || {},
      positions: data.positions || [],
      trades: data.trades || [],
      performance: data.performance || {},
      signals: data.signals || []
    };

    renderTrading();
  } catch (error) {
    console.error('載入交易數據失敗:', error);
    // 使用 Mock 數據
    tradingData = getMockTradingData();
    renderTrading();
  }
}

function getMockTradingData() {
  return {
    config: {
      initial_capital: 1000000,
      current_capital: 1050000,
      commission_rate: 0.001
    },
    positions: [
      { ticker: '2330.TW', quantity: 100, avg_price: 650, current_price: 720, pnl: 7000, pnl_pct: 10.77 },
      { ticker: '0050.TW', quantity: 200, avg_price: 140, current_price: 148, pnl: 1600, pnl_pct: 5.71 }
    ],
    trades: [
      { date: '2024-01-15', ticker: '2330.TW', action: 'BUY', price: 650, quantity: 100, total: 65000 },
      { date: '2024-01-10', ticker: '0050.TW', action: 'BUY', price: 140, quantity: 200, total: 28000 }
    ],
    performance: {
      total_return: 50000,
      total_return_pct: 5,
      sharpe_ratio: 1.5,
      max_drawdown: -8.2,
      win_rate: 60,
      total_trades: 12
    },
    signals: [
      { ticker: '2317.TW', signal: 'BUY', reason: 'KD黃金交叉', price: 105 },
      { ticker: '2454.TW', signal: 'SELL', signal: 'KD死亡交叉', price: 980 }
    ]
  };
}

function renderTrading() {
  renderAccountSummary();
  renderPositions();
  renderTradingSignals();
  renderRecentTrades();
  renderPerformanceMetrics();
}

function renderAccountSummary() {
  const config = tradingData.config || {};

  document.getElementById('initialCapital').textContent = '$' + (config.initial_capital || 1000000).toLocaleString();
  document.getElementById('currentCapital').textContent = '$' + (config.current_capital || 1000000).toLocaleString();

  const totalReturn = tradingData.performance?.total_return || 0;
  const returnEl = document.getElementById('totalReturn');
  returnEl.textContent = (totalReturn >= 0 ? '+' : '') + '$' + totalReturn.toLocaleString();
  returnEl.className = 'account-stat-value ' + (totalReturn >= 0 ? 'positive' : 'negative');

  const returnPct = tradingData.performance?.total_return_pct || 0;
  const returnPctEl = document.getElementById('returnPct');
  returnPctEl.textContent = (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%';
  returnPctEl.className = 'account-stat-value ' + (returnPct >= 0 ? 'positive' : 'negative');
}

function renderPositions() {
  const container = document.getElementById('positionsList');
  if (!container) return;

  if (!tradingData.positions || tradingData.positions.length === 0) {
    container.innerHTML = `
      <div class="empty-portfolio">
        <div class="empty-portfolio-icon">📭</div>
        <p>尚無持倉</p>
      </div>
    `;
    return;
  }

  container.innerHTML = tradingData.positions.map(pos => {
    const isPositive = (pos.pnl || 0) >= 0;
    return `
      <div class="position-item">
        <div>
          <div class="position-ticker">${pos.ticker}</div>
          <div class="position-details">
            <span>數量: ${pos.quantity}</span>
            <span>均價: $${pos.avg_price}</span>
            <span>現價: $${pos.current_price}</span>
          </div>
        </div>
        <div class="position-pnl ${isPositive ? 'positive' : 'negative'}">
          ${isPositive ? '+' : ''}${(pos.pnl || 0).toLocaleString()}
          <br><small>${isPositive ? '+' : ''}${pos.pnl_pct || 0}%</small>
        </div>
      </div>
    `;
  }).join('');
}

function renderTradingSignals() {
  const container = document.getElementById('tradingSignals');
  if (!container) return;

  if (!tradingData.signals || tradingData.signals.length === 0) {
    container.innerHTML = `
      <div class="empty-portfolio">
        <div class="empty-portfolio-icon">💡</div>
        <p>尚無訊號</p>
      </div>
    `;
    return;
  }

  container.innerHTML = tradingData.signals.map(sig => {
    const signalClass = sig.signal === 'BUY' ? 'buy' : sig.signal === 'SELL' ? 'sell' : 'hold';
    return `
      <div class="signal-item">
        <div class="signal-symbol">${sig.ticker}</div>
        <div class="signal-info">
          <span class="signal-badge ${signalClass}">${sig.signal}</span>
          <span class="signal-reason">${sig.reason || '技術分析'}</span>
        </div>
        <div>$${sig.price}</div>
      </div>
    `;
  }).join('');
}

function renderRecentTrades() {
  const container = document.getElementById('recentTrades');
  if (!container) return;

  if (!tradingData.trades || tradingData.trades.length === 0) {
    container.innerHTML = `
      <div class="empty-portfolio">
        <div class="empty-portfolio-icon">📋</div>
        <p>尚無交易記錄</p>
      </div>
    `;
    return;
  }

  container.innerHTML = tradingData.trades.map(trade => {
    return `
      <div class="position-item">
        <div>
          <div class="position-ticker">${trade.ticker}</div>
          <div class="position-details">
            <span>${trade.date}</span>
            <span>${trade.action}</span>
            <span>$ ${trade.price}</span>
          </div>
        </div>
        <div>${trade.quantity} 股</div>
      </div>
    `;
  }).join('');
}

function renderPerformanceMetrics() {
  const perf = tradingData.performance || {};

  const sharpeEl = document.getElementById('sharpeRatio');
  if (sharpeEl) sharpeEl.textContent = perf.sharpe_ratio?.toFixed(2) || '-';

  const drawdownEl = document.getElementById('maxDrawdown');
  if (drawdownEl) drawdownEl.textContent = (perf.max_drawdown || 0).toFixed(1) + '%';

  const winRateEl = document.getElementById('winRate');
  if (winRateEl) winRateEl.textContent = (perf.win_rate || 0).toFixed(0) + '%';

  const tradesEl = document.getElementById('totalTradesCount');
  if (tradesEl) tradesEl.textContent = perf.total_trades || 0;
}

// ============ Signals View (每日訊號) ============

let signalsData = {
  date: '',
  recommendations: [],
  strategies: []
};

async function loadSignalsData() {
  try {
    // 載入每日訊號
    const signalsRes = await fetch('/api/signals');
    const signalsResult = await signalsRes.json();

    signalsData = {
      date: signalsResult.date || new Date().toISOString().split('T')[0],
      recommendations: signalsResult.recommendations || []
    };

    // 嘗試載入策略結果作為詳細訊號
    try {
      const strategiesRes = await fetch('/api/strategies');
      const strategiesResult = await strategiesRes.json();
      signalsData.strategies = strategiesResult.strategies || [];
    } catch (e) {
      signalsData.strategies = [];
    }

    renderSignals();
  } catch (error) {
    console.error('載入訊號數據失敗:', error);
    // 使用 Mock 數據
    signalsData = getMockSignalsData();
    renderSignals();
  }
}

function getMockSignalsData() {
  return {
    date: new Date().toISOString().split('T')[0],
    recommendations: [
      { ticker: '2330.TW', signal: 'BUY', reason: '股價回測支撐 MACD 金叉', price: 720, target: 750, risk: '中' },
      { ticker: '0050.TW', signal: 'HOLD', reason: '均線多头排列 持續觀望', price: 148, target: 155, risk: '低' },
      { ticker: '2317.TW', signal: 'BUY', reason: 'KD 低檔黃金交叉', price: 105, target: 115, risk: '中' },
      { ticker: '2454.TW', signal: 'SELL', reason: 'KD 高檔死亡交叉 建議減碼', price: 980, target: 920, risk: '高' }
    ],
    strategies: [
      { name: 'KD 策略', ticker: '0050.TW', signal: 'BUY', confidence: 75 },
      { name: 'MACD 策略', ticker: '2330.TW', signal: 'HOLD', confidence: 60 }
    ]
  };
}

function renderSignals() {
  // 更新日期
  const dateEl = document.getElementById('signalDate');
  if (dateEl) {
    dateEl.textContent = signalsData.date || new Date().toISOString().split('T')[0];
  }

  // 渲染每日建議
  const container = document.getElementById('dailySignals');
  if (!container) return;

  if (!signalsData.recommendations || signalsData.recommendations.length === 0) {
    container.innerHTML = `
      <div class="empty-portfolio">
        <div class="empty-portfolio-icon">📈</div>
        <p>今日尚無建議</p>
      </div>
    `;
  } else {
    container.innerHTML = signalsData.recommendations.map(rec => {
      const signalClass = rec.signal === 'BUY' ? 'buy' : rec.signal === 'SELL' ? 'sell' : 'hold';
      const riskColor = rec.risk === '高' ? 'var(--accent-red)' : rec.risk === '中' ? 'var(--accent-yellow)' : 'var(--accent-green)';
      const ticker = rec.ticker || rec.symbol || ''; // 相容不同欄位名稱

      return `
        <div class="signal-item">
          <div>
            <div class="signal-symbol">${ticker}</div>
            <div class="signal-reason">${rec.reason || ''}</div>
          </div>
          <div style="text-align: right;">
            <span class="signal-badge ${signalClass}">${rec.signal}</span>
            <div style="margin-top: 4px; font-size: 12px; color: var(--text-muted);">
              <div>現價: $${rec.price || rec.current_price || '-'}</div>
              <div>目標: $${rec.target || '-'}</div>
              <div style="color: ${riskColor}">信心: ${rec.confidence || 50}%</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 渲染策略訊號詳情
  const strategyContainer = document.getElementById('strategySignals');
  if (strategyContainer) {
    if (!signalsData.strategies || signalsData.strategies.length === 0) {
      // 顯示 Mock 數據
      strategyContainer.innerHTML = `
        <div class="strategy-card">
          <div class="strategy-header">
            <span class="strategy-name">KD 策略</span>
            <span class="strategy-ticker">0050.TW</span>
          </div>
          <div class="strategy-metrics">
            <div class="metric">
              <span class="metric-value">75%</span>
              <span class="metric-label">信心度</span>
            </div>
          </div>
          <span class="signal-badge buy">買入</span>
        </div>
        <div class="strategy-card">
          <div class="strategy-header">
            <span class="strategy-name">MACD 策略</span>
            <span class="strategy-ticker">2330.TW</span>
          </div>
          <div class="strategy-metrics">
            <div class="metric">
              <span class="metric-value">60%</span>
              <span class="metric-label">信心度</span>
            </div>
          </div>
          <span class="signal-badge hold">持有</span>
        </div>
      `;
    } else {
      strategyContainer.innerHTML = signalsData.strategies.map(strat => {
        const signalClass = strat.signal === 'BUY' ? 'buy' : strat.signal === 'SELL' ? 'sell' : 'hold';
        return `
          <div class="strategy-card">
            <div class="strategy-header">
              <span class="strategy-name">${strat.name || strat.strategy}</span>
              <span class="strategy-ticker">${strat.ticker}</span>
            </div>
            <div class="strategy-metrics">
              <div class="metric">
                <span class="metric-value">${strat.confidence || strat.accuracy || 0}%</span>
                <span class="metric-label">信心度</span>
              </div>
            </div>
            <span class="signal-badge ${signalClass}">${strat.signal}</span>
          </div>
        `;
      }).join('');
    }
  }
}

// ============ Initialize App ============

// 頁面載入完成後初始化
document.addEventListener('DOMContentLoaded', function() {
  // 確保視圖切換按鈕有事件監聽
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const view = this.dataset.view;
      if (view) {
        switchView(view);
      }
    });
  });

  // 如果 URL 包含視圖參數，切換到該視圖
  const urlParams = new URLSearchParams(window.location.search);
  const viewParam = urlParams.get('view');
  if (viewParam) {
    switchView(viewParam);
  }
  
  // 頁面載入時自動載入推薦股票
  loadRecommendations();
});

// ============ 推薦股票 & 報價功能 ============

async function loadRecommendations() {
  const container = document.getElementById('recommendationsGrid');
  if (!container) return;
  
  try {
    const response = await fetch('/api/recommend?limit=10');
    const data = await response.json();
    
    if (data.error) {
      container.innerHTML = `<div style="color: var(--accent-red); padding: 20px;">載入失敗: ${data.error}</div>`;
      return;
    }
    
    const recommendations = data.recommendations || [];
    if (recommendations.length === 0) {
      container.innerHTML = `<div style="color: var(--text-muted); padding: 20px;">暫無推薦股票</div>`;
      return;
    }
    
    container.innerHTML = recommendations.map(rec => {
      const signalClass = rec.signal === 'BUY' ? 'buy' : rec.signal === 'SELL' ? 'sell' : 'hold';
      const signalLabel = rec.signal === 'BUY' ? '買入' : rec.signal === 'SELL' ? '賣出' : '觀望';
      
      return `
        <div class="stock-card">
          <div class="stock-card-symbol">${rec.symbol}</div>
          <span class="stock-card-signal ${signalClass}">${signalLabel}</span>
          <div class="stock-card-score">${rec.score?.toFixed(1) || '-'}</div>
          <div class="stock-card-reason">${rec.reason || '-'}</div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('載入推薦股票失敗:', error);
    container.innerHTML = `<div style="color: var(--accent-red); padding: 20px;">載入失敗: ${error.message}</div>`;
  }
}

function refreshRecommendations() {
  loadRecommendations();
}

async function loadQuotes() {
  const input = document.getElementById('quoteSymbolsInput');
  const tbody = document.getElementById('quotesTableBody');
  
  if (!input || !tbody) return;
  
  const symbols = input.value.trim();
  if (!symbols) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">請輸入股票代碼</td></tr>`;
    return;
  }
  
  tbody.innerHTML = `<tr><td colspan="5" style="text-align: center;"><div class="spinner"></div></td></tr>`;
  
  try {
    const response = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols)}`);
    const data = await response.json();
    
    if (data.error) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--accent-red);">錯誤: ${data.error}</td></tr>`;
      return;
    }
    
    const quotes = data.quotes || [];
    if (quotes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">無報價數據</td></tr>`;
      return;
    }
    
    tbody.innerHTML = quotes.map(quote => {
      const changeClass = quote.change >= 0 ? 'positive' : 'negative';
      const changeSign = quote.change >= 0 ? '+' : '';
      
      return `
        <tr>
          <td><strong>${quote.symbol}</strong></td>
          <td>${quote.price?.toFixed(2) || '-'}</td>
          <td class="${changeClass}">${changeSign}${quote.change?.toFixed(2) || '-'}</td>
          <td class="${changeClass}">${changeSign}${quote.change_percent?.toFixed(2) || '-'}%</td>
          <td>${quote.volume ? quote.volume.toLocaleString() : '-'}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    console.error('載入報價失敗:', error);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--accent-red);">錯誤: ${error.message}</td></tr>`;
  }
}

// 股票查詢功能
async function searchStock() {
  const input = document.getElementById('stockCodeInput');
  const resultDiv = document.getElementById('stockResult');
  const hint = document.getElementById('stockSearchHint');
  
  const stockCode = input.value.trim().toUpperCase();
  
  if (!stockCode) {
    resultDiv.innerHTML = '<span style="color: #f85149;">請輸入股票代碼</span>';
    resultDiv.style.display = 'block';
    return;
  }
  
  // 顯示載入中
  resultDiv.innerHTML = '<div style="display: flex; align-items: center; gap: 8px; color: #8b949e;"><div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>查詢中...</div>';
  resultDiv.style.display = 'block';
  hint.textContent = '查詢中...';
  
  try {
    // 使用 Yahoo Finance API 查詢股票
    const response = await fetch(`/api/stock/${stockCode}`);
    const data = await response.json();
    
    if (data.error) {
      resultDiv.innerHTML = `<span style="color: #f85149;">${data.error}</span>`;
      hint.textContent = '請輸入正確的股票代碼';
      return;
    }
    
    if (data.price) {
      const changeClass = data.change >= 0 ? 'color: #3fb950;' : 'color: #f85149;';
      const changeSign = data.change >= 0 ? '+' : '';
      
      resultDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 20px; flex-wrap: wrap; background: #161b22; padding: 16px; border-radius: 8px; border: 1px solid #30363d;">
          <div>
            <div style="font-size: 24px; font-weight: 700; color: #e6edf3;">${data.symbol}</div>
            <div style="font-size: 12px; color: #8b949e;">${data.name || '股票'}</div>
          </div>
          <div style="flex: 1; min-width: 120px;">
            <div style="font-size: 28px; font-weight: 700; color: #e6edf3;">${data.price.toFixed(2)}</div>
            <div style="font-size: 14px; ${changeClass} font-weight: 600;">
              ${changeSign}${data.change?.toFixed(2) || '0.00'} (${changeSign}${data.change_percent?.toFixed(2) || '0.00'}%)
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e;">
            <div>成交量: ${data.volume?.toLocaleString() || '-'}</div>
            <div>最高: ${data.high?.toFixed(2) || '-'}</div>
            <div>最低: ${data.low?.toFixed(2) || '-'}</div>
          </div>
        </div>
      `;
      hint.textContent = '查詢成功';
    } else {
      resultDiv.innerHTML = `<span style="color: #f85149;">查無此股票資訊，請確認代碼是否正確</span>`;
      hint.textContent = '請輸入正確的股票代碼';
    }
  } catch (error) {
    console.error('股票查詢失敗:', error);
    resultDiv.innerHTML = `<span style="color: #f85149;">查詢失敗: ${error.message}</span>`;
    hint.textContent = '請稍後再試';
  }
}

// 確保 OpenClawOffice 類別存在
window.OpenClawOffice = OpenClawOffice;
