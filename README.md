# VoceChat Channel Plugin — 开发文档

> 本文档面向未来需要继续开发或维护此插件的开发者。旨在提供清晰的架构理解、代码组织说明，以及已知的开发痛点和改进方向。

---

## 目录

1. [项目结构](#1-项目结构)
2. [核心模块与职责](#2-核心模块与职责)
3. [消息流图](#3-消息流图)
4. [入站图片处理链路](#4-入站图片处理链路)
5. [Telegram 管理面板机制](#5-telegram-管理面板机制)
6. [关键开发注意点](#6-关键开发注意点)
7. [已知问题与痛点](#7-已知问题与痛点)
8. [配置字段参考](#8-配置字段参考)
9. [SDK 兼容性与依赖](#9-sdk-兼容性与依赖)

---

## 1. 项目结构

```
openclaw-vocechat-channel/
├── index.ts                    # ⭐ 主入口，插件核心逻辑（~146KB，单文件）
├── openclaw.plugin.json        # 插件清单（configSchema + uiHints）
├── package.json                # npm 元信息
├── tsconfig.json               # TypeScript 配置
├── src/
│   ├── panel-store.ts          # Telegram 面板状态持久化（JSON 文件）
│   └── telegram-panel-delivery.ts  # Telegram Bot API 调用封装
├── skills/
│   └── vocechat-send/         # Agent 可调用的发送 skill
│       ├── SKILL.md
│       └── scripts/
│           ├── send.sh        # 底层发送脚本
│           └── lib/           # 共享工具
├── config/
│   └── plugin-config.example.json5  # 配置示例
├── docs/
│   └── vocechat-inbound-image-upgrade.md  # 入站图片升级说明
├── scripts/
│   ├── install.sh             # 一键安装脚本
│   ├── uninstall.sh           # 卸载脚本
│   ├── doctor.sh              # 健康检查脚本
│   └── sync-to-root-extension.sh  # 代码同步脚本
└── dist/                      # TypeScript 编译产物
```

---

## 2. 核心模块与职责

### 2.1 `index.ts` — 主入口（~146KB）

这是插件的核心，约 3000+ 行代码，全部写在**一个巨大的单文件**中。包含以下逻辑区域：

| 逻辑区域 | 行数区间 | 职责 |
|----------|-----------|------|
| **类型定义** | 文件头部 | `VoceChatAccountConfig`, `ResolvedAccount`, `InboundEvent`, `InboundAttachment` 等 |
| **工具函数群** | 散落各处 | `resolveVoceChatAccount()`, `parseInboundEvent()`, `resolveInboundMediaUrl()` 等大量纯函数 |
| **HTTP 客户端** | `requestVoceChatApi()` 附近 | API 调用，支持 loopback fallback 和 fetch 两种路径 |
| **出站发送** | `sendVoceChatMessage()`, `sendVoceChatMedia()` | 文本/附件发送给 VoceChat |
| **入站 Webhook** | `createWebhookHandler()`, `processInboundEvent()` | 接收 VoceChat webhook，解析并路由到 agent |
| **图片/音频处理** | `hydrateInboundAttachments()`, `transcribeAudioFile()` | 下载媒体文件、语音转写（Sherpa-ONNX） |
| **管理面板** | `voceChatChannel` 导出后的管理命令代码 | `/vocechatctl` 命令、Telegram 卡片渲染 |
| **ChannelPlugin 定义** | `voceChatChannel` 对象 | OpenClaw 通道接口实现 |

**文件过大的问题**：该文件包含过多职责，**极难维护**。重构建议见[痛点章节](#7-已知问题与痛点)。

### 2.2 `src/panel-store.ts`

Telegram 管理面板的状态存储模块。

- 负责将面板的生命周期数据（`panelId`, `chatId`, `messageId`, `ownerSenderId`）写入 JSON 文件
- 支持 TTL 自动清理过期面板（默认 24 小时）
- 纯同步文件操作，使用 `fs.writeFileSync`

**注意**：由于 OpenClaw 可能多进程运行，面板状态文件存在竞写风险。如果需要生产级面板，建议迁移到 SQLite 或在内存中管理。

### 2.3 `src/telegram-panel-delivery.ts`

Telegram Bot API 的调用封装。

- `sendMessage()` / `editMessage()` — 发送和编辑 Telegram 消息
- 使用原生 `fetch`（Node 22 内置），无额外 HTTP 客户端依赖
- 支持 `ProxyAgent`（通过 `undici.ProxyAgent`），可配置代理
- `parseTelegramTarget()` — 解析 Telegram 目标格式

---

## 3. 消息流图

### 3.1 出站消息流（OpenClaw → VoceChat 用户）

```
Agent/SDK 调用
    │
    ▼
runtime.channel.outbound.sendText / sendMedia
    │
    ▼
resolveVoceChatAccount()     ← 从配置解析账号
    │
    ▼
ensureTarget()              ← 解析 "user:123" / "group:456" 格式
    │
    ├─── 文本消息 ──→ sendVoceChatMessage()
    │                    │
    │                    ├── buildSendUrl()         ← 拼接 API URL
    │                    ├── buildPayloadText()     ← 格式化文本
    │                    ├── requestVoceChatApi()   ← HTTP POST
    │                    └── parseMessageId()       ← 解析返回的 messageId
    │
    └─── 媒体消息 ──→ sendVoceChatMedia()
                         │
                         ├── loadOutboundMediaFromUrl()  ← 下载媒体
                         ├── prepareVoceChatFileUpload() ← 准备上传
                         ├── uploadVoceChatFile()         ← 分块上传
                         └── sendVoceChatMessage()        ← 发送路径引用
```

### 3.2 入站消息流（VoceChat → OpenClaw Agent）

```
VoceChat 服务端
    │
    ▼（HTTP POST webhook）
registerPluginHttpRoute()
    │
    ▼
createWebhookHandler()
    │
    ├── readJsonBodyWithLimit()     ← 读取 JSON body
    ├── parseInboundEvent()         ← 解析消息类型、文本、附件
    ├── extractInboundAttachments() ← 提取图片/音频附件
    └── isInboundAuthorized()       ← allowFrom / groupAllowFrom 检查
           │
           ▼（如启用）sendVoceChatReaction()   ← 回 👍 确认
           │
           ▼（如启用）sendVoceChatMessage()    ← 回确认文本
           │
           ▼
hydrateInboundAttachments()    ← 下载媒体到本地磁盘
           │
           ├── resolveInboundMediaUrl()   ← 解析真实下载 URL
           ├── requestInboundBinaryResource()  ← HTTP 下载
           └── transcribeAudioFile()      ← 语音转写（Sherpa-ONNX）
                   │
                   ▼
buildInboundAgentBody()        ← 拼接给 agent 的文本
    │
    ▼
runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher()
    │
    ▼
Agent 处理
    │
    ▼
deliverReply() (回调)
    │
    ├── sendVoceChatReplyToMessage()  ← 引用回复（群聊）
    └── sendVoceChatMessage()         ← 直接发送（私聊）
```

---

## 4. 入站图片处理链路

这是 0.4.9 引入的重大升级，完整链路如下：

```
Webhook Payload
    │
    ▼
extractInboundAttachments()    ← 递归遍历 payload，收集所有图片/音频候选
    │
    ├── collectInboundAttachmentCandidates()  ← 深度遍历（最多3层）
    └── parseInboundAttachmentCandidate()     ← 解析每个候选的 URL/mime/ID
            │
            ▼
dedupeInboundAttachments()     ← 按 URL+mime 去重，最多 8 个
            │
            ▼
hydrateInboundAttachments()
    │
    ├── 检查 manifest.json     ← 同 messageId 则跳过（避免重复下载）
    ├── 下载图片到
    │   └── ~/.openclaw/workspace/media/inbound/vocechat/
    │       └── YYYY/MM/DD/<messageId>/
    │           └── 01-<uuid>.jpg
    └── 写入 manifest.json
            │
            ▼
buildInboundAgentBody()
    │
    ├── "用户发送了一张图片。"
    ├── "本地文件：/path/to/...jpg"
    ├── "原始文件名：xxx.jpg"
    ├── "MIME：image/jpeg"
    └── "如有需要请直接识别图片内容..."
```

**关键文件**：`transcribeAudioFile()` 调用 `~/.openclaw/workspace/scripts/sherpa_asr.py` 进行本地语音识别（SiliconFlow/SenseVoiceSmall 模型）。

---

## 5. Telegram 管理面板机制

### 5.1 命令格式

```
/vocechatctl [action] [arg]
/vocechatctl p <panelId> <action> [arg]   ← 按钮回调
```

### 5.2 面板状态流程

```
管理员发送 /vocechatctl
    │
    ▼
store.create()               ← 创建面板记录（panelId → JSON 文件）
    │
    ▼
delivery.sendMessage()       ← 发送第一张卡片
    │
    ▼
用户点击按钮
    │
    ▼
handleVoceChatManagementCommand()
    │
    ├── parseVoceChatCommandArgs()   ← 解析 panelId + action + arg
    ├── store.get(panelId)           ← 读取面板状态
    ├── renderVoceChatPanel()        ← 渲染新内容
    ├── delivery.editMessage()       ← 原地编辑卡片
    └── store.update()              ← 更新面板 updatedAt（刷新 TTL）
```

### 5.3 面板视图

| 视图 | Action | 内容 |
|------|--------|------|
| 概览 | `home` | 账号总数、启用状态、默认目标 |
| 账号列表 | `accounts` | 所有账号的状态概览 |
| 账号详情 | `account-detail` | 单账号的完整配置 |
| Webhook | `webhook` | Webhook 启用情况 |
| 路由 | `routing` | 默认目标、路径模板 |
| 权限 | `access` | 管理员白名单 |

---

## 6. 关键开发注意点

### 6.1 SDK 导入路径（极容易出错）

```typescript
// ❌ 旧版 SDK（已废弃）
import { registerPluginHttpRoute, loadOutboundMediaFromUrl } from "openclaw/plugin-sdk";

// ✅ 当前版本 —— 分路径导入
import { registerPluginHttpRoute, loadOutboundMediaFromUrl } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/mattermost.js";
import { DEFAULT_WEBHOOK_BODY_TIMEOUT_MS, DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/infra-runtime.js";
import { createReplyPrefixOptions } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/channel-runtime.js";
import { createNormalizedOutboundDeliverer, formatTextWithAttachmentLinks, resolveOutboundMediaUrls } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/irc.js";
```

**问题**：SDK 没有统一导出，每个模块的路径都可能变化。每次 OpenClaw 大版本升级都可能需要更新这些导入路径。

### 6.2 Loopback Fallback 机制

出站和入站 HTTP 请求都实现了"优先直连，失败后走 loopback"的降级逻辑：

```
请求 URL
    │
    ├── canUseLoopbackFallback(url)? ──No──→ 直接请求
    │
    Yes
    │
    ├── 优先：直连（fetch 或 loopback）
    │       │
    │       └── 成功 → 返回
    │       └── 失败 → 降级到备用路径
    │
    └── 备用：走 127.0.0.1（loopback）
            │
            └── 成功 → 返回
            └── 失败 → 抛错
```

**适用场景**：当 OpenClaw 和 VoceChat 部署在同一台机器时，外部 URL 会被劫持到本地服务。

### 6.3 多账号配置合并逻辑

```typescript
// 配置合并顺序（后面的覆盖前面的）
const merged = {
  ...asRecord(baseConfig),     // channels.vocechat 层级
  ...account,                  // channels.vocechat.accounts.<id> 层级
};
```

### 6.4 VoceChat API 路径模板

```typescript
// 默认模板
const DEFAULT_PRIVATE_PATH_TEMPLATE = "/api/bot/send_to_user/{id}";
const DEFAULT_GROUP_PATH_TEMPLATE = "/api/bot/send_to_group/{id}";

// 路径中的 {id} 会被替换为 encodeURIComponent(targetId)
```

---

## 7. 已知问题与痛点

### 7.1 ⚠️ `index.ts` 单文件过大（~146KB）

这是最大的维护性问题。整个插件的所有逻辑都堆在一个文件中：
- 类型定义
- 工具函数（50+ 个）
- HTTP 客户端
- 消息处理
- 管理面板
- 插件入口

**建议**：至少拆分为以下模块：

```
src/
├── types.ts              ← 所有类型定义
├── config.ts            ← 配置解析逻辑
├── outbound.ts          ← 出站发送（sendVoceChatMessage / sendVoceChatMedia）
├── inbound/
│   ├── webhook.ts       ← Webhook 处理
│   ├── parser.ts        ← parseInboundEvent / extractInboundAttachments
│   └── media.ts         ← hydrateInboundAttachments / transcribeAudioFile
├── admin/
│   ├── command.ts       ← /vocechatctl 命令处理
│   ├── panel.ts         ← 面板渲染逻辑
│   └── telegram.ts      ← Telegram 投递（移到 src/telegram-panel-delivery.ts）
├── store.ts             ← 面板状态（移到 src/panel-store.ts）
└── index.ts             ← 插件入口，只做注册和组合
```

### 7.2 ⚠️ SDK 硬编码路径

```typescript
// 当前做法 —— 硬编码绝对路径
import { xxx } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/mattermost.js";
```

**问题**：OpenClaw 升级后路径可能变化，插件会立即报错。

**建议**：改用 `import { xxx } from "openclaw/plugin-sdk"` 统一导入，或通过 `openclaw plugin sdk --info` 动态获取路径。

### 7.3 ⚠️ Panel Store 文件竞写

`panel-store.ts` 使用同步文件写入，多进程场景下会丢失数据。

**建议**：迁移到 `lockfile` + JSON，或直接使用内存存储（TTL 短，生产可接受）。

### 7.4 ⚠️ 语音转写依赖外部脚本

`transcribeAudioFile()` 调用 `~/.openclaw/workspace/scripts/sherpa_asr.py`，该脚本需要：
- Python 环境
- Sherpa-ONNX 模型
- SiliconFlow API Key

**问题**：如果脚本不存在或路径错误，静默失败（返回空 `transcription`），无报错提示。

### 7.5 ⚠️ 配置合并继承链复杂

`resolveVoceChatAccount()` 的合并逻辑容易混淆：
- 顶层 `channels.vocechat` 的字段会被账号级 `accounts.<id>` 覆盖
- 但某些字段（如 `accounts`）需要特殊处理（`...baseConfig` 然后解构）

维护者很容易在这里引入 bug。

---

## 8. 配置字段参考

完整 configSchema 定义在 `openclaw.plugin.json` 中，下面是关键字段速查：

### 8.1 基础配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用 |
| `baseUrl` | `string` | — | VoceChat 服务地址 |
| `apiKey` | `string` | — | Bot API Key |
| `defaultTo` | `string` | — | 默认目标，格式 `user:<id>` 或 `group:<id>` |
| `timeoutMs` | `number` | `15000` | HTTP 超时（ms） |

### 8.2 入站配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `inboundEnabled` | `boolean` | `true` | 是否启用 webhook 入站 |
| `inboundAckEnabled` | `boolean` | `false` | 是否发送"已收到"确认 |
| `inboundAckText` | `string` | `"已收到..."` | 确认文本 |
| `inboundParseMode` | `string` | `"balanced"` | 解析模式：`legacy` / `balanced` / `strict` |
| `inboundBlockedTypes` | `string[]` | `["system", "event", ...]` | 屏蔽的消息类型 |
| `inboundMinTextLength` | `number` | `1` | 最小文本长度 |
| `inboundMaxTextLength` | `number` | `4000` | 最大文本长度 |
| `allowFrom` | `string[]` | `[]` | 允许的发送者 UID（私聊） |
| `groupAllowFrom` | `string[]` | `[]` | 允许的发送者 UID（群聊） |

### 8.3 Webhook 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `webhookPath` | `string` | `/vocechat/webhook` | Webhook 路径 |
| `webhookApiKey` | `string` | — | Webhook 鉴权 Key |

### 8.4 多账号配置

```json5
{
  accounts: {
    default: { /* 同上 */ },
    backup: {
      enabled: true,
      baseUrl: "https://backup.example",
      apiKey: "...",
      defaultTo: "user:5"
    }
  }
}
```

### 8.5 管理配置

```json5
{
  management: {
    adminSenderIds: ["telegram:123456789", "vocechat:user:1"],
    panelStateFile: "~/.openclaw/.../panels.json",
    quickTargets: {
      users: ["user:2", "user:5"],
      groups: ["group:1001"]
    }
  }
}
```

---

## 9. SDK 兼容性与依赖

### 9.1 当前 SDK 导入方式

```typescript
// 来自插件内部编译后的 dist/index.js
// 或者是通过 OpenClaw 内置的 SDK 模块
import { registerPluginHttpRoute } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/mattermost.js";
```

### 9.2 OpenClaw 版本兼容性

| 插件版本 | 测试通过的 OpenClaw | 备注 |
|----------|-------------------|------|
| 0.4.9 | 2026.3.24 | SDK API 变更，`registerPluginHttpRoute` 等函数路径可能不同 |

### 9.3 运行时依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `undici` | `^7.16.0` | Telegram 代理支持 |
| `typescript` | `^5.9.2` | 开发时编译 |
| `@types/node` | `^24.5.2` | TypeScript 类型 |

### 9.4 外部依赖

| 依赖 | 路径 | 用途 |
|------|------|------|
| Sherpa-ONNX 脚本 | `~/.openclaw/workspace/scripts/sherpa_asr.py` | 语音转写 |

---

## 快速命令参考

```bash
# 构建插件
npm run build

# 健康检查
./scripts/doctor.sh

# 安装插件
./scripts/install.sh --base-url https://... --api-key KEY --default-to user:2

# 同步代码到扩展目录
sh ./scripts/sync-to-root-extension.sh

# 发送测试消息
sh scripts/vocechat-send.sh --to user:2 --text "test"

# 发送附件
sh scripts/vocechat-send.sh --to user:2 --text "附件" --file /path/to/file.pdf
```

---

*文档版本：2026-03-26（基于 v0.4.9）*
