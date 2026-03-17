import express from "express";
import type { Request, Response } from "express";
import { bot } from "./bot";
import { sessions } from "./agent/state";
import { apiPost } from "./api/http";
import { LOGIN_URL } from "./api/urls";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Para soportar envíos de formularios HTML

// Logger simple para ver CUALQUIER petición que llegue
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Página visual para mostrar el formulario de login y procesarlo internamente
app.get("/login/:chatId", (req, res) => {
  const { chatId } = req.params;
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f7f6; }
          .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 320px; }
          h2 { margin-top: 0; color: #333; text-align: center; }
          input { width: 100%; padding: 0.8rem; margin: 0.5rem 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
          button { width: 100%; padding: 0.8rem; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
          button:hover { background: #45a049; }
          .logo { text-align: center; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo"><b>DoctorRecetas</b></div>
          <h2>Iniciar Sesión</h2>
          <form action="/auth/internal-login" method="POST">
            <input type="hidden" name="chatId" value="${chatId}">
            <input type="text" name="usuario" placeholder="Usuario" required>
            <input type="password" name="clave" placeholder="Contraseña" required>
            <button type="submit">Entrar</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Procesa el login internamente llamando a la API de DoctorRecetas
app.post("/auth/internal-login", async (req: Request, res: Response) => {
  const { chatId, usuario, clave } = req.body;

  try {
    const resp = await apiPost(LOGIN_URL, { usuario, clave });

    if (resp["success"]) {
      const data = (resp["data"] ?? {}) as Record<string, any>;
      const token = data["token"];
      
      sessions.set(Number(chatId), {
        token,
        user_id: data["us_id"] || "",
        name: data["us_nombres"] || "Usuario",
        es_vip: !!data["es_vip"]
      });

      // Notificar al bot de Telegram
      await bot.sendMessage(
        Number(chatId),
        `¡Bienvenido <b>${data["us_nombres"]}</b>! ✅\n\nTu sesión ha sido iniciada correctamente desde la web.`,
        { parse_mode: "HTML" }
      );

      return res.redirect("/auth/success");
    } else {
      return res.status(401).send(`
        <script>
          alert("Error: ${resp["error"] || 'Credenciales incorrectas'}");
          window.history.back();
        </script>
      `);
    }
  } catch (err) {
    console.error("Error en login interno:", err);
    return res.status(500).send("Error procesando el inicio de sesión.");
  }
});

// Página visual para cerrar el navegador automáticamente tras el login
app.get("/auth/success", (req, res) => {
  res.send(`
    <html>
      <body style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; text-align: center;">
        <h1 style="color: #4CAF50;">✅ ¡Sesión vinculada!</h1>
        <p>Ya puedes cerrar esta ventana y volver a Telegram.</p>
        <p><i>Redirigiendo de vuelta al chat...</i></p>
        <script>
          // Intenta abrir el bot de nuevo para forzar el cambio de app
          window.location.href = "tg://resolve?domain=DoctorRecetasBot";
          // Cierra la pestaña después de un breve momento
          setTimeout(() => { window.close(); }, 2000);
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en el puerto ${PORT}...`);
});

