// src/agent/loop.ts
// Bucle agéntico: Claude decide qué tools llamar, se ejecutan y se retroalimenta hasta dar respuesta final

import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { client, ANTHROPIC_MODEL, conversations } from "./state";
import { TOOLS } from "./tools";
import { executeTool } from "./executor";
import { buildSystem } from "./system";
import { db } from "./db";

/** Carga el historial desde la base de datos si la memoria en vivo está vacía */
async function loadHistoryIfEmpty(chatId: number): Promise<Anthropic.MessageParam[]> {
  if (!conversations.has(chatId)) {
    try {
      const { rows } = await db.query(
        "SELECT role, content FROM historial_mensajes WHERE chat_id = $1 ORDER BY created_at ASC LIMIT 50",
        [chatId]
      );
      const history = rows.map(r => {
        let content = r.content;
        if (typeof content === 'string') {
          try {
            content = JSON.parse(content);
          } catch (e) {
            // Si no es JSON válido (ej: texto plano de versiones anteriores), lo usamos tal cual
          }
        }
        return { role: r.role, content };
      }) as Anthropic.MessageParam[];
      conversations.set(chatId, history);
    } catch (e) {
      console.error(`[loop] Error loading history: ${e}`);
      conversations.set(chatId, []);
    }
  }
  return conversations.get(chatId)!;
}

/**
 * Elimina pares tool_use/tool_result huérfanos y normalizatodo content a string o array.
 * Anthropic rechaza: content null/undefined/object-no-array, y tool_use sin su tool_result.
 */
function normalizeMessages(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Paso 1: normalizar content de cada mensaje individualmente
  const fixed = msgs.map((m) => {
    let content: any = m.content;

    // null / undefined → valor seguro por defecto
    if (content === null || content === undefined) {
      content = m.role === "assistant" ? [] : "";
    }

    // objeto plano (no array) → envolverlo en array
    if (!Array.isArray(content) && typeof content === "object") {
      content = [content];
    }

    // assistant con string → convertir a array de text blocks (Anthropic lo exige cuando hay tools)
    if (m.role === "assistant" && typeof content === "string") {
      content = [{ type: "text" as const, text: content }];
    }

    return { role: m.role, content } as Anthropic.MessageParam;
  });

  // Paso 2: eliminar pares huérfanos (tool_use sin tool_result siguiente, y viceversa)
  const result: Anthropic.MessageParam[] = [];
  for (let i = 0; i < fixed.length; i++) {
    const m = fixed[i];

    if (m.role === "assistant" && Array.isArray(m.content)) {
      const hasToolUse = m.content.some((b: any) => b?.type === "tool_use");
      if (hasToolUse) {
        const next = fixed[i + 1];
        const nextHasResult =
          next?.role === "user" &&
          Array.isArray(next.content) &&
          next.content.some((b: any) => b?.type === "tool_result");
        if (!nextHasResult) {
          console.warn("[loop] Dropped orphaned tool_use assistant message");
          continue;
        }
      }
    }

    if (m.role === "user" && Array.isArray(m.content)) {
      const hasToolResult = m.content.some((b: any) => b?.type === "tool_result");
      if (hasToolResult) {
        const prev = result[result.length - 1];
        const prevHasToolUse =
          prev?.role === "assistant" &&
          Array.isArray(prev.content) &&
          prev.content.some((b: any) => b?.type === "tool_use");
        if (!prevHasToolUse) {
          console.warn("[loop] Dropped orphaned tool_result user message");
          continue;
        }
      }
    }

    result.push(m);
  }

  return result;
}

/** Guarda un mensaje en la base de datos */
async function persistMessage(chatId: number, role: string, content: any): Promise<void> {
  try {
    await db.query(
      "INSERT INTO historial_mensajes (chat_id, role, content) VALUES ($1, $2, $3)",
      [chatId, role, JSON.stringify(content)]
    );
  } catch (e) {
    console.error(`[loop] Error persisting message: ${e}`);
  }
}

/** Elimina todas las etiquetas HTML dejando solo el texto plano */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|i|u|s|code|pre|a)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

/** Envía con parse_mode HTML; si Telegram lo rechaza, reintenta en texto plano */
async function sendSafe(
  bot: TelegramBot,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("can't parse entities") || msg.includes("Bad Request")) {
      console.warn(`[loop] HTML inválido, enviando como texto plano. Error: ${msg}`);
      await bot.sendMessage(chatId, stripHtml(text), {
        disable_web_page_preview: true,
      });
    } else {
      throw e;
    }
  }
}

/**
 * Núcleo del agente. Desacoplado del transporte.
 * - onText(text): llamado con cada bloque de texto final (incluyendo formatted_html)
 * - onTyping(): llamado para indicar "escribiendo..."
 * Devuelve el texto final consolidado.
 */
