import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { registerPluginHttpRoute, loadOutboundMediaFromUrl } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/mattermost.js";
import { DEFAULT_WEBHOOK_BODY_TIMEOUT_MS, DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/infra-runtime.js";
import { createReplyPrefixOptions } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/channel-runtime.js";
import { createNormalizedOutboundDeliverer, formatTextWithAttachmentLinks, resolveOutboundMediaUrls } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/irc.js";
import { readJsonBodyWithLimit } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/feishu.js";
import { writeJsonFileAtomically } from "/usr/lib/node_modules/openclaw/dist/plugin-sdk/json-store.js";
import type {
  ChannelOutboundContext,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  OutboundDeliveryResult,
  PluginCommandContext,
  PluginRuntime,
  ReplyPayload,
} from "openclaw/plugin-sdk";

import { ControlPanelStore } from "./src/panel-store.js";
import { parseTelegramTarget, TelegramPanelDelivery, type TelegramInlineKeyboardButton } from "./src/telegram-panel-delivery.js";

const CHANNEL_ID = "vocechat";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_PRIVATE_PATH_TEMPLATE = "/api/bot/send_to_user/{id}";
const DEFAULT_GROUP_PATH_TEMPLATE = "/api/bot/send_to_group/{id}";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_WEBHOOK_PATH = "/vocechat/webhook";
const DEFAULT_INBOUND_ACK_TEXT = "已收到，正在处理中...";
const DEFAULT_INBOUND_BLOCKED_TYPES = ["system", "event", "notice", "typing", "status", "reaction", "like"];
const RECENT_MESSAGE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MAX_INBOUND_IMAGE_ATTACHMENTS = 8;
const INBOUND_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);
const ALLOWED_INBOUND_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
]);
const IMAGE_TYPE_KEYWORDS = new Set(["image", "img", "photo", "picture", "pic", "snapshot"]);

// Audio support constants
const INBOUND_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".webm",
  ".amr",
]);

const ALLOWED_INBOUND_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/oga",
  "audio/mp4",
  "audio/m4a",
  "audio/aac",
  "audio/flac",
  "audio/opus",
  "audio/webm",
  "audio/amr",
]);

const AUDIO_TYPE_KEYWORDS = new Set(["audio", "voice", "voice_message", "voice_message_v2", "audio_message"]);

type InboundParseMode = "legacy" | "balanced" | "strict";

type VoceChatAccountConfig = {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  privatePathTemplate?: string;
  groupPathTemplate?: string;
  ackReaction?: string;
  defaultTo?: string;
  timeoutMs?: number;
  inboundEnabled?: boolean;
  inboundAckEnabled?: boolean;
  inboundAckText?: string;
  inboundParseMode?: InboundParseMode;
  inboundBlockedTypes?: unknown;
  inboundMinTextLength?: number;
  inboundMaxTextLength?: number;
  inboundAllowTypelessText?: boolean;
  inboundParseDebug?: boolean;
  webhookPath?: string;
  webhookApiKey?: string;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
};

type VoceChatGroupConfig = {
  requireMention?: boolean;
};

type VoceChatChannelConfig = VoceChatAccountConfig & {
  accounts?: Record<string, VoceChatAccountConfig>;
  groups?: Record<string, VoceChatGroupConfig>;
};

type VoceChatQuickTargets = {
  users: string[];
  groups: string[];
};

type VoceChatManagementConfig = {
  adminSenderIds: string[];
  panelStateFile: string;
  quickTargets: VoceChatQuickTargets;
};

function resolveVoceChatGroupRequireMention(cfg: OpenClawConfig, accountId: string, groupId: string): boolean {
  const section = getChannelConfig(cfg);
  // Check group-specific config first, then wildcard "*", then top-level requireMention on account
  const groups = asRecord(section.groups);
  const specificGroup = asRecord(groups[groupId]);
  const wildcardGroup = asRecord(groups["*"]);
  const accountRecord = asRecord(section.accounts?.[accountId]) as Record<string, unknown>;
  const channelRecord = section as Record<string, unknown>;

  if (specificGroup.requireMention === true) return true;
  if (specificGroup.requireMention === false) return false;
  if (wildcardGroup.requireMention === true) return true;
  if (wildcardGroup.requireMention === false) return false;
  if (accountRecord.requireMention === true) return true;
  if (accountRecord.requireMention === false) return false;
  if (channelRecord.requireMention === true) return true;
  return false;
}

function getMentionPatternsFromConfig(cfg: OpenClawConfig): string[] {
  // Try agents config first (main agent's groupChat.mentionPatterns)
  const agentsRecord = asRecord(cfg.agents);
  const agentsList = Array.isArray(agentsRecord.list) ? agentsRecord.list : [];
  const firstAgent = asRecord(agentsList[0] ?? {});
  const groupChat = asRecord(firstAgent.groupChat);
  const patterns = Array.isArray(groupChat.mentionPatterns) ? groupChat.mentionPatterns : [];
  if (patterns.length > 0) {
    return patterns.map((p) => normalizeString(p)).filter(Boolean);
  }

  // Fallback: try vocechat channel config's groupChat.mentionPatterns
  const vocechatChannel = asRecord(cfg.channels?.vocechat);
  const vocechatGroupChat = asRecord(vocechatChannel?.groupChat);
  const channelPatterns = Array.isArray(vocechatGroupChat?.mentionPatterns) ? vocechatGroupChat.mentionPatterns : [];
  return channelPatterns.map((p) => normalizeString(p)).filter(Boolean);
}

function matchesMentionPattern(text: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    // Handle @username style patterns
    if (pattern.startsWith("@")) {
      const rest = pattern.slice(1);
      // Check for @username anywhere (VoceChat may include @ in the message text)
      const escaped = rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (text.includes(pattern) || new RegExp(`@${escaped}`).test(text)) {
        return true;
      }
    } else {
      // Plain name pattern - check if it appears as a distinct token/segment
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (text.includes(pattern) || new RegExp(`[@\\s]${escaped}[@\\s.,!?。？！]|$`).test(text)) {
        return true;
      }
    }
  }
  return false;
}

type ResolvedAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  apiKey: string;
  privatePathTemplate: string;
  groupPathTemplate: string;
  defaultTo?: string;
  timeoutMs: number;
  inboundEnabled: boolean;
  inboundAckEnabled: boolean;
  inboundAckText: string;
  inboundParseMode: InboundParseMode;
  inboundBlockedTypes: string[];
  inboundMinTextLength: number;
  inboundMaxTextLength: number;
  inboundAllowTypelessText: boolean;
  inboundParseDebug: boolean;
  webhookPath: string;
  webhookApiKey?: string;
  allowFrom: string[];
  groupAllowFrom: string[];
};

type TargetKind = "user" | "group";
type ParsedTarget = {
  kind: TargetKind;
  id: string;
};

type VoceChatHttpResponse = {
  status: number;
  ok: boolean;
  body: string;
};

type InboundAttachment = {
  kind: "image" | "audio";
  messageId: string;
  source: string;
  attachmentId?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  localFile?: string;
  downloadError?: string;
  transcription?: string;
  transcriptionError?: string;
};

type InboundEvent = {
  messageId: string;
  fromUid: string;
  chatType: "direct" | "group";
  conversationId: string;
  groupId?: string;
  text: string;
  originalText: string;
  timestamp: number;
  replyTarget: string;
  attachments: InboundAttachment[];
  imageUrls: string[];
  localFiles: string[];
};

let runtimeRef: PluginRuntime | null = null;
const activeRouteUnregisters = new Map<string, () => void>();
const recentOutboundMessageIds = new Map<string, number>();
const recentInboundMessageIds = new Map<string, number>();
// Content-based deduplication for voice messages (VoceChat sends same voice with different messageIds)
const recentVoiceSignatures = new Map<string, number>();

function setVoceChatRuntime(runtime: PluginRuntime): void {
  runtimeRef = runtime;
}

function getVoceChatRuntime(): PluginRuntime {
  if (!runtimeRef) throw new Error("vocechat runtime not initialized");
  return runtimeRef;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "bigint") return value.toString();
  return normalizeString(value);
}

function parseTimestampMs(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  if (raw < 10_000_000_000) return Math.trunc(raw * 1000);
  return Math.trunc(raw);
}

function firstNonEmptyString(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function firstNonEmptyId(candidates: unknown[]): string {
  for (const candidate of candidates) {
    const parsed = parseId(candidate);
    if (parsed) return parsed;
  }
  return "";
}

function clipAuditSegment(value: unknown, max = 120): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeInboundType(value: unknown): string {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return "";
  return normalized.replace(/\s+/g, "").replace(/-/g, "_");
}

function isSupportedInboundTextType(typeValue: unknown): boolean {
  const normalizedType = normalizeInboundType(typeValue);
  if (!normalizedType) return true;

  const supportedTypes = new Set([
    "normal",
    "reply",
    "text",
    "text_message",
    "plain_message",
    "plain",
    "plaintext",
    "markdown",
    "md",
    "message_text",
  ]);

  return supportedTypes.has(normalizedType) || normalizedType.startsWith("text/");
}

function summarizeInboundPayloadForAudit(raw: unknown, accountId: string): string {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const typeValues = [detail.type, detail.message_type, payload.type, payload.message_type]
    .map((value) => normalizeString(value))
    .filter(Boolean);
  const uniqueTypes = Array.from(new Set(typeValues));

  const textCandidates = [detail.content, detail.text, payload.content, payload.text, detail.preview, payload.preview];
  const hasTextField = textCandidates.some((value) => value !== undefined && value !== null);

  const topKeys = Object.keys(payload).join(",");
  const detailKeys = Object.keys(detail).join(",");
  const attachmentKeys = Object.keys({ ...payload, ...detail }).filter((key) =>
    /(attachment|file|media|image|photo|picture|pic)/i.test(key),
  );

  return [
    `account=${clipAuditSegment(accountId)}`,
    `types=${clipAuditSegment(uniqueTypes.join("|"))}`,
    `hasTextField=${hasTextField ? "yes" : "no"}`,
    `attachmentKeys=${clipAuditSegment(attachmentKeys.join("|"))}`,
    `topKeys=${clipAuditSegment(topKeys)}`,
    `detailKeys=${clipAuditSegment(detailKeys)}`,
  ].join(" ");
}

function normalizeAccountId(input?: string | null): string {
  const raw = normalizeString(input);
  return raw || DEFAULT_ACCOUNT_ID;
}

function sanitizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/g, "");
}

function parseTimeoutMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(Math.min(120000, numeric));
}

function parseAllowEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseId(entry))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInboundParseMode(value: unknown): InboundParseMode {
  const raw = normalizeString(value).toLowerCase();
  if (raw === "legacy" || raw === "strict") return raw;
  return "balanced";
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < min || n > max) return fallback;
  return n;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseInboundTypeEntries(value: unknown): string[] {
  const entries = parseAllowEntries(value).map((entry) => normalizeInboundType(entry)).filter(Boolean);
  return Array.from(new Set(entries));
}

function normalizeInboundText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeMimeType(value: unknown): string {
  return normalizeString(value).toLowerCase().split(";")[0]?.trim() || "";
}

function parseOptionalSize(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.trunc(numeric);
}

function isAllowedInboundImageMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value);
  if (!normalized) return false;
  return ALLOWED_INBOUND_IMAGE_MIME_TYPES.has(normalized);
}

function inferMimeTypeFromExtension(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return undefined;
  }
}

function inferExtensionFromMimeType(mimeType: string): string {
  switch (normalizeMimeType(mimeType)) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tif";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    default:
      return "";
  }
}

function sanitizePathSegment(input: string, fallback: string, maxLength = 120): string {
  const raw = input.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ");
  const normalized = raw.replace(/\.+$/g, "").trim();
  if (!normalized || normalized === "." || normalized === "..") return fallback;
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function sanitizeFileName(input: string, fallback = "attachment"): string {
  return sanitizePathSegment(path.basename(input), fallback);
}

function isImageExtension(ext: string): boolean {
  return INBOUND_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

function isAudioExtension(ext: string): boolean {
  return INBOUND_AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

function isAllowedInboundAudioMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value);
  if (!normalized) return false;
  return ALLOWED_INBOUND_AUDIO_MIME_TYPES.has(normalized);
}

function isAudioTypeKeyword(value: unknown): boolean {
  const normalized = normalizeInboundType(value);
  if (!normalized) return false;
  if (AUDIO_TYPE_KEYWORDS.has(normalized)) return true;
  return normalized.startsWith("audio") || normalized.startsWith("voice");
}

function inferAudioMimeTypeFromExtension(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".opus":
      return "audio/opus";
    case ".webm":
      return "audio/webm";
    case ".amr":
      return "audio/amr";
    default:
      return undefined;
  }
}

function inferAudioExtensionFromMimeType(mimeType: string): string {
  switch (normalizeMimeType(mimeType)) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
    case "audio/oga":
      return ".ogg";
    case "audio/mp4":
    case "audio/m4a":
      return ".m4a";
    case "audio/aac":
      return ".aac";
    case "audio/flac":
      return ".flac";
    case "audio/opus":
      return ".opus";
    case "audio/webm":
      return ".webm";
    case "audio/amr":
      return ".amr";
    default:
      return "";
  }
}

function isLikelyAudioReference(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  const ext = extractExtensionFromPathLike(normalized);
  if (isAudioExtension(ext)) return true;
  return /\/audio(s)?\//i.test(normalized) || /\/voice(s)?\//i.test(normalized);
}

function extractExtensionFromPathLike(value: string): string {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  try {
    const parsed = normalized.includes("://") ? new URL(normalized) : new URL(normalized, "https://vocechat.local");
    return path.extname(parsed.pathname || "");
  } catch {
    return path.extname(normalized.split("?")[0] || "");
  }
}

function isLikelyVoceChatStoredFilePath(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  if (normalized.includes("?") || normalized.includes("#")) return false;
  if (normalized.startsWith("/")) return false;
  return /^\d{4}\/\d{1,2}\/\d{1,2}\/[A-Za-z0-9][A-Za-z0-9-]{15,}$/.test(normalized);
}

function isLikelyImageReference(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  const ext = extractExtensionFromPathLike(normalized);
  if (isImageExtension(ext)) return true;
  return /\/image(s)?\//i.test(normalized);
}

function isImageTypeKeyword(value: unknown): boolean {
  const normalized = normalizeInboundType(value);
  if (!normalized) return false;
  if (IMAGE_TYPE_KEYWORDS.has(normalized)) return true;
  return normalized.startsWith("image") || normalized.startsWith("photo") || normalized.startsWith("picture");
}

function resolveInboundMediaUrl(account: ResolvedAccount, rawUrl: string): string {
  const normalized = normalizeString(rawUrl);
  if (!normalized) return "";
  if (isLikelyVoceChatStoredFilePath(normalized)) {
    if (!account.baseUrl) return normalized;
    return `${account.baseUrl}/api/resource/file?file_path=${encodeURIComponent(normalized)}`;
  }
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (normalized.startsWith("//")) {
    try {
      return new URL(account.baseUrl).protocol + normalized;
    } catch {
      return `https:${normalized}`;
    }
  }
  if (!account.baseUrl) return normalized;
  if (normalized.startsWith("/")) return `${account.baseUrl}${normalized}`;
  return `${account.baseUrl}/${normalized.replace(/^\.?\//, "")}`;
}

