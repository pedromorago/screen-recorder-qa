"use strict";

// Creación de issues en Jira/Linear a partir del informe de grabación.
// Sin dependencias de chrome.*: se carga con importScripts() en el service
// worker, con <script> en options.html y en los tests. Las credenciales
// viven en chrome.storage.local (issueReporter) y nunca aquí.
//
// Jira: REST v2 (acepta descripción en texto plano; la v3 exige ADF).
// Linear: GraphQL con API key personal; el team se da por su KEY visible
// (p. ej. "QA") y se resuelve a id con una query previa.

const LINEAR_URL_DEFAULT = "https://api.linear.app/graphql";

const clipErr = (s) => {
  s = String(s || "");
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
};

const trimBase = (u) => String(u || "").replace(/\/+$/, "");

// ---------- Jira ----------

function buildJiraCreate(cfg, title, body) {
  return {
    url: trimBase(cfg.siteUrl) + "/rest/api/2/issue",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(cfg.email + ":" + cfg.apiToken),
      },
      body: JSON.stringify({
        fields: {
          project: { key: cfg.projectKey },
          issuetype: { name: "Bug" },
          summary: title,
          description: body,
        },
      }),
    },
  };
}

async function jiraCreateIssue(cfg, title, body) {
  const { url, options } = buildJiraCreate(cfg, title, body);
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error("Jira respondió " + res.status + ": " + clipErr(await res.text()));
  }
  const data = await res.json();
  return { key: data.key, url: trimBase(cfg.siteUrl) + "/browse/" + data.key };
}

// ---------- Linear ----------

function linearRequest(cfg, query, variables) {
  return fetch(cfg.apiUrl || LINEAR_URL_DEFAULT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
}

async function linearQuery(cfg, query, variables) {
  const res = await linearRequest(cfg, query, variables);
  if (!res.ok) {
    throw new Error("Linear respondió " + res.status + ": " + clipErr(await res.text()));
  }
  const data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error("Linear: " + clipErr(data.errors[0].message));
  }
  return data.data;
}

async function linearResolveTeamId(cfg) {
  const data = await linearQuery(
    cfg,
    "query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
    { key: cfg.teamKey }
  );
  const nodes = (data.teams && data.teams.nodes) || [];
  if (!nodes.length) throw new Error('Linear: no existe un equipo con clave "' + cfg.teamKey + '"');
  return nodes[0].id;
}

async function linearCreateIssue(cfg, title, body) {
  const teamId = await linearResolveTeamId(cfg);
  const data = await linearQuery(
    cfg,
    "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
    { input: { teamId, title, description: body } }
  );
  const out = data.issueCreate;
  if (!out || !out.success || !out.issue) throw new Error("Linear no confirmó la creación");
  return { key: out.issue.identifier, url: out.issue.url };
}

// ---------- API común ----------

// cfgAll = { provider: "none"|"jira"|"linear", autoCreate, jira: {...}, linear: {...} }
async function createIssueFromReport(cfgAll, title, body) {
  if (cfgAll && cfgAll.provider === "jira") return jiraCreateIssue(cfgAll.jira || {}, title, body);
  if (cfgAll && cfgAll.provider === "linear") return linearCreateIssue(cfgAll.linear || {}, title, body);
  throw new Error("No hay proveedor de issues configurado");
}

// Verificación de credenciales sin crear nada.
async function testIssueConnection(cfgAll) {
  if (cfgAll && cfgAll.provider === "jira") {
    const cfg = cfgAll.jira || {};
    const res = await fetch(trimBase(cfg.siteUrl) + "/rest/api/2/myself", {
      headers: { Authorization: "Basic " + btoa(cfg.email + ":" + cfg.apiToken) },
    });
    if (!res.ok) throw new Error("Jira respondió " + res.status);
    const me = await res.json();
    return "Conectado a Jira como " + (me.displayName || me.emailAddress || "usuario");
  }
  if (cfgAll && cfgAll.provider === "linear") {
    const data = await linearQuery(cfgAll.linear || {}, "query { viewer { name } }", {});
    return "Conectado a Linear como " + ((data.viewer && data.viewer.name) || "usuario");
  }
  throw new Error("Elige un proveedor primero");
}
