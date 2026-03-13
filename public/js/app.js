// OpenClaw Office - Frontend Application

class OpenClawOffice {
  constructor() {
    this.agents = [];
    this.jobs = [];
    this.sseConnected = false;
    
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
      const [agentsRes, jobsRes] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/jobs')
      ]);
      
      const agentsData = await agentsRes.json();
      const jobsData = await jobsRes.json();
      
      this.agents = agentsData.agents || [];
      this.jobs = jobsData.jobs || [];
      
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
    this.renderAgents();
    this.renderJobs();
    this.updateCounts();
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
    
    grid.innerHTML = this.agents.map(agent => {
      const initials = this.getInitials(agent.name || agent.id);
      const statusClass = this.getStatusClass(agent.status);
      const task = agent.current_task || agent.task || agent.now_doing || '閒置中';
      
      return `
        <div class="agent-card">
          <div class="agent-header">
            <div class="agent-avatar">${initials}</div>
            <div class="agent-info">
              <h3>${agent.name || agent.id}</h3>
              <div class="role">${agent.role || agent.description || 'Agent'}</div>
            </div>
          </div>
          <div class="agent-status ${statusClass}">
            <span class="status-dot-small"></span>
            ${this.translateStatus(agent.status)}
          </div>
          <div class="agent-task">
            <div class="agent-task-label">現在任務</div>
            <div class="agent-task-value">${task}</div>
          </div>
        </div>
      `;
    }).join('');
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
      const created = this.formatTime(job.created_at || job.created || job.started_at);
      const updated = this.formatTime(job.updated_at || job.updated);
      
      return `
        <div class="job-item">
          <div class="job-header">
            <span class="job-id">#${job.id}</span>
            <span class="job-status ${statusClass}">${this.translateJobStatus(job.status)}</span>
          </div>
          <div class="job-description">${description}</div>
          <div class="job-meta">
            <span>📅 ${created}</span>
            <span>🕐 ${updated}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // 更新計數
  updateCounts() {
    const onlineAgents = this.agents?.filter(a => a.status === 'online' || a.status === 'running').length || 0;
    const runningJobs = this.jobs?.filter(j => j.status === 'running' || j.status === 'pending').length || 0;
    
    document.getElementById('agentCount').textContent = `${onlineAgents} online`;
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
}

// 啟動應用
document.addEventListener('DOMContentLoaded', () => {
  window.app = new OpenClawOffice();
});
