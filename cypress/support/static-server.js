"use strict";

// Static server for the E2E tests: serves the repo root (tests load the
// extension's REAL scripts) plus /api/* utility endpoints to provoke
// 200/500 responses and known headers. Kept separate from
// cypress.config.js so it can be reused outside Cypress.

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

// Last request received by the Jira/Linear mocks, so tests can assert
// headers and body.
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
    json(res, 200, { displayName: "Test User" });
    return true;
  }
  if (url.pathname === "/mock/jira-broken/rest/api/2/issue" && req.method === "POST") {
    await readBody(req);
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("invalid credentials");
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
      json(res, 200, { data: { viewer: { name: "Test User" } } });
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
        res.end("mock not defined");
      }
    });
    return;
  }

  if (url.pathname === "/api/ok") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Test-Header": "hello",
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
    res.end("does not exist");
    return;
  }

  const rel = path.normalize(url.pathname).replace(/^([/\\])+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
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
      // Another process (cypress open + run at once) already started it.
      if (e.code === "EADDRINUSE") resolve(null);
      else reject(e);
    });
  });
}

module.exports = { startServer, PORT: 4173 };