function extractImageReferencesFromText(raw: string): string[] {
  const normalized = normalizeString(raw);
  if (!normalized) return [];

  const matches = new Set<string>();
  const markdownImage = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const bareRef = /(?:https?:\/\/|\/)[^\s<>()]+/g;

  for (const match of normalized.matchAll(markdownImage)) {
    const candidate = normalizeString(match[1]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }
  for (const match of normalized.matchAll(htmlImage)) {
    const candidate = normalizeString(match[1]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }
  for (const match of normalized.matchAll(bareRef)) {
    const candidate = normalizeString(match[0]);
    if (candidate && isLikelyImageReference(candidate)) matches.add(candidate);
  }

  return [...matches];
}

function stripImageReferencesFromText(raw: string): string {
  if (!raw) return "";
  return normalizeInboundText(
    raw
      .replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, " ")
      .replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, " ")
      .replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\/[A-Za-z0-9][A-Za-z0-9-]{15,}\b/g, " ")
      .replace(/(?:https?:\/\/|\/)[^\s<>()]+/g, (segment) => (isLikelyImageReference(segment) ? " " : segment)),
  );
}

function dedupeInboundAttachments(attachments: InboundAttachment[]): InboundAttachment[] {
  const seen = new Set<string>();
  const deduped: InboundAttachment[] = [];

  for (const attachment of attachments) {
    const key = [
      attachment.attachmentId || "-",
      attachment.url || "-",
      attachment.fileName || "-",
      attachment.mimeType || "-",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(attachment);
    if (deduped.length >= MAX_INBOUND_IMAGE_ATTACHMENTS) break;
  }

  return deduped;
}

function collectInboundAttachmentCandidates(
  value: unknown,
  source: string,
  results: Array<{ source: string; value: unknown }>,
  depth = 0,
): void {
  if (value === undefined || value === null || depth > 3) return;

  if (Array.isArray(value)) {
    for (const entry of value) collectInboundAttachmentCandidates(entry, source, results, depth + 1);
    return;
  }

  if (typeof value === "string") {
    const refs = extractImageReferencesFromText(value);
    if (refs.length === 0 && !isLikelyImageReference(value)) return;
    if (refs.length === 0) {
      results.push({ source, value });
      return;
    }
    for (const ref of refs) results.push({ source: `${source}.text`, value: ref });
    return;
  }

  if (typeof value !== "object") return;

  results.push({ source, value });
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (!/(attachment|file|media|image|photo|picture|pic|preview|url|path)/i.test(key)) continue;
    collectInboundAttachmentCandidates(entry, `${source}.${key}`, results, depth + 1);
  }
}

function parseInboundAttachmentCandidate(params: {
  value: unknown;
  source: string;
  messageId: string;
  account: ResolvedAccount;
}): InboundAttachment[] {
  const { value, source, messageId, account } = params;

  if (typeof value === "string") {
    // Check for audio first
    if (isLikelyAudioReference(value)) {
      const resolvedUrl = resolveInboundMediaUrl(account, value);
      if (resolvedUrl) {
        return [{
          kind: "audio" as const,
          messageId,
          source,
          url: resolvedUrl,
        }];
      }
    }
    // Then check for image
    const refs = extractImageReferencesFromText(value);
    const candidates = refs.length > 0 ? refs : [value];
    return candidates
      .map((candidate) => resolveInboundMediaUrl(account, candidate))
      .filter((candidate) => isLikelyImageReference(candidate))
      .map((candidate) => ({
        kind: "image" as const,
        messageId,
        source,
        url: candidate,
      }));
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];
  const properties = asRecord(record.properties);

  const nestedCandidates: InboundAttachment[] = [];
  for (const key of ["attachment", "attachments", "file", "files", "image", "images", "media", "medias", "audio", "voice"]) {
    if (!hasOwn(record, key)) continue;
    const nested: Array<{ source: string; value: unknown }> = [];
    collectInboundAttachmentCandidates(record[key], `${source}.${key}`, nested, 1);
    for (const candidate of nested) {
      nestedCandidates.push(
        ...parseInboundAttachmentCandidate({
          value: candidate.value,
          source: candidate.source,
          messageId,
          account,
        }),
      );
    }
  }
  if (nestedCandidates.length > 0) return nestedCandidates;

  const mimeType = normalizeMimeType(
    firstNonEmptyString([
      record.mime,
      record.mime_type,
      record.mimeType,
      record.content_type,
      record.contentType,
      record.file_type,
      record.fileType,
      properties.mime,
      properties.mime_type,
      properties.mimeType,
      properties.content_type,
      properties.contentType,
      properties.file_type,
      properties.fileType,
    ]),
  );
  const fileName = firstNonEmptyString([
    record.file_name,
    record.fileName,
    record.filename,
    record.name,
    record.title,
    properties.file_name,
    properties.fileName,
    properties.filename,
    properties.name,
    properties.title,
  ]);
  const rawUrl = firstNonEmptyString([
    record.url,
    record.src,
    record.href,
    record.path,
    record.file_path,
    record.filePath,
    record.download_url,
    record.downloadUrl,
    record.image_url,
    record.imageUrl,
    record.preview_url,
    record.previewUrl,
    record.content,
    properties.url,
    properties.src,
    properties.href,
    properties.path,
    properties.file_path,
    properties.filePath,
    properties.download_url,
    properties.downloadUrl,
    properties.image_url,
    properties.imageUrl,
    properties.preview_url,
    properties.previewUrl,
  ]);
  const url = rawUrl ? resolveInboundMediaUrl(account, rawUrl) : "";
  const attachmentId = firstNonEmptyId([
    record.attachment_id,
    record.attachmentId,
    record.file_id,
    record.fileId,
    record.image_id,
    record.imageId,
    record.id,
    properties.attachment_id,
    properties.attachmentId,
    properties.file_id,
    properties.fileId,
    properties.image_id,
    properties.imageId,
    properties.id,
  ]);
  if (!url && !attachmentId) return [];
  const sizeBytes =
    parseOptionalSize(record.size) ??
    parseOptionalSize(record.file_size) ??
    parseOptionalSize(record.fileSize) ??
    parseOptionalSize(record.bytes) ??
    parseOptionalSize(properties.size) ??
    parseOptionalSize(properties.file_size) ??
    parseOptionalSize(properties.fileSize) ??
    parseOptionalSize(properties.bytes);

  // Check for audio first
  const looksLikeAudio =
    isAllowedInboundAudioMimeType(mimeType) ||
    isAudioTypeKeyword(record.type) ||
    isAudioTypeKeyword(record.message_type) ||
    isAudioTypeKeyword(record.kind) ||
    isAudioTypeKeyword(record.content_type) ||
    isAudioTypeKeyword(properties.type) ||
    isAudioTypeKeyword(properties.message_type) ||
    isAudioTypeKeyword(properties.kind) ||
    isAudioTypeKeyword(properties.content_type) ||
    isLikelyAudioReference(url) ||
    isLikelyAudioReference(fileName);

  if (looksLikeAudio) {
    return [
      {
        kind: "audio",
        messageId,
        source,
        attachmentId: attachmentId || undefined,
        url: url || undefined,
        fileName: fileName || undefined,
        mimeType: mimeType || undefined,
        sizeBytes,
      },
    ];
  }

  // Then check for image
  const looksLikeImage =
    isAllowedInboundImageMimeType(mimeType) ||
    isImageTypeKeyword(record.type) ||
    isImageTypeKeyword(record.message_type) ||
    isImageTypeKeyword(record.kind) ||
    isImageTypeKeyword(record.content_type) ||
    isImageTypeKeyword(properties.type) ||
    isImageTypeKeyword(properties.message_type) ||
    isImageTypeKeyword(properties.kind) ||
    isImageTypeKeyword(properties.content_type) ||
    isLikelyImageReference(url) ||
    isLikelyImageReference(fileName);

  if (!looksLikeImage) return [];

  return [
    {
      kind: "image",
      messageId,
      source,
      attachmentId: attachmentId || undefined,
      url: url || undefined,
      fileName: fileName || undefined,
      mimeType: mimeType || undefined,
      sizeBytes,
    },
  ];
}

function extractInboundAttachments(raw: unknown, messageId: string, account: ResolvedAccount): InboundAttachment[] {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const candidates: Array<{ source: string; value: unknown }> = [];

  const roots: Array<{ label: string; value: unknown }> = [
    { label: "payload", value: payload },
    { label: "detail", value: detail },
    { label: "payload", value: payload.attachments },
    { label: "payload", value: payload.attachment },
    { label: "payload", value: payload.files },
    { label: "payload", value: payload.file },
    { label: "payload", value: payload.media },
    { label: "payload", value: payload.medias },
    { label: "payload", value: payload.images },
    { label: "payload", value: payload.image },
    { label: "payload", value: payload.imageUrls },
    { label: "payload", value: payload.image_urls },
    { label: "payload", value: payload.properties },
    { label: "payload", value: payload.content },
    { label: "payload", value: payload.preview },
    { label: "detail", value: detail.attachments },
    { label: "detail", value: detail.attachment },
    { label: "detail", value: detail.files },
    { label: "detail", value: detail.file },
    { label: "detail", value: detail.media },
    { label: "detail", value: detail.medias },
    { label: "detail", value: detail.images },
    { label: "detail", value: detail.image },
    { label: "detail", value: detail.imageUrls },
    { label: "detail", value: detail.image_urls },
    { label: "detail", value: detail.properties },
    { label: "detail", value: detail.content },
    { label: "detail", value: detail.preview },
  ];

  for (const root of roots) {
    collectInboundAttachmentCandidates(root.value, root.label, candidates);
  }

  const parsed = candidates.flatMap((candidate) =>
    parseInboundAttachmentCandidate({
      value: candidate.value,
      source: candidate.source,
      messageId,
      account,
    }),
  );
  return dedupeInboundAttachments(parsed);
}

