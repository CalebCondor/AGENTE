// src/bot.ts
import TelegramBot from "node-telegram-bot-api";
import { runAgent } from "./agent/loop";
import { conversations, sessions, ANTHROPIC_MODEL } from "./agent/state";
import { apiPost } from "./api/http";
import { LOGIN_URL } from "./api/urls";
import { initDb, db } from "./agent/db";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

// Inicializar DB al arrancar el bot
initDb().then(() => {
  console.info("Database initialized successfully.");
}).catch(err => {
  console.error("Database initialization failed:", err);
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Limpiar WebHooks previos para evitar conflictos de sesiones duplicadas (Error 409)
bot.deleteWebHook().then(() => {
  console.info("WebHook eliminado para evitar conflictos.");
}).catch(err => {
  console.warn("Error al eliminar WebHook:", err.message);
});

console.info(`Bot iniciado: ${ANTHROPIC_MODEL} | DoctorRecetas agent tool_use`);

// ── /start ────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  await bot.sendMessage(
    chatId,
    "Hola! Soy el asistente de <b>DoctorRecetas</b> \u{1F916}\n\n" +
      "Puedo ayudarte con cualquier cosa de la plataforma. " +
      "Solo escribeme en lenguaje natural \u{1F4AC}\n\n" +
      "<b>Comandos:</b>\n" +
      "/login usuario clave \u2014 Iniciar sesion\n" +
      "/logout \u2014 Cerrar sesion\n" +
      "/reset \u2014 Borrar historial\n\n" +
      "<b>Ejemplos de preguntas:</b>\n" +
      "\u2022 Cuales son mis ordenes?\n" +
      "\u2022 Dame el enlace de descarga de mi ultima compra\n" +
      "\u2022 Que productos tienen disponibles?\n" +
      "\u2022 Muestra mis pagos recientes\n" +
      "\u2022 Actualiza mi email a nuevo@mail.com",
    { parse_mode: "HTML" },
  );
});

// ── /reset ────────────────────────────────────────────────────────────
bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  await bot.sendMessage(chatId, "Historial local limpiado, pero mi memoria persistente sigue intacta. ¡Dime en qué puedo ayudarte!");
});

// ── /login usuario clave ──────────────────────────────────────────────
bot.onText(/\/login(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = (match?.[1] ?? "").trim().split(/\s+/);
  if (args.length < 2 || !args[0] || !args[1]) {
    await bot.sendMessage(chatId, "Uso: /login usuario clave");
    return;
  }
  const [usuario, clave] = args;
  await bot.sendChatAction(chatId, "typing");
  const resp = await apiPost(LOGIN_URL, { usuario, clave });

  if (resp["success"]) {
    const data = (resp["data"] ?? {}) as Record<string, unknown>;
    const token = data["token"] as string | undefined;
    if (!token) {
      await bot.sendMessage(chatId, "Error: no se recibio token del servidor.");
      return;
    }
    sessions.set(chatId, {
      token,
      user_id: (data["us_id"] as string | number) ?? "",
      name: (data["us_nombres"] as string) ?? "",
      es_vip: Boolean(data["es_vip"]),
      expires_in: data["expires_in"] as number | undefined,
    });
    const s = sessions.get(chatId)!;
    const vip = s.es_vip ? " ⭐ VIP" : "";
    await bot.sendMessage(
      chatId,
      `Bienvenido <b>${s.name}</b>${vip}! ✅\n\nYa puedes preguntarme sobre tus ordenes, pagos, perfil y productos.`,
      { parse_mode: "HTML" },
    );
  } else {
    await bot.sendMessage(
      chatId,
      `Login fallido: ${(resp["error"] as string) ?? "Credenciales incorrectas."}`,
    );
  }
});

// ── /logout ───────────────────────────────────────────────────────────
bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  if (sessions.has(chatId)) {
    const name = sessions.get(chatId)?.name ?? "";
    sessions.delete(chatId);
    await bot.sendMessage(chatId, `Hasta luego, ${name}. Sesion cerrada. 👋`);
  } else {
    await bot.sendMessage(chatId, "No estas logueado.");
  }
});

// ── Text messages ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return;
  // Skip commands (handled above)
  if (msg.text.startsWith("/")) return;
  await runAgent(bot, msg.chat.id, msg.text);
});

