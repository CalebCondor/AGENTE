// src/agent/db.ts
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || '187.77.15.77',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'AGENTEIA',
  user: process.env.DB_USER || 'agente',
  password: process.env.DB_PASSWORD, // Debería estar en el .env
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};

export async function initDb() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS conocimiento_especifico (
      id SERIAL PRIMARY KEY,
      pregunta TEXT NOT NULL,
      respuesta TEXT NOT NULL,
      fuente TEXT DEFAULT 'aprendizaje_ia',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await db.query(createTableQuery);
    console.log('✅ Tabla conocimiento_especifico lista o ya existente.');
  } catch (err) {
    console.error('❌ Error inicializando DB:', err);
  }
}
