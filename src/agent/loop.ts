// src/agent/loop.ts
// Bucle agéntico: Claude decide qué tools llamar, se ejecutan y se retroalimenta hasta dar respuesta final

import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { client, ANTHROPIC_MODEL, conversations } from "./state";
import { TOOLS } from "./tools";
import { executeTool } from "./executor";
import { buildSystem } from "./system";

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
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId)!;

  history.push({ role: "user", content: userText });
  if (history.length > 30) history.splice(0, history.length - 30);

  await bot.sendChatAction(chatId, "typing");

  const messages: Anthropic.MessageParam[] = [...history];

  try {
    for (let round = 0; round < 10; round++) {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: buildSystem(chatId),
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