async function runAgentCore(
  chatId: number,
  userText: string,
  onText: (text: string) => Promise<void>,
  onTyping: () => Promise<void>,
): Promise<string> {
  const history = await loadHistoryIfEmpty(chatId);
  history.push({ role: "user", content: userText });
  await persistMessage(chatId, "user", userText);
  if (history.length > 50) history.splice(0, history.length - 50);

  await onTyping();
  const messages: Anthropic.MessageParam[] = normalizeMessages([...history]);
  const collected: string[] = [];

  for (let round = 0; round < 10; round++) {
    const systemPrompt = await buildSystem(chatId);
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const finalText = textBlocks.join("\n").trim();
      if (finalText) {
        const finalContent: Anthropic.TextBlockParam[] = [{ type: "text", text: finalText }];
        history.push({ role: "assistant", content: finalContent });
        await persistMessage(chatId, "assistant", finalContent);
        collected.push(finalText);
        await onText(finalText);
      }
      return collected.join("\n");
    }

    messages.push({ role: "assistant", content: response.content });
    history.push({ role: "assistant", content: response.content });
    await persistMessage(chatId, "assistant", response.content);

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      console.info(`[agent] tool=${tu.name} input=${JSON.stringify(tu.input)}`);
      await onTyping();
      const resultStr = await executeTool(
        tu.name,
        tu.input as Record<string, unknown>,
        chatId,
      );
      console.info(`[agent] result=${resultStr.slice(0, 200)}`);

      // Si la herramienta devuelve formatted_html, enviarlo directamente
      try {
        const parsed = JSON.parse(resultStr);
        if (parsed.success && parsed.formatted_html) {
          collected.push(parsed.formatted_html);
          await onText(parsed.formatted_html);
        }
      } catch { /* no es JSON */ }

      // Strip formatted_html antes de devolver a Claude (ya entregado al usuario)
      let resultForClaude = resultStr;
      try {
        const parsed = JSON.parse(resultStr);
        if (parsed.formatted_html) {
          const { formatted_html: _, ...rest } = parsed;
          resultForClaude = JSON.stringify(rest);
        }
      } catch { /* no es JSON */ }

      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultForClaude });
    }
    messages.push({ role: "user", content: toolResults });
    history.push({ role: "user", content: toolResults });
    await persistMessage(chatId, "user", toolResults);
  }

  return collected.join("\n");
}

/** Limpia historial corrupto y reintenta con historial vacío */
async function retryWithFreshHistory(
  chatId: number,
  userText: string,
  onText: (text: string) => Promise<void>,
): Promise<void> {
  console.warn(`[loop] Historial corrupto para chat ${chatId}. Limpiando y reintentando...`);
  conversations.delete(chatId);
  try { await db.query("DELETE FROM historial_mensajes WHERE chat_id = $1", [chatId]); } catch {}
  const freshMessages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];
  const systemPrompt = await buildSystem(chatId);
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL, max_tokens: 2048, system: systemPrompt, tools: TOOLS, messages: freshMessages,
  });
  const finalText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text).join("\n").trim();
  if (finalText) {
    conversations.set(chatId, [
      { role: "user", content: userText },
      { role: "assistant", content: [{ type: "text", text: finalText }] },
    ]);
    await persistMessage(chatId, "user", userText);
    await persistMessage(chatId, "assistant", [{ type: "text", text: finalText }]);
    await onText(finalText);
  }
}

export async function runAgent(
  bot: TelegramBot,
  chatId: number,
  userText: string,
): Promise<void> {
  try {
    await runAgentCore(
      chatId,
      userText,
      async (text) => {
        for (let offset = 0; offset < Math.max(text.length, 1); offset += 4000) {
          await sendSafe(bot, chatId, text.slice(offset, offset + 4000));
        }
      },
      async () => { await bot.sendChatAction(chatId, "typing"); },
    );
  } catch (e) {
    const errStr = String(e);
    if (errStr.includes("valid list") || errStr.includes("400")) {
      try {
        await retryWithFreshHistory(chatId, userText, async (text) => {
          for (let offset = 0; offset < Math.max(text.length, 1); offset += 4000) {
            await sendSafe(bot, chatId, text.slice(offset, offset + 4000));
          }
        });
      } catch (retryErr) {
        console.error(`[loop] Retry failed: ${retryErr}`);
        await bot.sendMessage(chatId, "Ocurrió un error. Por favor intenta de nuevo.");
      }
      return;
    }
    console.error(`Agent error: ${e}`);
    await bot.sendMessage(chatId, "Ocurrió un error. Por favor intenta de nuevo.");
  }
}

/**
 * Versión HTTP del agente: misma lógica que runAgent pero devuelve el texto
 * en lugar de enviarlo a Telegram. Útil para el endpoint POST /api/chat.
 */
export async function runAgentApi(
  chatId: number,
  userText: string,
): Promise<string> {
  try {
    return await runAgentCore(chatId, userText, async () => {}, async () => {});
  } catch (e) {
    const errStr = String(e);
    if (errStr.includes("valid list") || errStr.includes("400")) {
      const parts: string[] = [];
      await retryWithFreshHistory(chatId, userText, async (text) => { parts.push(text); });
      return parts.join("\n");
    }
    throw e;
  }
}
