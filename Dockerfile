# Usar la imagen oficial de Bun
FROM oven/bun:1.1 AS base
WORKDIR /app

# Instalar dependencias
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copiar el código fuente
COPY . .

# Compilar si es necesario o simplemente ejecutar con bun
# Como es un bot con bun, podemos correrlo directamente desde src
# Pero para producción es mejor transpilar. De momento usaremos el modo dev/start.

EXPOSE 3000

CMD ["bun", "src/server.ts"]
