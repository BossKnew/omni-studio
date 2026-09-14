# 🎨 OmniStudio

[English](README.md) | 简体中文

OmniStudio 是一个面向团队的自托管图片与视频生成工作台：文生图、参考图编辑、局部重绘、文生视频、图生视频、首尾帧，内置素材库、回收站、积分额度、用户组、工作团队与按模型授权。

## ✨ 功能

- **生成**：文生图、参考图编辑、蒙版局部重绘、文生视频、图生视频、首尾帧。图生视频和首尾帧由管理员按模型开关。每个模型可配分辨率档位、比例、时长、质量、积分单价，以及按档位的倍率。
- **供应商**：供应商只保存账号凭证和 Base URL。添加模型时再选图片或视频，以及适配器：图片为 OpenAI Images、Qwen/Wan、Nano Banana、Seedream、Midjourney、Flux、Runway；视频为 Sora、Seedance、Wan/HappyHorse、Veo、MiniMax、Runway、Flux。兼容 OpenAI Videos 协议的网关可直接复用。同一 Google AI Studio 密钥可同时挂 Nano Banana 和 Veo；同一火山方舟密钥可同时挂 Seedream 和 Seedance；同一 BFL 密钥可同时挂 Flux 生图和生视频；同一 Runway 密钥可同时挂 Runway 生图和生视频。Midjourney 走兼容 midjourney-proxy 的网关（官方无公开 API）。
- **工作台**：图片/视频切换，会话、重新生成、重试、播放、下载（当前会话或素材库所选）、参考图、首尾帧槽位、遮罩绘制、风格预设、Prompt 历史与收藏、提示词润色。
- **素材**：会话、素材库（可按类型、来源、模型、日期、备注/提示词筛选）、工作团队分享、回收站（可恢复）、缩略图、存储配额。删除的文件在到期永久清除前仍计入存储。
- **管理**：用户审批、注册与会话设置、用户组（模型权限 + 每人滑动窗口积分额度）、工作团队（只用于分享）、用量台账、供应商与模型、尺寸/比例/质量/时长的显示文案、风格预设（样张与提示词）、提示词润色供应商、回收站留存（默认 30 天）、上传图片最长边（默认 4096）。
- **提示词润色**：支持文生图、图片编辑、文生视频。可配置多家供应商，同一时间只能启用一家。
- **安全**：管理员强制 MFA、API Key 与 MFA 密钥加密存储、SSRF 防护、速率限制、CSRF 防护
- **界面**：中文、英文

## 🧰 技术栈

Web（React 19、Vite、TypeScript）· API（NestJS、Prisma、PostgreSQL、Redis、BullMQ）· 部署（Docker Compose、Nginx）

## ⚡ 快速开始

环境要求：Docker Engine 与 Compose v2.24+、OpenSSL；建议至少 2 CPU / 4 GiB 内存。

```bash
cp .env.example .env    # Windows PowerShell: Copy-Item .env.example .env
```

编辑 `.env`，替换所有 `change-me` 占位值；各密钥独立生成：

```bash
openssl rand -hex 32
openssl rand -base64 32
```

启动：

```bash
docker compose config --quiet
docker compose up -d --build
```

访问 <http://localhost:8080>。首次登录使用 `.env` 中的引导管理员账号，系统会要求修改密码并绑定 MFA。

## 🚢 生产部署

- 使用 HTTPS：设置 `APP_ORIGINS` 为准确的 Origin，并设 `ALLOW_INSECURE_HTTP=false`
- 使用独立的高强度数据库、Redis、加密密钥与管理员密码
- 定期备份 PostgreSQL 数据与媒体卷
- 可选叠加：Traefik（`compose.traefik.yml`）、外部数据库/Redis（`compose.external.yml`）、Compose secrets（`compose.secrets.yml`）、拆分 HTTP/Worker（`compose.worker.yml`）
- 反向代理示例见 [`deploy`](deploy) 目录

## 🛠️ 本地开发

环境要求：Node.js 24、npm 11、PostgreSQL、Redis、`ffmpeg`。

```bash
npm ci
npm run db:generate
npm run dev
```

开发服务器：Web <http://localhost:5173>，API <http://localhost:4000>（Vite 将 `/api` 代理到本地 API）。

## 🔒 安全

不要提交 `.env`、密钥、数据库备份或媒体文件（默认已忽略）。漏洞请按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 📄 许可证

[MIT License](LICENSE)
