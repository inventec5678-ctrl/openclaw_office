# OpenClaw Office

OpenClaw Agent 控制中心 - 精簡版

## 功能特色

- 🤖 顯示所有 Agent 狀態（大頭貼、職責、現在任務、狀態）
- 📋 顯示所有 Jobs 執行狀態
- 🔄 即時更新（SSE）
- 🌙 Dark mode 風格
- 🀄 繁體中文介面

## 目錄結構

```
openclaw_office/
├── lib/
│   └── server.js      # HTTP 伺服器
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

- `server.port` - 伺服器連接埠（預設 3000）
- `openclaw.gateway` - OpenClaw Gateway 位址
- `openclaw.pollInterval` - 輪詢間隔（毫秒）

## API 端點

- `GET /api/agents` - 取得所有 Agent
- `GET /api/jobs` - 取得所有 Job
- `GET /api/status` - 取得狀態摘要
- `GET /api/events` - SSE 即時更新

## 技術栈

- Node.js + Express
- Server-Sent Events (SSE)
- 原生 JavaScript（無框架）
- CSS Variables（Dark Mode）