function normalizeWebhookPath(value: unknown): string {
  const raw = normalizeString(value);
  if (!raw) return DEFAULT_WEBHOOK_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function nowMs(): number {
  return Date.now();
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeMessageKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`;
}

function cleanupRecentMessageCache(cache: Map<string, number>): void {
  const cutoff = nowMs() - RECENT_MESSAGE_TTL_MS;
  for (const [key, ts] of cache.entries()) {
    if (ts < cutoff) cache.delete(key);
  }
}

function rememberRecentMessage(cache: Map<string, number>, key: string): void {
  cleanupRecentMessageCache(cache);
  cache.set(key, nowMs());
}

function hasRecentMessage(cache: Map<string, number>, key: string): boolean {
  cleanupRecentMessageCache(cache);
  const seenAt = cache.get(key);
  if (!seenAt) return false;
  return nowMs() - seenAt <= RECENT_MESSAGE_TTL_MS;
}

function getChannelConfig(cfg: OpenClawConfig): VoceChatChannelConfig {
  return asRecord(cfg.channels?.[CHANNEL_ID]) as VoceChatChannelConfig;
}

function listVoceChatAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelConfig(cfg);
  const accounts = asRecord(section.accounts);
  const ids = Object.keys(accounts).map((id) => normalizeAccountId(id));
  if (!ids.includes(DEFAULT_ACCOUNT_ID)) ids.unshift(DEFAULT_ACCOUNT_ID);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

function resolveVoceChatAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const resolvedAccountId = normalizeAccountId(accountId);
  const section = getChannelConfig(cfg);
  const accounts = asRecord(section.accounts);
  const account = asRecord(accounts[resolvedAccountId]);

  const { accounts: _ignored, ...baseConfig } = section;
  const merged = {
    ...asRecord(baseConfig),
    ...account,
  };

  const baseEnabled = section.enabled !== false;
  const accountEnabled = merged.enabled !== false;

  return {
    accountId: resolvedAccountId,
    enabled: baseEnabled && accountEnabled,
    name: normalizeString(merged.name) || undefined,
    baseUrl: sanitizeBaseUrl(normalizeString(merged.baseUrl)),
    apiKey: normalizeString(merged.apiKey),
    privatePathTemplate: normalizeString(merged.privatePathTemplate) || DEFAULT_PRIVATE_PATH_TEMPLATE,
    groupPathTemplate: normalizeString(merged.groupPathTemplate) || DEFAULT_GROUP_PATH_TEMPLATE,
    defaultTo: normalizeString(merged.defaultTo) || undefined,
    timeoutMs: parseTimeoutMs(merged.timeoutMs),
    inboundEnabled: merged.inboundEnabled !== false,
    inboundAckEnabled: merged.inboundAckEnabled === true,
    inboundAckText: normalizeString(merged.inboundAckText) || DEFAULT_INBOUND_ACK_TEXT,
    inboundParseMode: parseInboundParseMode(merged.inboundParseMode),
    inboundBlockedTypes: parseInboundTypeEntries(merged.inboundBlockedTypes ?? DEFAULT_INBOUND_BLOCKED_TYPES),
    inboundMinTextLength: parseBoundedInt(merged.inboundMinTextLength, 1, 1, 200),
    inboundMaxTextLength: parseBoundedInt(merged.inboundMaxTextLength, 4000, 50, 20000),
    inboundAllowTypelessText: parseBoolean(merged.inboundAllowTypelessText, true),
    inboundParseDebug: parseBoolean(merged.inboundParseDebug, false),
    webhookPath: normalizeWebhookPath(merged.webhookPath),
    webhookApiKey: normalizeString(merged.webhookApiKey) || undefined,
    allowFrom: parseAllowEntries(merged.allowFrom),
    groupAllowFrom: parseAllowEntries(merged.groupAllowFrom),
  };
}

function resolveVoceChatManagement(cfg: OpenClawConfig): VoceChatManagementConfig {
  const section = getChannelConfig(cfg);
  const management = asRecord((section as Record<string, unknown>).management);
  const panelStateFile = normalizeString(management.panelStateFile) || path.join(os.homedir(), ".local", "state", "openclaw-vocechat-channel", "panels.json");
  const adminSenderIds = parseAllowEntries(management.adminSenderIds);
  return {
    adminSenderIds,
    panelStateFile,
    quickTargets: resolveVoceChatQuickTargets(cfg, management, adminSenderIds),
  };
}

function resolveVoceChatQuickTargets(
  cfg: OpenClawConfig,
  managementSection: Record<string, unknown>,
  adminSenderIds: string[],
): VoceChatQuickTargets {
  const quickTargets = asRecord(managementSection.quickTargets);
  const configuredUsers = normalizeVoceChatTargetEntries(parseAllowEntries(quickTargets.users), "user");
  const configuredGroups = normalizeVoceChatTargetEntries(parseAllowEntries(quickTargets.groups), "group");
  if (configuredUsers.length > 0 || configuredGroups.length > 0) {
    return { users: configuredUsers, groups: configuredGroups };
  }

  const inferredUsers = new Set<string>();
  const inferredGroups = new Set<string>();

  const addTarget = (raw: string | undefined) => {
    const parsed = parseTarget(raw ?? "");
    if (!parsed) return;
    const normalized = `${parsed.kind}:${parsed.id}`;
    if (parsed.kind === "user") inferredUsers.add(normalized);
    if (parsed.kind === "group") inferredGroups.add(normalized);
  };

  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  addTarget(defaultAccount.defaultTo);

  for (const accountId of listVoceChatAccountIds(cfg)) {
    addTarget(resolveVoceChatAccount(cfg, accountId).defaultTo);
  }

  for (const senderId of adminSenderIds) {
    const match = senderId.match(/^vocechat:user:(.+)$/i);
    if (match?.[1]) inferredUsers.add(`user:${match[1]}`);
  }

  return {
    users: [...inferredUsers],
    groups: [...inferredGroups],
  };
}

function normalizeVoceChatTargetEntries(entries: string[], kind: TargetKind): string[] {
  const normalized = new Set<string>();
  for (const entry of entries) {
    const parsed = parseTarget(entry);
    if (!parsed || parsed.kind !== kind) continue;
    normalized.add(`${parsed.kind}:${parsed.id}`);
  }
  return [...normalized];
}

function resolveHostConfigFilePath(): string {
  const explicitPath = normalizeString(process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH);
  if (explicitPath) return expandHomePath(explicitPath);

  const explicitStateDir = normalizeString(process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR);
  const stateDir = explicitStateDir ? expandHomePath(explicitStateDir) : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveOpenClawStateDir(): string {
  const explicitStateDir = normalizeString(process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR);
  return explicitStateDir ? expandHomePath(explicitStateDir) : path.join(os.homedir(), ".openclaw");
}

function resolveInboundMediaRootDir(): string {
  // Keep inbound media inside the OpenClaw workspace so built-in file tools can read it.
  return path.join(resolveOpenClawStateDir(), "workspace", "media", "inbound", "vocechat");
}

function formatInboundDatePath(timestamp: number): string[] {
  const date = new Date(timestamp || Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day];
}

function buildInboundMediaMessageDir(event: InboundEvent): string {
  return path.join(
    resolveInboundMediaRootDir(),
    ...formatInboundDatePath(event.timestamp),
    sanitizePathSegment(event.messageId, "message"),
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readWebStreamWithLimit(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel("too_large");
      throw new Error(`attachment exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function requestBinaryViaFetch(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  const response = await fetch(params.url, {
    method: "GET",
    headers: params.headers,
    signal: params.signal,
  });
  const contentType = normalizeMimeType(response.headers.get("content-type"));
  const contentLength = parseOptionalSize(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > params.maxBytes) {
    throw new Error(`attachment exceeds ${params.maxBytes} bytes`);
  }
  const body = await readWebStreamWithLimit(response.body, params.maxBytes);
  return {
    status: response.status,
    ok: response.ok,
    body,
    contentType,
    contentLength,
  };
}

async function requestBinaryViaLoopback(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  const parsed = new URL(params.url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = Number(parsed.port || (isHttps ? 443 : 80));

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      const abortError = createAbortError();
      request.destroy(abortError);
      finish(() => reject(abortError));
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...params.headers,
          host: parsed.host,
        },
        servername: isHttps ? parsed.hostname : undefined,
        rejectUnauthorized: isHttps ? true : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const contentType = normalizeMimeType(response.headers["content-type"]);
        const contentLength = parseOptionalSize(response.headers["content-length"]);
        if (contentLength !== undefined && contentLength > params.maxBytes) {
          request.destroy(new Error(`attachment exceeds ${params.maxBytes} bytes`));
          return;
        }

        response.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > params.maxBytes) {
            request.destroy(new Error(`attachment exceeds ${params.maxBytes} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
              body,
              contentType,
              contentLength,
            }),
          );
        });
      },
    );

    request.on("error", (error) => {
      finish(() => reject(error));
    });

    if (params.signal.aborted) {
      handleAbort();
      return;
    }

    params.signal.addEventListener("abort", handleAbort, { once: true });
    request.end();
  });
}

async function requestInboundBinaryResource(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}): Promise<{ status: number; ok: boolean; body: Buffer; contentType: string; contentLength?: number }> {
  if (canUseLoopbackFallback(params.url)) {
    try {
      return await requestBinaryViaLoopback(params);
    } catch (loopbackError) {
      const loopbackDetail = loopbackError instanceof Error ? loopbackError.message : String(loopbackError);
      try {
        return await requestBinaryViaFetch(params);
      } catch (fetchError) {
        const fetchDetail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        throw new Error(
          `[vocechat] attachment request failed via loopback (${loopbackDetail}); configured host fallback failed (${fetchDetail})`,
        );
      }
    }
  }

  try {
    return await requestBinaryViaFetch(params);
  } catch (originalError) {
    if (!canUseLoopbackFallback(params.url)) throw originalError;

    try {
      return await requestBinaryViaLoopback(params);
    } catch (fallbackError) {
      const primaryDetail = originalError instanceof Error ? originalError.message : String(originalError);
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `[vocechat] attachment request failed via configured host (${primaryDetail}); loopback fallback failed (${fallbackDetail})`,
      );
    }
  }
}

function inferInboundAttachmentFileName(attachment: InboundAttachment, contentType?: string): string {
  const fallbackExt =
    extractExtensionFromPathLike(attachment.fileName || "") ||
    extractExtensionFromPathLike(attachment.url || "") ||
    (attachment.kind === "audio"
      ? inferAudioExtensionFromMimeType(contentType || attachment.mimeType || "")
      : inferExtensionFromMimeType(contentType || attachment.mimeType || "")) ||
    (attachment.kind === "audio" ? ".ogg" : ".bin");
  const baseName = sanitizeFileName(attachment.fileName || path.basename(attachment.url || "") || (attachment.kind === "audio" ? "audio" : "attachment"));
  const parsed = path.parse(baseName);
  const ext = attachment.kind === "audio"
    ? (isAudioExtension(parsed.ext || fallbackExt) ? parsed.ext || fallbackExt : fallbackExt)
    : (isImageExtension(parsed.ext || fallbackExt) ? parsed.ext || fallbackExt : fallbackExt);
  const name = sanitizePathSegment(parsed.name || (attachment.kind === "audio" ? "audio" : "attachment"), attachment.kind === "audio" ? "audio" : "attachment");
  return `${name}${ext}`;
}

// ASR (Automatic Speech Recognition) transcription using Sherpa-ONNX (local Python)
async function transcribeAudioFile(params: {
  audioPath: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<{ text: string; error?: string }> {
  const { audioPath, logger } = params;

  // Use Python Sherpa-ONNX script
  const scriptPath = path.join(os.homedir(), ".openclaw", "workspace", "scripts", "sherpa_asr.py");

  try {
    const { execFile } = await import("node:child_process");
    
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile("python3", [scriptPath, audioPath], { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    const transcription = normalizeString(result.stdout);
    
    if (transcription.startsWith("ERROR:") || !transcription) {
      return { text: "", error: transcription || "Empty transcription" };
    }

    logger?.info?.(`[vocechat] Sherpa-ONNX transcription: "${transcription}"`);
    return { text: transcription };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[vocechat] Sherpa-ONNX failed: ${detail}`);
    return { text: "", error: detail };
  }
}

// Voice learning corrections based on user patterns
// Only correct ASR misrecognitions, don't guess user intent
// DISABLED per user request - return original text
function applyVoiceLearningCorrections(text: string, logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }): string {
  // User requested no automatic corrections
  return text;
}

function buildInboundAttachmentSignature(attachments: InboundAttachment[]): string {
  return attachments
    .map((attachment) =>
      [
        attachment.attachmentId || "-",
        attachment.url || "-",
        attachment.fileName || "-",
        attachment.mimeType || "-",
        attachment.sizeBytes ?? "-",
      ].join("|"),
    )
    .join("||");
}

async function hydrateInboundAttachments(params: {
  event: InboundEvent;
  account: ResolvedAccount;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<InboundEvent> {
  const { event, account, logger } = params;
  if (event.attachments.length === 0) return event;

  const messageDir = buildInboundMediaMessageDir(event);
  const manifestPath = path.join(messageDir, "manifest.json");
  const attachmentSignature = buildInboundAttachmentSignature(event.attachments);

  try {
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = asRecord(JSON.parse(manifestRaw));
    const manifestSignature = normalizeString(manifest.signature);
    const manifestFiles = Array.isArray(manifest.attachments) ? manifest.attachments : [];
    if (manifestSignature === attachmentSignature && manifestFiles.length === event.attachments.length) {
      const reusedAttachments: InboundAttachment[] = [];
      let allFilesExist = true;
      for (let index = 0; index < manifestFiles.length; index += 1) {
        const saved = asRecord(manifestFiles[index]);
        const localFile = normalizeString(saved.localFile);
        if (!localFile || !(await fileExists(localFile))) {
          allFilesExist = false;
          break;
        }
        reusedAttachments.push({
          ...event.attachments[index],
          localFile,
          mimeType: normalizeMimeType(saved.mimeType) || event.attachments[index]?.mimeType,
          fileName: normalizeString(saved.fileName) || event.attachments[index]?.fileName,
          sizeBytes: parseOptionalSize(saved.sizeBytes) ?? event.attachments[index]?.sizeBytes,
        });
      }
      if (allFilesExist) {
        logger?.info?.(
          `[vocechat] inbound attachments reused account=${account.accountId} mid=${event.messageId} count=${reusedAttachments.length} dir=${messageDir}`,
        );
        return {
          ...event,
          attachments: reusedAttachments,
          imageUrls: reusedAttachments.map((attachment) => attachment.url).filter(Boolean) as string[],
          localFiles: reusedAttachments.map((attachment) => attachment.localFile).filter(Boolean) as string[],
        };
      }
    }
  } catch {
    // Ignore missing or invalid manifest and re-download.
  }

  await fs.mkdir(messageDir, { recursive: true });
  const hydratedAttachments: InboundAttachment[] = [];
  const manifestAttachments: Array<Record<string, unknown>> = [];

  for (let index = 0; index < event.attachments.length; index += 1) {
    const attachment = event.attachments[index];
    const url = normalizeString(attachment.url);
    if (!url) {
      const downloadError = "missing_attachment_url";
      hydratedAttachments.push({ ...attachment, downloadError });
      logger?.warn?.(
        `[vocechat] inbound attachment skipped account=${account.accountId} mid=${event.messageId} index=${index} reason=${downloadError}`,
      );
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      continue;
    }

    if (attachment.sizeBytes !== undefined && attachment.sizeBytes > DEFAULT_INBOUND_MEDIA_MAX_BYTES) {
      const downloadError = `attachment exceeds ${DEFAULT_INBOUND_MEDIA_MAX_BYTES} bytes`;
      hydratedAttachments.push({ ...attachment, downloadError });
      logger?.warn?.(
        `[vocechat] inbound attachment rejected account=${account.accountId} mid=${event.messageId} index=${index} reason=${clipAuditSegment(downloadError)}`,
      );
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
    try {
      // Use appropriate accept header based on attachment kind
      const acceptHeader = attachment.kind === "audio"
        ? "audio/*, application/octet-stream;q=0.8, */*;q=0.5"
        : "image/*, application/octet-stream;q=0.8, */*;q=0.5";

      const response = await requestInboundBinaryResource({
        url,
        headers: {
          "x-api-key": account.apiKey,
          accept: acceptHeader,
        },
        signal: controller.signal,
        maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const resolvedMimeType = normalizeMimeType(response.contentType || attachment.mimeType);
      const resolvedFileName = inferInboundAttachmentFileName(attachment, resolvedMimeType);

      // Handle audio attachments
      if (attachment.kind === "audio") {
        const resolvedExtension = extractExtensionFromPathLike(resolvedFileName) || inferAudioExtensionFromMimeType(resolvedMimeType) || ".ogg";
        const inferredMimeType = resolvedMimeType || inferAudioMimeTypeFromExtension(resolvedExtension) || "audio/ogg";

        const targetPath = path.join(messageDir, `${String(index + 1).padStart(2, "0")}-${randomUUID()}${resolvedExtension}`);
        await fs.writeFile(targetPath, response.body);

        // Transcribe audio
        const transcriptionResult = await transcribeAudioFile({
          audioPath: targetPath,
          logger,
        });

        const hydratedAttachment: InboundAttachment = {
          ...attachment,
          kind: "audio",
          fileName: resolvedFileName,
          mimeType: inferredMimeType,
          sizeBytes: response.body.length,
          localFile: targetPath,
          downloadError: undefined,
          transcription: transcriptionResult.text || undefined,
          transcriptionError: transcriptionResult.error || undefined,
        };
        hydratedAttachments.push(hydratedAttachment);
        manifestAttachments.push({
          ...hydratedAttachment,
        });
        logger?.info?.(
          `[vocechat] inbound audio stored account=${account.accountId} mid=${event.messageId} index=${index} path=${targetPath} size=${response.body.length} mime=${clipAuditSegment(inferredMimeType)} transcription="${clipAuditSegment(transcriptionResult.text || "")}"`,
        );
        continue;
      }

      // Handle image attachments
      const resolvedExtension = extractExtensionFromPathLike(resolvedFileName) || inferExtensionFromMimeType(resolvedMimeType);
      const inferredMimeType = resolvedMimeType || inferMimeTypeFromExtension(resolvedExtension) || "";
      if (!isAllowedInboundImageMimeType(inferredMimeType) && !isImageExtension(resolvedExtension)) {
        throw new Error(`unsupported_mime:${resolvedMimeType || "unknown"}`);
      }

      const targetPath = path.join(messageDir, `${String(index + 1).padStart(2, "0")}-${randomUUID()}${resolvedExtension || ".bin"}`);
      await fs.writeFile(targetPath, response.body);

      const hydratedAttachment: InboundAttachment = {
        ...attachment,
        fileName: resolvedFileName,
        mimeType: inferredMimeType || attachment.mimeType,
        sizeBytes: response.body.length,
        localFile: targetPath,
        downloadError: undefined,
      };
      hydratedAttachments.push(hydratedAttachment);
      manifestAttachments.push({
        ...hydratedAttachment,
      });
      logger?.info?.(
        `[vocechat] inbound attachment stored account=${account.accountId} mid=${event.messageId} index=${index} path=${targetPath} size=${response.body.length} mime=${clipAuditSegment(hydratedAttachment.mimeType || "-")}`,
      );
    } catch (error) {
      const downloadError = error instanceof Error ? error.message : String(error);
      hydratedAttachments.push({ ...attachment, downloadError });
      manifestAttachments.push({
        ...attachment,
        downloadError,
      });
      logger?.warn?.(
        `[vocechat] inbound attachment download failed account=${account.accountId} mid=${event.messageId} index=${index} url=${clipAuditSegment(url)} err=${clipAuditSegment(downloadError, 200)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  await writeJsonFileAtomically(manifestPath, {
    messageId: event.messageId,
    signature: attachmentSignature,
    attachments: manifestAttachments,
  });

  return {
    ...event,
    attachments: hydratedAttachments,
    imageUrls: hydratedAttachments.map((attachment) => attachment.url).filter(Boolean) as string[],
    localFiles: hydratedAttachments.map((attachment) => attachment.localFile).filter(Boolean) as string[],
  };
}

function buildInboundAgentBody(event: InboundEvent): string {
  const text = normalizeInboundText(event.text);
  if (event.attachments.length === 0) return text;

  const audioAttachments = event.attachments.filter((a) => a.kind === "audio");
  const imageAttachments = event.attachments.filter((a) => a.kind === "image");
  const localAudio = audioAttachments.filter((a) => a.localFile);
  const localImages = imageAttachments.filter((a) => a.localFile);
  const failedAudio = audioAttachments.filter((a) => !a.localFile);
  const failedImages = imageAttachments.filter((a) => !a.localFile);

  const lines: string[] = [];

  // Handle audio attachments
  if (localAudio.length > 0) {
    lines.push(localAudio.length === 1 ? "用户发送了一条语音消息。" : `用户发送了 ${localAudio.length} 条语音消息。`);
    for (const audio of localAudio) {
      if (audio.transcription) {
        lines.push(`语音转写：${audio.transcription}`);
      } else if (audio.transcriptionError) {
        lines.push(`语音转写失败：${audio.transcriptionError}`);
      }
    }
  }
  if (failedAudio.length > 0) {
    lines.push(failedAudio.length === 1 ? "用户发送了一条语音消息，但下载失败。" : `用户发送了 ${failedAudio.length} 条语音消息，但下载失败。`);
    for (const audio of failedAudio) {
      if (audio.url) lines.push(`资源 URL：${audio.url}`);
      lines.push(`失败原因：${audio.downloadError || "unknown_error"}`);
    }
  }

  // Handle image attachments
  if (localImages.length > 0) {
    lines.push(localImages.length === 1 ? "用户发送了一张图片。" : `用户发送了 ${localImages.length} 张图片。`);
  }
  if (failedImages.length > 0 && localImages.length === 0) {
    lines.push(failedImages.length === 1 ? "用户发送了一张图片，但插件未能落地文件。" : `用户发送了 ${failedImages.length} 张图片，但插件未能落地文件。`);
  }

  if (text) lines.push(`用户问题：${text}`);

  // Add local file details
  for (const attachment of [...localImages, ...localAudio]) {
    lines.push(`本地文件：${attachment.localFile}`);
    if (attachment.fileName) lines.push(`原始文件名：${attachment.fileName}`);
    if (attachment.mimeType) lines.push(`MIME：${attachment.mimeType}`);
  }

  // Add failed attachment details
  for (const attachment of [...failedImages, ...failedAudio]) {
    lines.push(attachment.kind === "audio" ? "语音下载失败。" : "图片下载失败。");
    if (attachment.url) lines.push(`资源 URL：${attachment.url}`);
    lines.push(`messageId：${attachment.messageId}`);
    lines.push(`失败原因：${attachment.downloadError || "unknown_error"}`);
  }

  // Add hint for images
  if (localImages.length > 0) {
    lines.push("如有需要请直接识别图片内容并结合用户问题回复。");
  }

  return lines.join("\n");
}

async function loadHostConfigForEdit(): Promise<Record<string, unknown>> {
  const configPath = resolveHostConfigFilePath();
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code === "ENOENT") {
      throw new Error("未找到宿主配置文件，已取消写入。");
    }
    throw new Error(`读取宿主配置失败：${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("宿主配置不是标准 JSON，已取消写入。");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("宿主配置结构无效，已取消写入。");
  }

  return parsed as Record<string, unknown>;
}

function ensureMutableRecord(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = container[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  container[key] = created;
  return created;
}

async function updateVoceChatHostConfig(
  updater: (channelConfig: Record<string, unknown>) => string,
): Promise<string> {
  const root = await loadHostConfigForEdit();
  const channels = ensureMutableRecord(root, "channels");
  const channelConfig = ensureMutableRecord(channels, CHANNEL_ID);
  const summary = updater(channelConfig);
  await writeJsonFileAtomically(resolveHostConfigFilePath(), root);
  return summary;
}

function parseTarget(raw: string): ParsedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(/^(vocechat|vc):/i, "").trim();
  if (!withoutPrefix) return null;

  const match = withoutPrefix.match(/^(user|u|dm|private|group|g|room|channel):\s*(.+)$/i);
  if (match) {
    const rawKind = match[1].toLowerCase();
    const id = normalizeString(match[2]);
    if (!id) return null;
    const kind: TargetKind =
      rawKind === "group" || rawKind === "g" || rawKind === "room" || rawKind === "channel"
        ? "group"
        : "user";
    return { kind, id };
  }

  if (/^\d+$/.test(withoutPrefix)) return { kind: "user", id: withoutPrefix };
  return null;
}

function ensureTarget(params: { to?: string; defaultTo?: string; mode?: string }): ParsedTarget {
  const requested = normalizeString(params.to);
  const parsedRequested = requested ? parseTarget(requested) : null;
  if (parsedRequested) return parsedRequested;

  if (params.mode !== "explicit") {
    const fallback = normalizeString(params.defaultTo);
    const parsedFallback = fallback ? parseTarget(fallback) : null;
    if (parsedFallback) return parsedFallback;
  }

  throw new Error(
    '[vocechat] Invalid target. Use "user:<id>" or "group:<id>" (example: user:3).',
  );
}

function buildPathFromTemplate(template: string, targetId: string): string {
  const encodedId = encodeURIComponent(targetId);
  if (template.includes("{id}")) return template.replaceAll("{id}", encodedId);
  if (template.includes(":id")) return template.replaceAll(":id", encodedId);
  return `${template.replace(/\/+$/g, "")}/${encodedId}`;
}

function buildSendUrl(account: ResolvedAccount, target: ParsedTarget): string {
  const template = target.kind === "group" ? account.groupPathTemplate : account.privatePathTemplate;
  const rawPath = buildPathFromTemplate(template, target.id);
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (rawPath.startsWith("/")) return `${account.baseUrl}${rawPath}`;
  return `${account.baseUrl}/${rawPath}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeString(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function createAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function canUseLoopbackFallback(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

async function requestVoceChatApi(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  if (canUseLoopbackFallback(params.url)) {
    try {
      return await requestVoceChatApiViaLoopback(params);
    } catch (loopbackError) {
      const loopbackDetail = loopbackError instanceof Error ? loopbackError.message : String(loopbackError);
      try {
        return await requestVoceChatApiViaFetch(params);
      } catch (fetchError) {
        const fetchDetail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        throw new Error(
          `[vocechat] request failed via loopback (${loopbackDetail}); configured host fallback failed (${fetchDetail})`,
        );
      }
    }
  }

  try {
    return await requestVoceChatApiViaFetch(params);
  } catch (originalError) {
    if (!canUseLoopbackFallback(params.url)) throw originalError;

    try {
      return await requestVoceChatApiViaLoopback(params);
    } catch (fallbackError) {
      const primaryDetail = originalError instanceof Error ? originalError.message : String(originalError);
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `[vocechat] request failed via configured host (${primaryDetail}); loopback fallback failed (${fallbackDetail})`,
      );
    }
  }
}

async function requestVoceChatApiViaFetch(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  const response = await fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: params.body as BodyInit,
    signal: params.signal,
  });

  const body = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

async function requestVoceChatApiViaLoopback(params: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
  signal: AbortSignal;
}): Promise<VoceChatHttpResponse> {
  const parsed = new URL(params.url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = Number(parsed.port || (isHttps ? 443 : 80));

  return await new Promise<VoceChatHttpResponse>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      const abortError = createAbortError();
      request.destroy(abortError);
      finish(() => reject(abortError));
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: "127.0.0.1",
        port,
        method: params.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...params.headers,
          host: parsed.host,
        },
        servername: isHttps ? parsed.hostname : undefined,
        rejectUnauthorized: isHttps ? true : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
              body,
            }),
          );
        });
      },
    );

    request.on("error", (error) => {
      finish(() => reject(error));
    });

    if (params.signal.aborted) {
      handleAbort();
      return;
    }

    params.signal.addEventListener("abort", handleAbort, { once: true });
    request.end(params.body);
  });
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeMediaCaption(text: string, mediaUrl?: string): string {
  const normalizedText = formatModelTagForVoceChat(text).trim();
  if (!normalizedText) return "";

  const normalizedMedia = normalizeString(mediaUrl);
  if (!normalizedMedia) return normalizedText;

  const lines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== normalizedMedia && trimmed !== `Attachment: ${normalizedMedia}` && trimmed !== `附件: ${normalizedMedia}`;
    });

  return lines.join("\n").trim();
}

function inferVoceChatPayloadContentType(mediaContentType?: string): "vocechat/file" | "vocechat/audio" {
  const normalized = normalizeString(mediaContentType).toLowerCase();
  return normalized.startsWith("audio/") ? "vocechat/audio" : "vocechat/file";
}

function buildMultipartUploadBody(params: {
  fileId: string;
  fileName: string;
  contentType?: string;
  buffer: Buffer;
}): { contentType: string; body: Buffer } {
  const boundary = `----openclaw-vocechat-${randomUUID()}`;
  const contentType = normalizeString(params.contentType) || "application/octet-stream";
  const safeFileName = path.basename(params.fileName || "attachment.bin");
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file_id"\r\n\r\n` +
        `${params.fileId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chunk_data"; filename="${safeFileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      "utf8",
    ),
    params.buffer,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chunk_is_last"\r\n\r\n` +
        `true\r\n` +
        `--${boundary}--\r\n`,
      "utf8",
    ),
  ]);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}

async function prepareVoceChatFileUpload(params: {
  account: ResolvedAccount;
  fileName: string;
  contentType?: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await requestVoceChatApi({
    url: `${params.account.baseUrl}/api/bot/file/prepare`,
    method: "POST",
    headers: {
      "x-api-key": params.account.apiKey,
      "content-type": "application/json; charset=utf-8",
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    body: JSON.stringify({
      content_type: normalizeString(params.contentType) || "application/octet-stream",
      filename: params.fileName,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const detail = response.body.trim().slice(0, 500);
    throw new Error(
      `[vocechat] file prepare failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
    );
  }

  const direct = normalizeString(response.body.replace(/^"+|"+$/g, ""));
  if (direct) return direct;

  const parsed = parseJsonObject(response.body);
  const fileId = normalizeString(parsed?.file_id ?? parsed?.fileId ?? parsed?.id);
  if (!fileId) throw new Error("[vocechat] file prepare failed: missing file id.");
  return fileId;
}

async function uploadVoceChatFile(params: {
  account: ResolvedAccount;
  fileId: string;
  fileName: string;
  contentType?: string;
  buffer: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const multipart = buildMultipartUploadBody({
    fileId: params.fileId,
    fileName: params.fileName,
    contentType: params.contentType,
    buffer: params.buffer,
  });

  const response = await requestVoceChatApi({
    url: `${params.account.baseUrl}/api/bot/file/upload`,
    method: "POST",
    headers: {
      "x-api-key": params.account.apiKey,
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.byteLength),
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    body: multipart.body,
    signal: params.signal,
  });

  if (!response.ok) {
    const detail = response.body.trim().slice(0, 500);
    throw new Error(
      `[vocechat] file upload failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
    );
  }

  const parsed = parseJsonObject(response.body);
  const uploadPath = normalizeString(parsed?.path);
  if (!uploadPath) throw new Error("[vocechat] file upload failed: missing uploaded path.");
  return uploadPath;
}

async function sendVoceChatMedia(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
  const mediaUrl = normalizeString(ctx.mediaUrl);
  if (!mediaUrl) throw new Error("[vocechat] mediaUrl is required for media delivery.");

  const account = resolveVoceChatAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const target = ensureTarget({
    to: ctx.to,
    defaultTo: account.defaultTo,
    mode: "implicit",
  });

  const caption = normalizeMediaCaption(ctx.text, mediaUrl);
  if (caption) {
    await sendVoceChatMessage({ ...ctx, text: caption });
  }

  const media = await loadOutboundMediaFromUrl(mediaUrl, {
    mediaLocalRoots: Array.isArray(ctx.mediaLocalRoots) ? ctx.mediaLocalRoots : undefined,
  });

  const fileName = normalizeString(media.fileName) || path.basename(mediaUrl) || "attachment.bin";
  const payloadContentType = inferVoceChatPayloadContentType(media.contentType);
  const url = buildSendUrl(account, target);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    const fileId = await prepareVoceChatFileUpload({
      account,
      fileName,
      contentType: media.contentType,
      signal: controller.signal,
    });
    const uploadPath = await uploadVoceChatFile({
      account,
      fileId,
      fileName,
      contentType: media.contentType,
      buffer: media.buffer,
      signal: controller.signal,
    });
    const response = await requestVoceChatApi({
      url,
      method: "POST",
      headers: {
        "x-api-key": account.apiKey,
        "content-type": payloadContentType,
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({ path: uploadPath }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = response.body.trim().slice(0, 500);
      throw new Error(
        `[vocechat] media send failed: HTTP ${response.status}${detail ? `, body=${detail}` : ""}`,
      );
    }

    const messageId = parseMessageId(response.body);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, messageId));

    return {
      channel: CHANNEL_ID,
      messageId,
      chatId: `${target.kind}:${target.id}`,
      timestamp: Date.now(),
      meta: {
        accountId: account.accountId,
        targetKind: target.kind,
        targetId: target.id,
        status: response.status,
        mediaUrl,
        uploadPath,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseMessageId(rawBody: string): string {
  const body = rawBody.trim();
  if (!body) return `${Date.now()}`;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const data = asRecord(parsed.data);
    const result = asRecord(parsed.result);
    const candidates = [
      parsed.messageId,
      parsed.message_id,
      parsed.msgId,
      parsed.msg_id,
      parsed.id,
      data.id,
      data.messageId,
      result.id,
      result.messageId,
    ];
    for (const value of candidates) {
      const normalized = parseId(value);
      if (normalized) return normalized;
    }
  } catch {
    // VoceChat may return plain text.
  }

  return body;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeVoceChatMarkdownStyle(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine;
    const trimmed = line.trim();

    // Unify bullets so app/web render consistently.
    if (/^[•·●]\s+/.test(trimmed)) {
      line = `- ${trimmed.replace(/^[•·●]\s+/, "")}`;
    }

    out.push(line);
  }

  let normalized = out.join("\n");
  // Avoid overly sparse output on mobile clients.
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
}

function formatModelTagForVoceChat(text: string): string {
  const normalized = normalizeVoceChatMarkdownStyle(text);
  const firstNewline = normalized.indexOf("\n");
  const firstLineRaw = (firstNewline >= 0 ? normalized.slice(0, firstNewline) : normalized).trim();
  if (!/^\[MODEL:\s*.+\]$/i.test(firstLineRaw)) return normalized;

  // Markdown-only badge style (works on both VoceChat web and app clients).
  const rest = firstNewline >= 0 ? normalized.slice(firstNewline + 1).trimStart() : "";
  const safeTag = firstLineRaw.replace(/`/g, "\\`");
  const badge = `> \`${safeTag}\``;
  if (!rest) return badge;
  return `${badge}\n\n${rest}`;
}

function buildPayloadText(text: string, mediaUrl?: string): string {
  const normalizedText = formatModelTagForVoceChat(text);
  const normalizedMedia = normalizeString(mediaUrl);
  if (normalizedText && normalizedMedia) return `${normalizedText}\n\n${normalizedMedia}`;
  if (normalizedMedia) return normalizedMedia;
  return normalizedText;
}

async function sendVoceChatMessage(
  ctx: ChannelOutboundContext,
  mediaUrl?: string,
): Promise<OutboundDeliveryResult> {
  const account = resolveVoceChatAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const target = ensureTarget({
    to: ctx.to,
    defaultTo: account.defaultTo,
    mode: "implicit",
  });
  const url = buildSendUrl(account, target);
  const text = buildPayloadText(ctx.text, mediaUrl);
  if (!text) throw new Error("[vocechat] Empty payload is not allowed.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    let rawBody = "";
    let response: VoceChatHttpResponse | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await requestVoceChatApi({
        url,
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = current.body;

      if (current.ok) {
        response = current;
        rawBody = currentBody;
        break;
      }

      if (current.status === 415 && contentType !== "text/plain") {
        continue;
      }

      const detail = currentBody.trim().slice(0, 500);
      throw new Error(
        `[vocechat] send failed: HTTP ${current.status}${detail ? `, body=${detail}` : ""}`,
      );
    }

    if (!response) {
      throw new Error("[vocechat] send failed: no usable content-type accepted by VoceChat.");
    }

    const messageId = parseMessageId(rawBody);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, messageId));

    return {
      channel: CHANNEL_ID,
      messageId,
      chatId: `${target.kind}:${target.id}`,
      timestamp: Date.now(),
      meta: {
        accountId: account.accountId,
        targetKind: target.kind,
        targetId: target.id,
        status: response.status,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendVoceChatReplyToMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const account = resolveVoceChatAccount(params.cfg, params.accountId);
  if (!account.enabled) throw new Error("[vocechat] Channel account is disabled.");
  if (!account.baseUrl) throw new Error("[vocechat] channels.vocechat.baseUrl is required.");
  if (!account.apiKey) throw new Error("[vocechat] channels.vocechat.apiKey is required.");

  const messageId = normalizeString(params.messageId);
  if (!messageId) throw new Error("[vocechat] reply target messageId is required.");

  const text = formatModelTagForVoceChat(params.text);
  if (!text) throw new Error("[vocechat] Empty payload is not allowed.");

  const url = `${account.baseUrl}/api/bot/reply/${encodeURIComponent(messageId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    let rawBody = "";
    let response: VoceChatHttpResponse | null = null;
    const contentTypes: string[] = ["text/markdown", "text/plain"];

    for (const contentType of contentTypes) {
      const current = await requestVoceChatApi({
        url,
        method: "POST",
        headers: {
          "x-api-key": account.apiKey,
          "content-type": contentType,
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body: text,
        signal: controller.signal,
      });
      const currentBody = current.body;

      if (current.ok) {
        response = current;
        rawBody = currentBody;
        break;
      }

      if (current.status === 415 && contentType !== "text/plain") {
        continue;
      }

      const detail = currentBody.trim().slice(0, 500);
      throw new Error(
        `[vocechat] reply failed: HTTP ${current.status}${detail ? `, body=${detail}` : ""}`
      );
    }

    if (!response) {
      throw new Error("[vocechat] reply failed: no usable content-type accepted by VoceChat.");
    }

    const outboundMessageId = parseMessageId(rawBody);
    rememberRecentMessage(recentOutboundMessageIds, makeMessageKey(account.accountId, outboundMessageId));
  } finally {
    clearTimeout(timeout);
  }
}

function parseInboundEvent(raw: unknown, account: ResolvedAccount): InboundEvent | null {
  const payload = asRecord(raw);
  const detail = asRecord(payload.detail);
  const target = asRecord(payload.target);
  const detailTarget = asRecord(detail.target);
  const sender = asRecord(payload.sender);
  const detailSender = asRecord(detail.sender);

  const visibleTypes = [
    detail.type,
    detail.message_type,
    detail.messageType,
    payload.type,
    payload.message_type,
    payload.messageType,
  ];
  const normalizedTypes = Array.from(
    new Set(visibleTypes.map((value) => normalizeInboundType(value)).filter(Boolean)),
  );
  const hasExplicitType = normalizedTypes.length > 0;
  const hasSupportedTextType = normalizedTypes.some((value) => isSupportedInboundTextType(value));
  const hasBlockedType = normalizedTypes.some((value) => account.inboundBlockedTypes.includes(value));

  if (hasBlockedType) return null;

  const messageId =
    firstNonEmptyId([
      payload.mid,
      payload.message_id,
      payload.messageId,
      payload.msg_id,
      payload.msgId,
      detail.mid,
      detail.message_id,
      detail.messageId,
      detail.msg_id,
      detail.msgId,
    ]) || `${Date.now()}`;

  const attachments = extractInboundAttachments(raw, messageId, account);
  const imageUrls = attachments.map((attachment) => attachment.url).filter(Boolean) as string[];

  const originalText = firstNonEmptyString([
    detail.content,
    detail.text,
    payload.content,
    payload.text,
    detail.preview,
    payload.preview,
  ]);
  const normalizedOriginalText = normalizeInboundText(originalText);
  const text = attachments.length > 0 ? stripImageReferencesFromText(normalizedOriginalText) : normalizedOriginalText;

  if (!text && attachments.length === 0) return null;
  if (text.length > account.inboundMaxTextLength) return null;
  if (attachments.length === 0 && text.length < account.inboundMinTextLength) return null;

  if (account.inboundParseMode === "strict") {
    if (!hasExplicitType || (!hasSupportedTextType && attachments.length === 0)) return null;
  } else if (account.inboundParseMode === "legacy") {
    if (hasExplicitType && !hasSupportedTextType && attachments.length === 0) return null;
  } else {
    // balanced
    if (hasExplicitType && !hasSupportedTextType && attachments.length === 0) return null;
    if (!hasExplicitType && !account.inboundAllowTypelessText && attachments.length === 0) return null;
  }

  const fromUid = firstNonEmptyId([
    payload.from_uid,
    payload.fromUid,
    payload.sender_uid,
    payload.senderUid,
    payload.user_id,
    payload.userId,
    payload.uid,
    detail.from_uid,
    detail.fromUid,
    detail.sender_uid,
    detail.senderUid,
    detail.user_id,
    detail.userId,
    detail.uid,
    sender.uid,
    sender.user_id,
    sender.userId,
    sender.sender_uid,
    sender.senderUid,
    sender.id,
    detailSender.uid,
    detailSender.user_id,
    detailSender.userId,
    detailSender.sender_uid,
    detailSender.senderUid,
    detailSender.id,
  ]);
  if (!fromUid) return null;

  const groupId = firstNonEmptyId([
    target.gid,
    target.group_id,
    target.groupId,
    target.room_id,
    target.roomId,
    detailTarget.gid,
    detailTarget.group_id,
    detailTarget.groupId,
    detailTarget.room_id,
    detailTarget.roomId,
    payload.gid,
    payload.group_id,
    payload.groupId,
    payload.room_id,
    payload.roomId,
    detail.gid,
    detail.group_id,
    detail.groupId,
    detail.room_id,
    detail.roomId,
  ]);

  const chatType: "direct" | "group" = groupId ? "group" : "direct";
  const conversationId = groupId || fromUid;

  const timestamp = parseTimestampMs(
    payload.created_at ??
      payload.createdAt ??
      payload.timestamp ??
      payload.ts ??
      detail.created_at ??
      detail.createdAt ??
      detail.timestamp ??
      detail.ts,
  );
  const replyTarget = chatType === "group" ? `group:${groupId}` : `user:${fromUid}`;

  return {
    messageId,
    fromUid,
    chatType,
    conversationId,
    groupId: groupId || undefined,
    text,
    originalText: normalizedOriginalText,
    timestamp,
    replyTarget,
    attachments,
    imageUrls,
    localFiles: [],
  };
}


function isInboundAuthorized(account: ResolvedAccount, event: InboundEvent): boolean {
  if (event.chatType === "group") {
    if (account.groupAllowFrom.length === 0) return true;
    return account.groupAllowFrom.includes(event.fromUid);
  }

  if (account.allowFrom.length === 0) return true;
  return account.allowFrom.includes(event.fromUid);
}

function resolveAckReaction(cfg: OpenClawConfig, accountId: string): string {
  const channelCfg = getChannelConfig(cfg);
  const accountCfg = asRecord(asRecord(channelCfg.accounts)[normalizeAccountId(accountId)]);

  if (hasOwn(accountCfg, "ackReaction")) {
    return normalizeString(accountCfg.ackReaction);
  }

  const channelRecord = channelCfg as Record<string, unknown>;
  if (hasOwn(channelRecord, "ackReaction")) {
    return normalizeString(channelRecord.ackReaction);
  }

  const messagesCfg = asRecord((cfg as Record<string, unknown>).messages);
  return normalizeString(messagesCfg.ackReaction);
}

function resolveAckReactionScope(cfg: OpenClawConfig): "group-mentions" | "group-all" | "direct" | "all" {
  const messagesCfg = asRecord((cfg as Record<string, unknown>).messages);
  const raw = normalizeString(messagesCfg.ackReactionScope).toLowerCase();
  if (raw === "group-all" || raw === "direct" || raw === "all") return raw;
  return "group-mentions";
}

function shouldSendAckReaction(
  scope: "group-mentions" | "group-all" | "direct" | "all",
  event: InboundEvent,
): boolean {
  if (scope === "all") return true;
  if (scope === "direct") return event.chatType === "direct";
  if (scope === "group-all") return event.chatType === "group";
  // VoceChat webhook does not provide normalized mention metadata.
  // Fallback: treat group-mentions as group chats for immediate "I saw this" feedback.
  if (scope === "group-mentions") return event.chatType === "group";
  return false;
}

async function sendVoceChatReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  messageId: string;
  action: string;
}): Promise<void> {
  const account = resolveVoceChatAccount(params.cfg, params.accountId);
  if (!account.enabled || !account.baseUrl || !account.apiKey) return;

  const action = normalizeString(params.action);
  if (!action) return;

  const url = `${account.baseUrl}/api/bot/reply/${encodeURIComponent(params.messageId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.timeoutMs);
  try {
    const response = await requestVoceChatApi({
      url,
      method: "POST",
      headers: {
        "x-api-key": account.apiKey,
        "content-type": "text/plain",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: action,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = response.body.trim().slice(0, 500);
      throw new Error(`HTTP ${response.status}${detail ? `, body=${detail}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(direct)) return normalizeString(direct[0]);
  return normalizeString(direct);
}

async function processInboundEvent(params: {
  accountId: string;
  event: InboundEvent;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const { accountId, logger } = params;
  const runtime = getVoceChatRuntime();
  const cfg = await runtime.config.loadConfig();
  const account = resolveVoceChatAccount(cfg, accountId);
  let event = params.event;
  logger?.info?.(
    `[vocechat] inbound begin account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType} attachments=${event.attachments.length}`,
  );
  if (!account.enabled || !account.inboundEnabled) {
    logger?.info?.(
      `[vocechat] inbound ignored: account disabled account=${account.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
    );
    return;
  }

  const messageKey = makeMessageKey(account.accountId, event.messageId);
  if (hasRecentMessage(recentOutboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip outbound echo mid=${event.messageId}`);
    return;
  }
  if (hasRecentMessage(recentInboundMessageIds, messageKey)) {
    logger?.info?.(`[vocechat] skip duplicated inbound mid=${event.messageId}`);
    return;
  }
  rememberRecentMessage(recentInboundMessageIds, messageKey);

  if (!isInboundAuthorized(account, event)) {
    logger?.warn?.(
      `[vocechat] drop unauthorized sender uid=${event.fromUid} account=${account.accountId} chatType=${event.chatType}`,
    );
    return;
  }

  const ackReaction = resolveAckReaction(cfg, account.accountId);
  const ackReactionScope = resolveAckReactionScope(cfg);
  if (ackReaction && shouldSendAckReaction(ackReactionScope, event)) {
    try {
      await sendVoceChatReaction({
        cfg,
        accountId: account.accountId,
        messageId: event.messageId,
        action: ackReaction,
      });
      logger?.info?.(
        `[vocechat] inbound ack reaction sent account=${account.accountId} mid=${event.messageId} action=${ackReaction}`,
      );
    } catch (err) {
      logger?.warn?.(
        `[vocechat] inbound ack reaction failed account=${account.accountId} mid=${event.messageId} action=${ackReaction} err=${String(err)}`,
      );
    }
  }

  if (account.inboundAckEnabled) {
    try {
      await sendVoceChatMessage(
        {
          cfg,
          to: event.replyTarget,
          text: account.inboundAckText,
          accountId: account.accountId,
        } as ChannelOutboundContext,
      );
    } catch (err) {
      logger?.warn?.(
        `[vocechat] inbound ack failed account=${account.accountId} mid=${event.messageId} err=${String(err)}`,
      );
    }
  }

  event = await hydrateInboundAttachments({
    event,
    account,
    logger,
  });
  logger?.info?.(
    `[vocechat] inbound media ready account=${account.accountId} mid=${event.messageId} localFiles=${event.localFiles.length} attachmentCount=${event.attachments.length}`,
  );

  // Content-based deduplication for voice messages
  // VoceChat may send same voice message with different messageIds
  const audioAttachments = event.attachments.filter((a) => a.kind === "audio");
  if (audioAttachments.length > 0) {
    const voiceSignature = [
      event.fromUid,
      ...audioAttachments.map((a) => [
        a.url?.split("/").pop()?.split("?")[0] || "",
        a.sizeBytes || 0,
        a.transcription || "",
      ].join(":")),
    ].join("|");

    cleanupRecentMessageCache(recentVoiceSignatures);
    const lastSeen = recentVoiceSignatures.get(voiceSignature);
    if (lastSeen && nowMs() - lastSeen < 30000) {
      logger?.info?.(
        `[vocechat] skip duplicate voice content account=${account.accountId} mid=${event.messageId} signature=${voiceSignature.slice(0, 50)}`,
      );
      return;
    }
    recentVoiceSignatures.set(voiceSignature, nowMs());
  }

  // requireMention check: skip group messages that don't mention the bot
  if (event.chatType === "group") {
    const groupId = event.groupId ?? event.conversationId;
    const requireMention = resolveVoceChatGroupRequireMention(cfg, account.accountId, groupId);
    if (requireMention) {
      const mentionPatterns = getMentionPatternsFromConfig(cfg);
      if (!matchesMentionPattern(event.originalText, mentionPatterns)) {
        logger?.info?.(
          `[vocechat] inbound skip: group message without mention account=${account.accountId} mid=${event.messageId} group=${groupId} text=${clipAuditSegment(event.originalText, 80)} patterns=${mentionPatterns.join("|") || "-"}`,
        );
        return;
      }
    }
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: event.chatType === "group" ? "group" : "direct",
      id: event.conversationId,
    },
  });
  logger?.info?.(
    `[vocechat] inbound route agent=${route.agentId} sessionKey=${route.sessionKey} account=${route.accountId}`,
  );

  const storePath = runtime.channel.session.resolveStorePath(
    (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const conversationLabel =
    event.chatType === "group"
      ? `group:${event.groupId ?? event.conversationId}`
      : `user:${event.fromUid}`;
  const agentBody = buildInboundAgentBody(event);

  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "VoceChat",
    from: conversationLabel,
    timestamp: event.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: agentBody,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: agentBody,
    RawBody: agentBody,
    CommandBody: agentBody,
    From: `vocechat:${event.fromUid}`,
    To: `vocechat:${event.replyTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.chatType,
    ConversationLabel: conversationLabel,
    GroupSubject: event.chatType === "group" ? `group:${event.groupId ?? event.conversationId}` : undefined,
    SenderId: event.fromUid,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: event.messageId,
    Timestamp: event.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: event.replyTarget,
    CommandAuthorized: true,
    OriginalText: event.originalText,
    LocalFiles: event.localFiles,
    localFiles: event.localFiles,
    Attachments: event.attachments,
    attachments: event.attachments,
    ImageUrls: event.imageUrls,
    imageUrls: event.imageUrls,
    Media: event.attachments,
    media: event.attachments,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger?.error?.(`[vocechat] failed updating session: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const text = normalizeString(payload.text);

    if (mediaUrls.length > 0) {
      for (let index = 0; index < mediaUrls.length; index += 1) {
        const mediaUrl = mediaUrls[index];
        const caption = index === 0 ? text : "";
        await sendVoceChatMedia(
          {
            cfg,
            to: event.replyTarget,
            text: caption,
            mediaUrl,
            accountId: account.accountId,
          } as ChannelOutboundContext,
        );
      }
      return;
    }

    const combined = formatTextWithAttachmentLinks(text, []);
    if (!combined) return;

    if (event.chatType === "group") {
      try {
        await sendVoceChatReplyToMessage({
          cfg,
          accountId: account.accountId,
          messageId: event.messageId,
          text: combined,
        });
        return;
      } catch (err) {
        logger?.warn?.(
          `[vocechat] quote-reply failed account=${account.accountId} mid=${event.messageId} err=${String(err)}; fallback=group-send`,
        );
      }
    }

    await sendVoceChatMessage(
      {
        cfg,
        to: event.replyTarget,
        text: combined,
        accountId: account.accountId,
      } as ChannelOutboundContext,
    );
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        logger?.error?.(`[vocechat] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
  logger?.info?.(
    `[vocechat] inbound dispatch complete account=${account.accountId} mid=${event.messageId} replyTarget=${event.replyTarget}`,
  );
}

function createWebhookHandler(params: {
  accountId: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  const { accountId, logger } = params;

  return async (
    req: { method?: string; headers: Record<string, string | string[] | undefined> },
    res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  ) => {
    const method = normalizeString(req.method).toUpperCase() || "UNKNOWN";
    const forwardedFor = readHeader(req.headers, "x-forwarded-for");
    logger?.info?.(
      `[vocechat] webhook hit account=${accountId} method=${method}${forwardedFor ? ` xff=${forwardedFor}` : ""}`,
    );

    if (method === "GET") {
      writeJson(res, 200, { ok: true, channel: CHANNEL_ID });
      return;
    }

    if (method !== "POST") {
      logger?.warn?.(
        `[vocechat] webhook reject: method_not_allowed account=${accountId} method=${method}`,
      );
      writeJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    const jsonResult = await readJsonBodyWithLimit(req as any, {
      maxBytes: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
      emptyObjectOnEmpty: false,
    });

    if (!jsonResult.ok) {
      const err = (jsonResult as { ok: false; error: string; code: string }).error;
      logger?.warn?.(
        `[vocechat] webhook reject: invalid_json account=${accountId} detail=${String(err)}`,
      );
      writeJson(res, 400, {
        ok: false,
        error: "invalid_json",
        detail: err,
      });
      return;
    }

    const runtime = getVoceChatRuntime();
    const cfg = await runtime.config.loadConfig();
    const account = resolveVoceChatAccount(cfg, accountId);

    if (!account.enabled || !account.inboundEnabled) {
      logger?.info?.(
        `[vocechat] webhook ignored: account disabled account=${account.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
      );
      writeJson(res, 200, { ok: true, ignored: "disabled" });
      return;
    }

    if (account.webhookApiKey) {
      const provided = readHeader(req.headers, "x-api-key");
      if (!provided || provided !== account.webhookApiKey) {
        logger?.warn?.(
          `[vocechat] webhook reject: forbidden account=${account.accountId} provided=${provided ? "yes" : "no"}`,
        );
        writeJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
    }

    const event = parseInboundEvent(jsonResult.value, account);
    writeJson(res, 200, { ok: true, accepted: Boolean(event) });

    if (!event) {
      const summary = summarizeInboundPayloadForAudit(jsonResult.value, account.accountId);
      logger?.warn?.(`[vocechat] webhook accepted but ignored: unsupported payload ${summary}`);
      if (account.inboundParseDebug) {
        logger?.info?.(
          `[vocechat] inbound parse debug account=${account.accountId} mode=${account.inboundParseMode} allowTypeless=${account.inboundAllowTypelessText} minLen=${account.inboundMinTextLength} maxLen=${account.inboundMaxTextLength} blockedTypes=${account.inboundBlockedTypes.join("|") || "-"}`,
        );
      }
      return;
    }
    logger?.info?.(
      `[vocechat] webhook parsed account=${account.accountId} mid=${event.messageId} from=${event.fromUid} chat=${event.chatType} len=${event.text.length} attachments=${event.attachments.length}`,
    );

    void processInboundEvent({
      accountId,
      event,
      logger,
    }).catch((err) => {
      logger?.error?.(`[vocechat] inbound dispatch failed: ${String(err)}`);
    });
  };
}

const voceChatChannel: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "VoceChat",
    selectionLabel: "VoceChat Bot API",
    docsPath: "/channels/vocechat",
    docsLabel: "vocechat",
    blurb: "Send and receive messages through VoceChat bot API + webhook.",
    aliases: ["vc"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.vocechat"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        baseUrl: { type: "string" },
        apiKey: { type: "string" },
        privatePathTemplate: { type: "string" },
        groupPathTemplate: { type: "string" },
        ackReaction: { type: "string" },
        defaultTo: { type: "string" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
        inboundEnabled: { type: "boolean" },
        inboundAckEnabled: { type: "boolean" },
        inboundAckText: { type: "string" },
        inboundParseMode: { type: "string", enum: ["legacy", "balanced", "strict"] },
        inboundBlockedTypes: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        inboundMinTextLength: { type: "number", minimum: 1, maximum: 200 },
        inboundMaxTextLength: { type: "number", minimum: 50, maximum: 20000 },
        inboundAllowTypelessText: { type: "boolean" },
        inboundParseDebug: { type: "boolean" },
        webhookPath: { type: "string" },
        webhookApiKey: { type: "string" },
        allowFrom: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
          ],
        },
        groupAllowFrom: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
          ],
        },
        management: {
          type: "object",
          additionalProperties: false,
          properties: {
            adminSenderIds: {
              type: "array",
              items: { type: "string" },
            },
            panelStateFile: { type: "string" },
          },
        },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireMention: { type: "boolean" },
            },
          },
        },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              baseUrl: { type: "string" },
              apiKey: { type: "string" },
              privatePathTemplate: { type: "string" },
              groupPathTemplate: { type: "string" },
              ackReaction: { type: "string" },
              defaultTo: { type: "string" },
              timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
              inboundEnabled: { type: "boolean" },
              inboundAckEnabled: { type: "boolean" },
              inboundAckText: { type: "string" },
              inboundParseMode: { type: "string", enum: ["legacy", "balanced", "strict"] },
              inboundBlockedTypes: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
              inboundMinTextLength: { type: "number", minimum: 1, maximum: 200 },
              inboundMaxTextLength: { type: "number", minimum: 50, maximum: 20000 },
              inboundAllowTypelessText: { type: "boolean" },
              inboundParseDebug: { type: "boolean" },
              webhookPath: { type: "string" },
              webhookApiKey: { type: "string" },
              allowFrom: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
                ],
              },
              groupAllowFrom: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
                ],
              },
            },
          },
        },
      },
    },
    uiHints: {
      apiKey: {
        label: "VoceChat API Key",
        sensitive: true,
      },
      webhookApiKey: {
        label: "Webhook API Key",
        sensitive: true,
      },
      "management.adminSenderIds": {
        label: "管理员发送者 ID",
        advanced: true,
      },
      "management.panelStateFile": {
        label: "面板状态文件",
        advanced: true,
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listVoceChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveVoceChatAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    disabledReason: (account) => (account.enabled ? "" : "vocechat channel is disabled"),
    isConfigured: (account) => Boolean(account.baseUrl && account.apiKey),
    unconfiguredReason: (account) => {
      if (!account.baseUrl) return "missing channels.vocechat.baseUrl";
      if (!account.apiKey) return "missing channels.vocechat.apiKey";
      return "not configured";
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.baseUrl && account.apiKey),
      connected: account.enabled && Boolean(account.baseUrl && account.apiKey),
      baseUrl: account.baseUrl || undefined,
      secretSource: account.apiKey ? "config" : "none",
      webhookPath: account.webhookPath,
      mode: account.inboundEnabled ? "webhook+outbound" : "outbound-only",
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveVoceChatAccount(cfg, accountId).allowFrom,
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) => resolveVoceChatAccount(cfg, accountId).defaultTo,
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ cfg, to, accountId, mode }) => {
      const defaultTo = cfg ? resolveVoceChatAccount(cfg, accountId).defaultTo : undefined;
      try {
        const parsed = ensureTarget({ to, defaultTo, mode });
        return { ok: true, to: `${parsed.kind}:${parsed.id}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: new Error(message) };
      }
    },
    sendText: async (ctx) => sendVoceChatMessage(ctx),
    sendMedia: async (ctx) => sendVoceChatMedia(ctx),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const routeKey = `${ctx.accountId}:${account.webhookPath}`;
      ctx.log?.info(
        `[vocechat] start account=${ctx.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled} webhookPath=${account.webhookPath}`,
      );

      if (!account.enabled || !account.inboundEnabled) {
        ctx.log?.info(
          `[vocechat] skip webhook start for account=${ctx.accountId} enabled=${account.enabled} inboundEnabled=${account.inboundEnabled}`,
        );
        return { stop: () => {} };
      }

      const previous = activeRouteUnregisters.get(routeKey);
      if (previous) {
        previous();
        activeRouteUnregisters.delete(routeKey);
      }

      const handler = createWebhookHandler({
        accountId: account.accountId,
        logger: {
          info: (message) => ctx.log?.info(message),
          warn: (message) => ctx.log?.warn(message),
          error: (message) => ctx.log?.error(message),
        },
      });

      const unregister = registerPluginHttpRoute({
        path: account.webhookPath,
        fallbackPath: DEFAULT_WEBHOOK_PATH,
        handler: handler as any,
        auth: "gateway",
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (message) => ctx.log?.info(message),
      });
      activeRouteUnregisters.set(routeKey, unregister);
      ctx.log?.info(
        `[vocechat] webhook route registered account=${ctx.accountId} path=${account.webhookPath} fallback=${DEFAULT_WEBHOOK_PATH}`,
      );

      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        connected: true,
        mode: "webhook",
        webhookPath: account.webhookPath,
        lastStartAt: Date.now(),
      });

      await waitForAbort(ctx.abortSignal);
      const fn = activeRouteUnregisters.get(routeKey);
      if (fn) fn();
      activeRouteUnregisters.delete(routeKey);
      ctx.log?.info(`[vocechat] stop account=${ctx.accountId} webhookPath=${account.webhookPath}`);
      ctx.setStatus({
        accountId: ctx.accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
};

const VOCECHAT_CONTROL_COMMAND = "vocechatctl";
const SILENT_REPLY_TOKEN = "NO_REPLY";

type VoceChatPanelAction = "home" | "accounts" | "account-detail" | "webhook" | "routing" | "access" | "admin-remove-confirm" | "admin-remove" | "set-default-target";

type VoceChatParsedCommand = {
  panelId: string | null;
  action: VoceChatPanelAction;
  arg: string;
};

type VoceChatPanelResponse = {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
};

function registerVoceChatManagementCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: VOCECHAT_CONTROL_COMMAND,
    description: "VoceChat 通道管理面板（管理员）",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleVoceChatManagementCommand(ctx, api.config as OpenClawConfig),
  });
}

async function handleVoceChatManagementCommand(ctx: PluginCommandContext, cfg: OpenClawConfig): Promise<ReplyPayload> {
  const management = resolveVoceChatManagement(cfg);
  if (!isVoceChatAdminAuthorized(ctx, management)) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "无权限：仅管理员可执行该命令。",
      ].join("\n"),
      isError: true,
    };
  }

  const editReply = await maybeHandleVoceChatEditCommand(ctx.args ?? "", cfg);
  if (editReply) return editReply;

  const parsed = parseVoceChatCommandArgs(ctx.args ?? "");
  if (ctx.channel === "telegram") {
    return await handleVoceChatTelegramPanel(ctx, cfg, management, parsed);
  }
  return await handleVoceChatGenericCommand(cfg, parsed);
}

async function handleVoceChatTelegramPanel(
  ctx: PluginCommandContext,
  cfg: OpenClawConfig,
  management: VoceChatManagementConfig,
  parsed: VoceChatParsedCommand,
): Promise<ReplyPayload> {
  const telegramRuntime = resolveVoceChatTelegramRuntime(cfg);
  if (!telegramRuntime) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "缺少 Telegram 机器人配置，无法打开卡片面板。",
      ].join("\n"),
      isError: true,
    };
  }

  const target = parseTelegramTarget(ctx.to ?? ctx.from, ctx.messageThreadId);
  if (!target && !parsed.panelId) {
    return {
      text: [
        "VoceChat 通道管理",
        "",
        "当前会话未解析出 Telegram 目标，无法打开卡片面板。",
      ].join("\n"),
      isError: true,
    };
  }

  const store = new ControlPanelStore(management.panelStateFile);
  const delivery = new TelegramPanelDelivery(telegramRuntime);

  if (parsed.panelId) {
    const panel = store.get(parsed.panelId);
    if (!panel) {
      return {
        text: [
          "VoceChat 通道管理",
          "",
          `卡片已过期，请重新发送 /${VOCECHAT_CONTROL_COMMAND} 打开。`,
        ].join("\n"),
        isError: true,
      };
    }

    let effectiveCfg = cfg;
    let effectiveAction = parsed.action;
    let effectiveArg = parsed.arg;
    let notice = "";

    if (parsed.action === "admin-remove") {
      const senderId = normalizeIdentity(parsed.arg);
      if (senderId) {
        const summary = await updateVoceChatAdminRemoval(senderId);
        effectiveCfg = await loadHostConfigForEdit() as OpenClawConfig;
        effectiveAction = "access";
        effectiveArg = "";
        notice = summary;
      }
    } else if (parsed.action === "set-default-target") {
      const mutation = parseVoceChatTargetMutationArg(parsed.arg);
      if (mutation) {
        const summary = await updateVoceChatDefaultTarget(mutation.accountId, mutation.targetRaw);
        effectiveCfg = await loadHostConfigForEdit() as OpenClawConfig;
        effectiveAction = mutation.returnAction;
        effectiveArg = mutation.returnArg ?? "";
        notice = summary;
      }
    }

    const response = renderVoceChatPanel(effectiveCfg, effectiveAction, effectiveArg, parsed.panelId);
    const responseText = notice ? `${notice}\n\n${response.text}` : response.text;
    await delivery.editMessage(
      { chatId: panel.chatId, threadId: panel.threadId },
      panel.messageId,
      { text: responseText, replyMarkup: { inline_keyboard: response.buttons } },
    );
    store.update(parsed.panelId, (current) => current);
    return { text: SILENT_REPLY_TOKEN };
  }

  const panel = store.create({
    chatId: target?.chatId ?? "",
    threadId: target?.threadId ?? null,
    ownerSenderId: normalizeIdentity(ctx.senderId ?? ctx.from),
  });
  const response = renderVoceChatPanel(cfg, parsed.action, parsed.arg, panel.panelId);
  const sent = await delivery.sendMessage(
    { chatId: panel.chatId, threadId: panel.threadId },
    { text: response.text, replyMarkup: { inline_keyboard: response.buttons } },
  );
  store.update(panel.panelId, (current) => ({ ...current, messageId: sent.messageId }));
  return {};
}

async function handleVoceChatGenericCommand(cfg: OpenClawConfig, parsed: VoceChatParsedCommand): Promise<ReplyPayload> {
  return {
    text: renderVoceChatPanel(cfg, parsed.action, parsed.arg, "plain").text,
  };
}

function renderVoceChatPanel(
  cfg: OpenClawConfig,
  action: VoceChatPanelAction,
  arg: string,
  panelId: string,
): VoceChatPanelResponse {
  switch (action) {
    case "accounts":
      return renderVoceChatAccountsPanel(cfg, panelId);
    case "account-detail":
      return renderVoceChatAccountDetailPanel(cfg, panelId, arg);
    case "webhook":
      return renderVoceChatWebhookPanel(cfg, panelId);
    case "routing":
      return renderVoceChatRoutingPanel(cfg, panelId);
    case "access":
      return renderVoceChatAccessPanel(cfg, panelId);
    case "admin-remove-confirm":
      return renderVoceChatAdminRemoveConfirmPanel(cfg, panelId, arg);
    case "admin-remove":
      return renderVoceChatAccessPanel(cfg, panelId);
    case "set-default-target":
      return renderVoceChatRoutingPanel(cfg, panelId);
    case "home":
    default:
      return renderVoceChatOverviewPanel(cfg, panelId);
  }
}

function renderVoceChatOverviewPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const section = getChannelConfig(cfg);
  const management = resolveVoceChatManagement(cfg);
  const accountIds = listVoceChatAccountIds(cfg);
  const accounts = accountIds.map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const configuredCount = accounts.filter((account) => Boolean(account.baseUrl && account.apiKey)).length;
  const inboundCount = accounts.filter((account) => account.enabled && account.inboundEnabled).length;
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const groupPolicy = normalizeString((section as Record<string, unknown>).groupPolicy);

  const lines = [
    "VoceChat 通道管理",
    "",
    `账号总数：${accounts.length}`,
    `启用账号：${enabledCount}`,
    `已配置账号：${configuredCount}`,
    `启用入站：${inboundCount}`,
    `默认账号：${defaultAccount.accountId}`,
    `默认目标：${defaultAccount.defaultTo ?? "<未设置>"}`,
    `群消息策略：${formatVoceChatGroupPolicy(groupPolicy)}`,
    `管理员控制：${formatVoceChatAdminMode(management.adminSenderIds)}`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatMainButtons(panelId),
  };
}

function renderVoceChatAccountsPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const lines = ["VoceChat 账号列表", ""];

  if (accounts.length === 0) {
    lines.push("当前未配置任何账号。", "", "请先在配置中补充账号信息。");
  } else {
    for (const account of accounts) {
      const defaultMark = account.accountId === DEFAULT_ACCOUNT_ID ? " [默认]" : "";
      lines.push(
        `${account.enabled ? "✅" : "⛔"} ${account.accountId}${defaultMark} · ${account.inboundEnabled ? "入站开" : "入站关"} · ${account.baseUrl ? "已配置" : "未配置"}`,
      );
    }
    lines.push("", "点击下方按钮查看账号详情。", "可用“返回概览”返回主页。");
  }

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatAccountButtons(panelId, accounts),
  };
}

function renderVoceChatAccountDetailPanel(cfg: OpenClawConfig, panelId: string, accountIdRaw: string): VoceChatPanelResponse {
  const accountId = normalizeAccountId(accountIdRaw || DEFAULT_ACCOUNT_ID);
  const account = resolveVoceChatAccount(cfg, accountId);
  const lines = [
    `账号详情：${account.accountId}`,
    "",
    `启用状态：${account.enabled ? "已启用" : "未启用"}`,
    `配置状态：${account.baseUrl && account.apiKey ? "完整" : "不完整"}`,
    `名称：${account.name ?? "<未设置>"}`,
    `基础地址：${account.baseUrl || "<未设置>"}`,
    `默认目标：${account.defaultTo ?? "<未设置>"}`,
    `超时时间：${account.timeoutMs} ms`,
    `Webhook 路径：${account.webhookPath}`,
    `Webhook 鉴权：${account.webhookApiKey ? "已设置" : "未设置"}`,
    `入站模式：${account.inboundEnabled ? "webhook+outbound" : "outbound-only"}`,
    `确认回复：${account.inboundAckEnabled ? "开启" : "关闭"}`,
    `解析模式：${account.inboundParseMode}`,
    `允许无类型文本：${account.inboundAllowTypelessText ? "是" : "否"}`,
    `解析调试：${account.inboundParseDebug ? "开启" : "关闭"}`,
    `阻断类型：${formatVoceChatCountPreview(account.inboundBlockedTypes)}`,
    `私聊白名单：${formatVoceChatCountPreview(account.allowFrom)}`,
    `群聊白名单：${formatVoceChatCountPreview(account.groupAllowFrom)}`,
    `私聊路径模板：${formatVoceChatTemplateState(account.privatePathTemplate, DEFAULT_PRIVATE_PATH_TEMPLATE)}`,
    `群聊路径模板：${formatVoceChatTemplateState(account.groupPathTemplate, DEFAULT_GROUP_PATH_TEMPLATE)}`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatAccountDetailButtons(panelId, account, cfg),
  };
}

function renderVoceChatWebhookPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accountIds = listVoceChatAccountIds(cfg);
  const accounts = accountIds.map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const webhookEnabledCount = accounts.filter((account) => account.enabled && account.inboundEnabled).length;
  const authEnabledCount = accounts.filter((account) => Boolean(account.webhookApiKey)).length;
  const lines = [
    "VoceChat Webhook 总览",
    "",
    `Webhook 启用账号：${webhookEnabledCount}`,
    `鉴权开启账号：${authEnabledCount}`,
  ];

  if (accounts.length === 0) {
    lines.push("", "当前未配置任何账号。", "请先在配置中补充账号信息。");
  } else {
    lines.push("");
    for (const account of accounts) {
      lines.push(
        `${account.enabled && account.inboundEnabled ? "✅" : "⛔"} ${account.accountId} · ${account.webhookPath} · ${account.webhookApiKey ? "鉴权开" : "鉴权关"} · ${account.inboundAckEnabled ? "确认开" : "确认关"}`,
      );
    }
    lines.push("", `默认回退路径：${DEFAULT_WEBHOOK_PATH}`);
  }

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatMainButtons(panelId),
  };
}

function renderVoceChatRoutingPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const lines = [
    "VoceChat 路由摘要",
    "",
    `账号模式：${accounts.length > 1 ? "多账号" : "单账号"}`,
    `默认账号：${defaultAccount.accountId}`,
    `默认目标：${defaultAccount.defaultTo ?? "<未设置>"}`,
    `私聊路径模板：${formatVoceChatTemplateState(defaultAccount.privatePathTemplate, DEFAULT_PRIVATE_PATH_TEMPLATE)}`,
    `群聊路径模板：${formatVoceChatTemplateState(defaultAccount.groupPathTemplate, DEFAULT_GROUP_PATH_TEMPLATE)}`,
    `目标格式：user:<ID> / group:<ID>`,
    `回复能力：支持按消息回复`,
    "",
    "下方按钮可直接复制命令模板。",
    `修改默认目标：/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`,
    `指定账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to <账号ID> user:2`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatRoutingButtons(cfg, panelId),
  };
}


function renderVoceChatAdminRemoveConfirmPanel(cfg: OpenClawConfig, panelId: string, senderIdRaw: string): VoceChatPanelResponse {
  const senderId = normalizeIdentity(senderIdRaw);
  const management = resolveVoceChatManagement(cfg);
  const exists = management.adminSenderIds.map(normalizeIdentity).includes(senderId);
  const lines = [
    "确认删除管理员",
    "",
    `管理员：${senderId || "<空>"}`,
    `当前存在：${exists ? "是" : "否"}`,
    "",
    exists ? "请确认是否删除该管理员。" : "该管理员已不存在，可返回权限面板刷新查看。",
  ];

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (exists) {
    buttons.push([
      { text: "确认删除", style: "danger", callback_data: buildVoceChatPanelCallback(panelId, "z", senderId) },
    ]);
  }
  buttons.push([
    { text: "取消返回", callback_data: buildVoceChatPanelCallback(panelId, "x") },
  ]);

  return {
    text: lines.join("\n"),
    buttons,
  };
}

function renderVoceChatAccessPanel(cfg: OpenClawConfig, panelId: string): VoceChatPanelResponse {
  const section = getChannelConfig(cfg);
  const management = resolveVoceChatManagement(cfg);
  const accounts = listVoceChatAccountIds(cfg).map((accountId) => resolveVoceChatAccount(cfg, accountId));
  const defaultAccount = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  const groupPolicy = normalizeString((section as Record<string, unknown>).groupPolicy);
  const allowFromTotal = accounts.reduce((sum, account) => sum + account.allowFrom.length, 0);
  const groupAllowFromTotal = accounts.reduce((sum, account) => sum + account.groupAllowFrom.length, 0);
  const lines = [
    "VoceChat 访问控制",
    "",
    `管理员模式：${management.adminSenderIds.length > 0 ? "插件白名单" : "继承宿主授权"}`,
    `管理员数量：${management.adminSenderIds.length}`,
    `管理员列表：${management.adminSenderIds.length > 0 ? management.adminSenderIds.join("、") : "未设置"}`,
    `群消息策略：${formatVoceChatGroupPolicy(groupPolicy)}`,
    `私聊白名单总量：${allowFromTotal}`,
    `群聊白名单总量：${groupAllowFromTotal}`,
    `默认账号私聊白名单：${formatVoceChatCountPreview(defaultAccount.allowFrom)}`,
    `默认账号群聊白名单：${formatVoceChatCountPreview(defaultAccount.groupAllowFrom)}`,
    "",
    "下方按钮可直接复制命令模板。",
    `查看管理员：/${VOCECHAT_CONTROL_COMMAND} admin list`,
    `添加管理员：/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`,
    `移除管理员：/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`,
  ];

  return {
    text: lines.join("\n"),
    buttons: buildVoceChatAccessButtons(panelId, management.adminSenderIds),
  };
}

function buildVoceChatMainButtons(panelId: string): TelegramInlineKeyboardButton[][] {
  return [
    [
      { text: "概览", callback_data: buildVoceChatPanelCallback(panelId, "h") },
      { text: "账号", callback_data: buildVoceChatPanelCallback(panelId, "l") },
    ],
    [
      { text: "Webhook", callback_data: buildVoceChatPanelCallback(panelId, "w") },
      { text: "路由", callback_data: buildVoceChatPanelCallback(panelId, "r") },
    ],
    [
      { text: "权限", callback_data: buildVoceChatPanelCallback(panelId, "x") },
    ],
  ];
}

function buildVoceChatRoutingButtons(cfg: OpenClawConfig, panelId: string): TelegramInlineKeyboardButton[][] {
  const currentTarget = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID).defaultTo ?? "";
  const management = resolveVoceChatManagement(cfg);
  return [
    ...buildVoceChatQuickTargetRows(panelId, DEFAULT_ACCOUNT_ID, management.quickTargets, currentTarget, "routing"),
    [
      buildVoceChatCopyButton("复制默认目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`),
    ],
    [
      buildVoceChatCopyButton("复制指定账号目标", `/${VOCECHAT_CONTROL_COMMAND} set default-to default user:2`),
    ],
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatAccountDetailButtons(panelId: string, account: ResolvedAccount, cfg: OpenClawConfig): TelegramInlineKeyboardButton[][] {
  const currentTarget = account.defaultTo ?? "";
  const management = resolveVoceChatManagement(cfg);
  return [
    ...buildVoceChatQuickTargetRows(panelId, account.accountId, management.quickTargets, currentTarget, "account-detail", account.accountId),
    [
      buildVoceChatCopyButton("复制改目标命令", `/${VOCECHAT_CONTROL_COMMAND} set default-to ${account.accountId} user:2`),
    ],
    [
      { text: "返回概览", callback_data: buildVoceChatPanelCallback(panelId, "h") },
      { text: "账号列表", callback_data: buildVoceChatPanelCallback(panelId, "l") },
    ],
    [
      { text: "Webhook", callback_data: buildVoceChatPanelCallback(panelId, "w") },
      { text: "权限", callback_data: buildVoceChatPanelCallback(panelId, "x") },
    ],
    [
      { text: "路由", callback_data: buildVoceChatPanelCallback(panelId, "r") },
    ],
  ];
}

function buildVoceChatAccessButtons(panelId: string, adminSenderIds: string[]): TelegramInlineKeyboardButton[][] {
  const adminRows = adminSenderIds.map((senderId) => [{
    text: `删除 ${senderId}`,
    callback_data: buildVoceChatPanelCallback(panelId, "y", senderId),
  }]);

  return [
    [
      buildVoceChatCopyButton("复制查看管理员", `/${VOCECHAT_CONTROL_COMMAND} admin list`),
    ],
    [
      buildVoceChatCopyButton("复制添加管理员", `/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`),
    ],
    [
      buildVoceChatCopyButton("复制移除管理员", `/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`),
    ],
    ...adminRows,
    ...buildVoceChatMainButtons(panelId),
  ];
}

function buildVoceChatQuickTargetRows(
  panelId: string,
  accountId: string,
  quickTargets: VoceChatQuickTargets,
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  if (quickTargets.users.length > 0) {
    rows.push(buildVoceChatQuickTargetRow(panelId, accountId, quickTargets.users, currentTarget, returnAction, returnArg));
  }
  if (quickTargets.groups.length > 0) {
    rows.push(buildVoceChatQuickTargetRow(panelId, accountId, quickTargets.groups, currentTarget, returnAction, returnArg));
  }
  return rows;
}

function buildVoceChatQuickTargetRow(
  panelId: string,
  accountId: string,
  targets: string[],
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton[] {
  return targets.map((targetRaw) =>
    buildVoceChatQuickTargetButton(panelId, accountId, targetRaw, currentTarget, returnAction, returnArg),
  );
}

function buildVoceChatQuickTargetButton(
  panelId: string,
  accountId: string,
  targetRaw: string,
  currentTarget: string,
  returnAction: "routing" | "account-detail",
  returnArg = "",
): TelegramInlineKeyboardButton {
  const isCurrent = currentTarget === targetRaw;
  return {
    text: `${isCurrent ? "✅ " : "设为 "}${targetRaw}`,
    style: isCurrent ? "primary" : "success",
    callback_data: buildVoceChatPanelCallback(
      panelId,
      "t",
      buildVoceChatTargetMutationArg(accountId, targetRaw, returnAction, returnArg),
    ),
  };
}

function buildVoceChatTargetMutationArg(accountId: string, targetRaw: string, returnAction: "routing" | "account-detail", returnArg = ""): string {
  return [accountId, targetRaw, returnAction, returnArg].join("|");
}

function parseVoceChatTargetMutationArg(raw: string): { accountId: string; targetRaw: string; returnAction: VoceChatPanelAction; returnArg: string } | null {
  const [accountIdRaw = DEFAULT_ACCOUNT_ID, targetRaw = "", returnActionRaw = "routing", returnArg = ""] = raw.split("|");
  if (!parseTarget(targetRaw)) return null;
  const returnAction = decodeVoceChatPanelAction(returnActionRaw);
  return {
    accountId: normalizeAccountId(accountIdRaw || DEFAULT_ACCOUNT_ID),
    targetRaw,
    returnAction,
    returnArg,
  };
}

function buildVoceChatCopyButton(text: string, command: string): TelegramInlineKeyboardButton {
  return {
    text,
    style: "primary",
    copy_text: { text: command },
  };
}

function buildVoceChatAccountButtons(panelId: string, accounts: ResolvedAccount[]): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  let row: TelegramInlineKeyboardButton[] = [];

  for (const account of accounts) {
    row.push({
      text: `${account.enabled ? "✅" : "⛔"}${account.accountId}`,
      callback_data: buildVoceChatPanelCallback(panelId, "a", account.accountId),
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length > 0) rows.push(row);
  rows.push([{ text: "返回概览", callback_data: buildVoceChatPanelCallback(panelId, "h") }]);
  return rows;
}

function buildVoceChatPanelCallback(panelId: string, action: "h" | "l" | "a" | "w" | "r" | "x" | "y" | "z" | "t", arg?: string): string {
  return arg
    ? `/${VOCECHAT_CONTROL_COMMAND} p ${panelId} ${action} ${arg}`
    : `/${VOCECHAT_CONTROL_COMMAND} p ${panelId} ${action}`;
}

function parseVoceChatCommandArgs(rawArgs: string): VoceChatParsedCommand {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === "p" && tokens[1]) {
    return {
      panelId: tokens[1],
      action: decodeVoceChatPanelAction(tokens[2]),
      arg: tokens.slice(3).join(" "),
    };
  }
  return {
    panelId: null,
    action: decodeVoceChatPanelAction(tokens[0]),
    arg: tokens.slice(1).join(" "),
  };
}

function decodeVoceChatPanelAction(raw: string | undefined): VoceChatPanelAction {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "l":
    case "list":
    case "accounts":
      return "accounts";
    case "a":
    case "account":
    case "detail":
      return "account-detail";
    case "w":
    case "webhook":
      return "webhook";
    case "r":
    case "routing":
    case "route":
      return "routing";
    case "x":
    case "access":
    case "auth":
      return "access";
    case "y":
    case "admin-remove-confirm":
      return "admin-remove-confirm";
    case "z":
    case "admin-remove":
      return "admin-remove";
    case "t":
    case "set-default-target":
      return "set-default-target";
    case "h":
    case "home":
    case "menu":
    case "status":
    default:
      return "home";
  }
}

function formatVoceChatGroupPolicy(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "open":
      return "开放";
    case "allowlist":
      return "白名单";
    case "denylist":
      return "黑名单";
    case "":
      return "未设置";
    default:
      return value;
  }
}

function formatVoceChatAdminMode(adminSenderIds: string[]): string {
  return adminSenderIds.length > 0 ? `插件白名单（${adminSenderIds.length}）` : "继承宿主授权";
}

function formatVoceChatTemplateState(current: string, defaultTemplate: string): string {
  return current === defaultTemplate ? "默认" : "已自定义";
}

function formatVoceChatCountPreview(entries: string[]): string {
  if (entries.length === 0) return "0";
  return `${entries.length}（${formatVoceChatMaskedEntries(entries)}）`;
}

function formatVoceChatMaskedEntries(entries: string[], max = 3): string {
  if (entries.length === 0) return "未设置";
  const preview = entries.slice(0, max).map(maskVoceChatEntry).join("、");
  return entries.length > max ? `${preview} 等 ${entries.length} 项` : preview;
}

function maskVoceChatEntry(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "<空>";
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    return `${parts[0]}:${maskVoceChatSegment(parts.slice(1).join(":"))}`;
  }
  return maskVoceChatSegment(trimmed);
}

function maskVoceChatSegment(value: string): string {
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-1)}`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

async function maybeHandleVoceChatEditCommand(rawArgs: string, cfg: OpenClawConfig): Promise<ReplyPayload | null> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0] === "p" && tokens[1]) return null;

  switch (tokens[0].toLowerCase()) {
    case "admin":
    case "admins":
      return await handleVoceChatAdminEditCommand(tokens.slice(1), cfg);
    case "set":
      return await handleVoceChatSetCommand(tokens.slice(1), cfg);
    case "default-to":
    case "target":
      return await handleVoceChatDefaultTargetCommand(tokens.slice(1), cfg);
    default:
      return null;
  }
}

async function handleVoceChatAdminEditCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload> {
  const management = resolveVoceChatManagement(cfg);
  const action = (args[0] ?? "list").trim().toLowerCase();

  if (action === "list") {
    return {
      text: [
        "VoceChat 管理员设置",
        "",
        `当前管理员数量：${management.adminSenderIds.length}`,
        `管理员列表：${management.adminSenderIds.length > 0 ? management.adminSenderIds.join("、") : "未设置（继承宿主授权）"}`,
        "",
        `添加：/${VOCECHAT_CONTROL_COMMAND} admin add telegram:123456789`,
        `移除：/${VOCECHAT_CONTROL_COMMAND} admin remove telegram:123456789`,
        `清空：/${VOCECHAT_CONTROL_COMMAND} admin clear`,
      ].join("\n"),
    };
  }

  if (action === "add") {
    const senderId = normalizeIdentity(args.slice(1).join(" "));
    if (!senderId) {
      return { text: `用法：/${VOCECHAT_CONTROL_COMMAND} admin add <发送者ID>`, isError: true };
    }
    const summary = await updateVoceChatHostConfig((channelConfig) => {
      const managementSection = ensureMutableRecord(channelConfig, "management");
      const current = parseAllowEntries(managementSection.adminSenderIds);
      const merged = Array.from(new Set([...current.map(normalizeIdentity), senderId])).filter(Boolean);
      managementSection.adminSenderIds = merged;
      return `已添加管理员：${senderId}`;
    });
    return buildVoceChatMutationReply(summary);
  }

  if (action === "remove") {
    const senderId = normalizeIdentity(args.slice(1).join(" "));
    if (!senderId) {
      return { text: `用法：/${VOCECHAT_CONTROL_COMMAND} admin remove <发送者ID>`, isError: true };
    }
    const summary = await updateVoceChatAdminRemoval(senderId);
    return buildVoceChatMutationReply(summary);
  }

  if (action === "clear") {
    const summary = await updateVoceChatHostConfig((channelConfig) => {
      const managementSection = ensureMutableRecord(channelConfig, "management");
      managementSection.adminSenderIds = [];
      return "已清空管理员白名单，将回退为宿主授权控制。";
    });
    return buildVoceChatMutationReply(summary);
  }

  return {
    text: [
      "VoceChat 管理员设置",
      "",
      `不支持的动作：${action}`,
      `可用：/${VOCECHAT_CONTROL_COMMAND} admin list|add|remove|clear`,
    ].join("\n"),
    isError: true,
  };
}

async function handleVoceChatSetCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload | null> {
  const field = (args[0] ?? "").trim().toLowerCase();
  switch (field) {
    case "default-to":
    case "default":
    case "target":
      return await handleVoceChatDefaultTargetCommand(args.slice(1), cfg);
    default:
      return {
        text: [
          "VoceChat 配置编辑",
          "",
          `不支持的字段：${field || "<空>"}`,
          `可用：/${VOCECHAT_CONTROL_COMMAND} set default-to <目标>`,
          `或：/${VOCECHAT_CONTROL_COMMAND} set default-to <账号ID> <目标>`,
        ].join("\n"),
        isError: true,
      };
  }
}

async function updateVoceChatAdminRemoval(senderId: string): Promise<string> {
  return await updateVoceChatHostConfig((channelConfig) => {
    const managementSection = ensureMutableRecord(channelConfig, "management");
    const current = parseAllowEntries(managementSection.adminSenderIds).map(normalizeIdentity).filter(Boolean);
    managementSection.adminSenderIds = current.filter((entry) => entry !== senderId);
    return `已移除管理员：${senderId}`;
  });
}

async function updateVoceChatDefaultTarget(accountId: string, targetRaw: string): Promise<string> {
  return await updateVoceChatHostConfig((channelConfig) => {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      const accounts = asRecord(channelConfig.accounts);
      const defaultAccountSection = asRecord(accounts[DEFAULT_ACCOUNT_ID]);
      if (Object.keys(defaultAccountSection).length > 0) {
        const mutableAccounts = ensureMutableRecord(channelConfig, "accounts");
        const mutableDefault = ensureMutableRecord(mutableAccounts, DEFAULT_ACCOUNT_ID);
        mutableDefault.defaultTo = targetRaw;
      } else {
        channelConfig.defaultTo = targetRaw;
      }
      return `已更新默认账号目标：${targetRaw}`;
    }

    const accounts = ensureMutableRecord(channelConfig, "accounts");
    const accountSection = ensureMutableRecord(accounts, accountId);
    accountSection.defaultTo = targetRaw;
    return `已更新账号 ${accountId} 的默认目标：${targetRaw}`;
  });
}

async function handleVoceChatDefaultTargetCommand(args: string[], cfg: OpenClawConfig): Promise<ReplyPayload> {
  const currentDefault = resolveVoceChatAccount(cfg, DEFAULT_ACCOUNT_ID);
  if (args.length === 0) {
    return {
      text: [
        "VoceChat 默认目标设置",
        "",
        `当前默认账号：${currentDefault.accountId}`,
        `当前默认目标：${currentDefault.defaultTo ?? "<未设置>"}`,
        "",
        `设置默认账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to user:2`,
        `设置指定账号目标：/${VOCECHAT_CONTROL_COMMAND} set default-to backup user:5`,
      ].join("\n"),
    };
  }

  const single = parseTarget(args[0]);
  let accountId = DEFAULT_ACCOUNT_ID;
  let targetRaw = "";

  if (args.length === 1 && single) {
    targetRaw = `${single.kind}:${single.id}`;
  } else if (args.length >= 2) {
    accountId = normalizeAccountId(args[0]);
    const parsedTarget = parseTarget(args.slice(1).join(" "));
    if (!parsedTarget) {
      return {
        text: [
          "VoceChat 默认目标设置",
          "",
          "目标格式无效。",
          "示例：user:2 或 group:12345",
        ].join("\n"),
        isError: true,
      };
    }
    targetRaw = `${parsedTarget.kind}:${parsedTarget.id}`;
  } else {
    return {
      text: [
        "VoceChat 默认目标设置",
        "",
        "目标格式无效。",
        "示例：user:2 或 group:12345",
      ].join("\n"),
      isError: true,
    };
  }

  const summary = await updateVoceChatDefaultTarget(accountId, targetRaw);

  return buildVoceChatMutationReply(summary);
}

function buildVoceChatMutationReply(summary: string): ReplyPayload {
  return {
    text: [
      "VoceChat 配置已更新",
      "",
      summary,
      "宿主将按通道配置自动热重载。",
      `可重新发送 /${VOCECHAT_CONTROL_COMMAND} 查看最新状态。`,
    ].join("\n"),
  };
}

function isVoceChatAdminAuthorized(ctx: PluginCommandContext, management: VoceChatManagementConfig): boolean {
  if (!ctx.isAuthorizedSender) return false;
  const admins = management.adminSenderIds.map(normalizeIdentity).filter(Boolean);
  if (admins.length === 0) return true;
  const candidates = new Set<string>();
  for (const value of [ctx.senderId, ctx.from]) {
    const normalized = normalizeIdentity(value);
    if (!normalized) continue;
    candidates.add(normalized);
    if (!normalized.includes(":")) {
      candidates.add(normalizeIdentity(`${ctx.channel}:${normalized}`));
    }
  }
  return [...candidates].some((candidate) => admins.includes(candidate));
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function resolveVoceChatTelegramRuntime(cfg: OpenClawConfig): { botToken: string; apiBaseUrl?: string; proxyUrl?: string | null } | null {
  const telegram = asRecord(cfg.channels?.telegram);
  const botToken = normalizeString(telegram.botToken);
  if (!botToken) return null;
  return {
    botToken,
    apiBaseUrl: normalizeString(telegram.apiBaseUrl) || undefined,
    proxyUrl: normalizeString(telegram.proxy) || undefined,
  };
}

const plugin = {
  id: CHANNEL_ID,
  name: "VoceChat Channel",
  description: "VoceChat inbound/outbound channel integration",
  register(api: OpenClawPluginApi) {
    setVoceChatRuntime(api.runtime);
    api.registerChannel({ plugin: voceChatChannel });
    registerVoceChatManagementCommand(api);
  },
};

export default plugin;
