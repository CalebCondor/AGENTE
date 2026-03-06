// src/agent/state.ts
// Estado global compartido: cliente Anthropic, historial de mensajes y sesiones de usuario

import Anthropic from "@anthropic-ai/sdk";

// ── Modelo ────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

export const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Historial de conversaciones (por chat_id) ─────────────────────────
export const conversations = new Map<number, Anthropic.MessageParam[]>();

// ── Sesiones autenticadas (por chat_id) ───────────────────────────────
export interface SessionData {
  token: string;
  user_id: string | number;
  name: string;
  es_vip: boolean;
  expires_in?: number;
}

export const sessions = new Map<number, SessionData>();
