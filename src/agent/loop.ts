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

export async function runAgent(
  bot: TelegramBot,
  chatId: number,
  userText: string,
): Promise<void> {
  const history = await loadHistoryIfEmpty(chatId);

  const userMsg: Anthropic.MessageParam = { role: "user", content: userText };
  history.push(userMsg);
  await persistMessage(chatId, "user", userText);
  
  if (history.length > 50) history.splice(0, history.length - 50);

  await bot.sendChatAction(chatId, "typing");

  const messages: Anthropic.MessageParam[] = [...history];

  try {
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
        // Respuesta final — sin más tool calls
        const finalText = textBlocks.join("\n").trim();
        if (finalText) {
          history.push({ role: "assistant", content: finalText });
          await persistMessage(chatId, "assistant", finalText);
          
          for (
            let offset = 0;
            offset < Math.max(finalText.length, 1);
            offset += 4000
          ) {
            await sendSafe(bot, chatId, finalText.slice(offset, offset + 4000));
          }
        }
        return;
      }

      // Ejecutar cada tool y devolver resultados a Claude
      messages.push({ role: "assistant", content: response.content });
      history.push({ role: "assistant", content: response.content });
      await persistMessage(chatId, "assistant", response.content);

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        console.info(`[agent] tool=${tu.name} input=${JSON.stringify(tu.input)}`);
        await bot.sendChatAction(chatId, "typing");
        const resultStr = await executeTool(
          tu.name,
          tu.input as Record<string, unknown>,
          chatId,
        );
        console.info(`[agent] result=${resultStr.slice(0, 200)}`);

        // Si la herramienta devuelve formatted_html, lo enviamos directamente al usuario
        try {
          const parsed = JSON.parse(resultStr);
          if (parsed.success && parsed.formatted_html) {
            // Dividimos en bloques de ~4000 caracteres para evitar "message is too long"
            const text = parsed.formatted_html;
            for (let offset = 0; offset < text.length; offset += 4000) {
              await sendSafe(bot, chatId, text.slice(offset, offset + 4000));
            }
          }
        } catch (e) {
          // No es JSON o no tiene formatted_html, ignoramos
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: resultStr,
        });
      }
      messages.push({ role: "user", content: toolResults });
      history.push({ role: "user", content: toolResults });
      await persistMessage(chatId, "user", toolResults);
    }

    await bot.sendMessage(
      chatId,
      "No pude completar la solicitud. Por favor intenta de nuevo.",
    );
  } catch (e) {
    console.error(`Agent error: ${e}`);
    await bot.sendMessage(chatId, `Error: ${String(e).slice(0, 300)}`);
  }
}
