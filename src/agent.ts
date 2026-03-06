// src/agent.ts
import { Agent } from "@mastra/core/agent";
import { ollama } from "ollama-ai-provider-v2";
import {
  getDownloadFileTool,
  listFilesTool,
  querySqliteTool,
  readFileTool,
} from "./tools/storage-tools";

const ollamaModel = process.env.OLLAMA_MODEL || "qwen3.5:4b";

export const agent = new Agent({
  id: "telegram-agent",
  name: "Telegram Agent",
  instructions:
    "Eres un asistente útil para Telegram con acceso a archivos y datos. " +
    "Responde solo con datos obtenidos de herramientas; no inventes productos, precios, stocks o nombres. " +
    "Usa la herramienta list_files para listar archivos en 'documents' (documentos), 'data' (datos CSV/SQLite) o 'assets' (imágenes, videos). " +
    "Usa read_file para leer contenido de archivos legibles. " +
    "Usa query_sqlite solo para archivos .sqlite/.db. " +
    "Nunca uses query_sqlite para archivos CSV, Excel, Markdown o texto; usa read_file para esos. " +
    "Si no hay datos disponibles, dilo explícitamente en lugar de adivinar. " +
    "Para enviar archivos (imágenes, videos, PDFs, etc.), usa get_download_file con el scope correcto: 'assets' para multimedia, 'documents' o 'data' para otros archivos. " +
    "Proporciona respuestas directas y útiles basadas en los resultados de las herramientas.",
  model: ollama.chat(ollamaModel),
  tools: {
    list_files: listFilesTool,
    read_file: readFileTool,
    query_sqlite: querySqliteTool,
    get_download_file: getDownloadFileTool,
  },
});
