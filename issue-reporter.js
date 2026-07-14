"use strict";

// Jira/Linear issue creation from the recording report. No chrome.*
// dependencies: loaded with importScripts() in the service worker, with
// <script> in options.html and in the tests. Credentials live in
// chrome.storage.local (issueReporter) and never here.
//
// Jira: REST v2 (accepts a plain-text description; v3 requires ADF).
// Linear: GraphQL with a personal API key; the team is given by its
// visible KEY (e.g. "QA") and resolved to an id with a prior query.

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
    throw new Error("Jira responded " + res.status + ": " + clipErr(await res.text()));
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
    throw new Error("Linear responded " + res.status + ": " + clipErr(await res.text()));
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
  if (!nodes.length) throw new Error('Linear: no team exists with key "' + cfg.teamKey + '"');
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
  if (!out || !out.success || !out.issue) throw new Error("Linear did not confirm the creation");
  return { key: out.issue.identifier, url: out.issue.url };
}

// ---------- Shared API ----------

// cfgAll = { provider: "none"|"jira"|"linear", autoCreate, jira: {...}, linear: {...} }
async function createIssueFromReport(cfgAll, title, body) {
  if (cfgAll && cfgAll.provider === "jira") return jiraCreateIssue(cfgAll.jira || {}, title, body);
  if (cfgAll && cfgAll.provider === "linear") return linearCreateIssue(cfgAll.linear || {}, title, body);
  throw new Error("No issue provider configured");
}

// Credential check without creating anything.
async function testIssueConnection(cfgAll) {
  if (cfgAll && cfgAll.provider === "jira") {
    const cfg = cfgAll.jira || {};
    const res = await fetch(trimBase(cfg.siteUrl) + "/rest/api/2/myself", {
      headers: { Authorization: "Basic " + btoa(cfg.email + ":" + cfg.apiToken) },
    });
    if (!res.ok) throw new Error("Jira responded " + res.status);
    const me = await res.json();
    return "Connected to Jira as " + (me.displayName || me.emailAddress || "user");
  }
  if (cfgAll && cfgAll.provider === "linear") {
    const data = await linearQuery(cfgAll.linear || {}, "query { viewer { name } }", {});
    return "Connected to Linear as " + ((data.viewer && data.viewer.name) || "user");
  }
  throw new Error("Pick a provider first");
}
