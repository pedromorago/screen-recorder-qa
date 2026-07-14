"use strict";

// Servidor estático para los tests E2E: sirve la raíz del repo (los tests
// cargan los scripts REALES de la extensión) más unos endpoints /api/* de
// utilería para provocar respuestas 200/500 y cabeceras conocidas.
// Separado de cypress.config.js para poder reutilizarlo fuera de Cypress.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function handler(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/ok") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Test-Header": "hola",
    });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/api/error") {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("boom");
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no existe");
    return;
  }

  const rel = path.normalize(url.pathname).replace(/^([/\\])+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no encontrado");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
}

let server = null;

function startServer(port) {
  if (server) return Promise.resolve(server);
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(port, () => resolve(server));
    server.on("error", (e) => {
      server = null;
      // Otro proceso (cypress open + run a la vez) ya lo tiene levantado.
      if (e.code === "EADDRINUSE") resolve(null);
      else reject(e);
    });
  });
}

module.exports = { startServer, PORT: 4173 };
