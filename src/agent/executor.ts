// src/agent/executor.ts
// Ejecuta la herramienta solicitada por Claude y devuelve el resultado como JSON string

import { sessions } from "./state";
import { apiPost, apiGet } from "../api/http";
import {
  PERFIL_URL,
  MIS_ORDENES_URL,
  MIS_PAGOS_URL,
  TODAS_LAS_ORDENES_URL,
  PRODUCTOS_BASE_URL,
} from "../api/urls";

const AUTH_REQUIRED = new Set([
  "get_perfil",
  "actualizar_perfil",
  "get_ordenes",
  "get_pagos",
]);

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  chatId: number,
): Promise<string> {
  const s = sessions.get(chatId);
  const token = s?.token;
  const userId = s?.user_id;

  if (AUTH_REQUIRED.has(toolName) && !s) {
    return JSON.stringify({
      success: false,
      error: "Usuario no autenticado. Debe iniciar sesion con /login usuario clave.",
    });
  }

  if (toolName === "get_perfil") {
    return JSON.stringify(await apiGet(PERFIL_URL, {}, token));
  }

  if (toolName === "actualizar_perfil") {
    const rawCampos = Object.assign(
      {},
      toolInput["campos"] as Record<string, unknown>,
    );

    // Mapea nombres genéricos a los campos reales de la API (prefijo us_)
    const FIELD_MAP: Record<string, string> = {
      nombre:            "us_nombres",
      nombres:           "us_nombres",
      name:              "us_nombres",
      email:             "us_email",
      correo:            "us_email",
      telefono:          "us_telefono",
      phone:             "us_telefono",
      pais:              "us_pais",
      country:           "us_pais",
      direccion:         "us_direccion",
      address:           "us_direccion",
      ciudad:            "us_ciudad",
      city:              "us_ciudad",
      fecha_nacimiento:  "us_fech_nac",
      fech_nac:          "us_fech_nac",
      codigo_postal:     "us_code_postal",
      code_postal:       "us_code_postal",
    };

    const camposNuevos: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawCampos)) {
      const mappedKey = FIELD_MAP[key.toLowerCase()] ?? key;
      camposNuevos[mappedKey] = value;
    }

    // Seguridad: no actualizar si no hay campos reales
    const camposReales = Object.keys(camposNuevos).filter((k) => k !== "us_id");
    if (camposReales.length === 0) {
      return JSON.stringify({
        success: false,
        error: "No se especificaron campos a actualizar.",
      });
    }

    // Obtener perfil actual para hacer merge y no perder datos existentes
    const perfilActual = await apiGet(PERFIL_URL, {}, token);
    const datosActuales =
      perfilActual["success"] && perfilActual["data"] && typeof perfilActual["data"] === "object"
        ? (perfilActual["data"] as Record<string, unknown>)
        : {};

    // Campos editables del perfil
    const PERFIL_FIELDS = [
      "us_nombres", "us_email", "us_telefono", "us_pais",
      "us_direccion", "us_ciudad", "us_fech_nac", "us_code_postal",
    ];

    // Construir payload completo: datos actuales + campos nuevos encima
    const payload: Record<string, unknown> = { us_id: userId };
    for (const field of PERFIL_FIELDS) {
      payload[field] = camposNuevos[field] ?? datosActuales[field] ?? "";
    }

    return JSON.stringify(await apiPost(PERFIL_URL, payload, token));
  }

  if (toolName === "get_ordenes") {
    return JSON.stringify(
      await apiGet(MIS_ORDENES_URL, { us_id: String(userId) }, token),
    );
  }

  if (toolName === "get_pagos") {
    return JSON.stringify(await apiPost(MIS_PAGOS_URL, {}, token));
  }

  if (toolName === "get_productos") {
    const raw = await apiGet(TODAS_LAS_ORDENES_URL);
    const busqueda = String(toolInput["busqueda"] ?? "").toLowerCase().trim();

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const allItems: Record<string, unknown>[] = [];
      for (const [category, products] of Object.entries(raw)) {
        if (Array.isArray(products)) {
          for (const p of products) {
            if (p && typeof p === "object") {
              const product = { ...p } as Record<string, unknown>;
              const rel = String(product["url"] ?? "");
              product["web_url"] = rel ? PRODUCTOS_BASE_URL + rel : "";
              product["categoria"] = category;
              allItems.push(product);
            }
          }
        }
      }
      const filtered = busqueda
        ? allItems.filter((p) =>
            String(p["titulo"] ?? p["nombre"] ?? p["producto"] ?? "")
              .toLowerCase()
              .includes(busqueda),
          )
        : allItems;
      return JSON.stringify({ success: true, data: filtered });
    }
    return JSON.stringify({ success: false, error: "Formato inesperado de la API" });
  }

  return JSON.stringify({ success: false, error: `Herramienta desconocida: ${toolName}` });
}
