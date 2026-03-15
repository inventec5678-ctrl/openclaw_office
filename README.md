# OpenClaw Office 🤖

OpenClaw Agent 控制中心 - 即時監控儀表板

## 功能特色

### 🤖 Agent 監控
- 顯示 5 個主要 Agent 的即時狀態
- 大頭貼 + 名稱 + 職責
- 現在執行中的任務
- 狀態：執行中 / 閒置

### 💬 Sessions 監控
- 即時顯示所有 active sessions
- Token 使用量統計
- 最後活动时间

### 📊 數據視覺化
- 成本分析圖表
- 趨勢圖（每日/每週/每月）
- 系統監控資訊

### ⏰ 排程任務
- Cron Jobs 執行狀態
- 排程時間顯示
- 執行進度追蹤

### 📁 工作區管理
- 點擊 Agent 卡片查看記憶檔案
- 編輯並儲存 Agent 記憶
- 瀏覽工作區檔案

### 🎨 介面特色
- 🌙 Dark mode 風格
- 🀄 繁體中文介面
- 📱 響應式設計
- ✨ 流暢動畫效果

## 目錄結構

```
openclaw_office/
├── lib/
│   └── server.js      # HTTP 伺服器 + API
├── public/
│   ├── index.html     # 主頁面
│   └── js/
│       └── app.js     # 前端邏輯
├── config/
│   └── config.yaml    # 配置文件
├── package.json
└── README.md
```

## 安裝

```bash
cd openclaw_office
npm install
```

## 啟動

```bash
npm start
```

伺服器會在 http://localhost:3000 啟動

## 配置

編輯 `config/config.yaml` 調整設定：

```yaml
server:
  port: 3000

openclaw:
  gateway: http://127.0.0.1:18789
  pollInterval: 5000
```

## API 端點

| 端點 | 說明 |
|------|------|
| `GET /api/agents` | 取得所有 Agent 狀態 |
| `GET /api/sessions` | 取得所有 Sessions |
| `GET /api/jobs` | 取得排程任務 |
| `GET /api/cost` | 取得成本數據 |
| `GET /api/events` | SSE 即時更新 |
| `GET /api/agents/:id/memory` | 取得 Agent 記憶 |
| `PUT /api/agents/:id/memory` | 更新 Agent 記憶 |
| `GET /api/agents/:id/files` | 取得工作區檔案 |

## 支援的 Agents

| Agent | 角色 | 大頭貼 |
|-------|------|--------|
| Ray | OpenClaw Office 工程師 | 🧑‍💻 |
| Tiffaney | AI 助手 | 👩‍💼 |
| Jason | 資料收集員 | 📊 |
| Louie | 量化交易工程師 | 📈 |
| Luka | 交易系統工程師 | 🔧 |

## 技術栈

- Node.js + Express
- Server-Sent Events (SSE)
- 原生 JavaScript（無框架）
- CSS Variables（Dark Mode）
- Chart.js 圖表

## License

MIT
