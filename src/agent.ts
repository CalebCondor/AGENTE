// src/agent.ts
// Barrel de re-exportaciones — la lógica está organizada en subcarpetas:
//   api/urls.ts       → endpoints de la API
//   api/http.ts       → helpers fetch (apiPost, apiGet)
//   agent/state.ts    → cliente Anthropic, sesiones, historial
//   agent/tools.ts    → definiciones de las tools
//   agent/executor.ts → ejecutor de tools
//   agent/system.ts   → system prompt dinámico
//   agent/loop.ts     → bucle agéntico principal

export * from "./agent/state";
export * from "./agent/tools";
export * from "./agent/executor";
export * from "./agent/system";
export * from "./agent/loop";
export * from "./api/urls";
export { apiPost, apiGet } from "./api/http";

