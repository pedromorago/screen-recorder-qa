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

// Última petición recibida por los mocks de Jira/Linear, para que los
// tests puedan asertar headers y cuerpo.
const lastMock = {};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

async function mockHandler(req, res, url) {
  if (url.pathname === "/mock/__last") {
    json(res, 200, lastMock);
    return true;
  }
  if (url.pathname === "/mock/jira/rest/api/2/issue" && req.method === "POST") {
    lastMock.jira = { authorization: req.headers.authorization, body: JSON.parse(await readBody(req)) };
    json(res, 201, { id: "10001", key: "QA-123" });
    return true;
  }
  if (url.pathname === "/mock/jira/rest/api/2/myself") {
    lastMock.jiraMyself = { authorization: req.headers.authorization };
    json(res, 200, { displayName: "Tester de Prueba" });
    return true;
  }
  if (url.pathname === "/mock/jira-roto/rest/api/2/issue" && req.method === "POST") {
    await readBody(req);
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("credenciales inválidas");
    return true;
  }
  if (url.pathname === "/mock/linear/graphql" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    lastMock.linear = { authorization: req.headers.authorization, body };
    if (body.query.includes("teams(")) {
      json(res, 200, { data: { teams: { nodes: [{ id: "team-uuid-1" }] } } });
    } else if (body.query.includes("issueCreate")) {
      json(res, 200, {
        data: {
          issueCreate: {
            success: true,
            issue: { identifier: "QA-7", url: "https://linear.app/demo/issue/QA-7" },
          },
        },
      });
    } else if (body.query.includes("viewer")) {
      json(res, 200, { data: { viewer: { name: "Tester de Prueba" } } });
    } else {
      json(res, 200, { data: {} });
    }
    return true;
  }
  return false;
}

function handler(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/mock/")) {
    mockHandler(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("mock no definido");
      }
    });
    return;
  }

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
