"use strict";

// Options page: issue provider configuration (Jira/Linear).
// The network logic lives in issue-reporter.js (shared with the SW).

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function showStatus(kind, text) {
  statusEl.className = kind;
  statusEl.textContent = text;
}

function readForm() {
  return {
    provider: $("provider").value,
    autoCreate: $("autoCreate").checked,
    jira: {
      siteUrl: $("jiraSiteUrl").value.trim(),
      email: $("jiraEmail").value.trim(),
      apiToken: $("jiraApiToken").value.trim(),
      projectKey: $("jiraProjectKey").value.trim(),
    },
    linear: {
      apiKey: $("linearApiKey").value.trim(),
      teamKey: $("linearTeamKey").value.trim(),
    },
  };
}

function fillForm(cfg) {
  $("provider").value = cfg.provider || "none";
  $("autoCreate").checked = !!cfg.autoCreate;
  $("jiraSiteUrl").value = (cfg.jira && cfg.jira.siteUrl) || "";
  $("jiraEmail").value = (cfg.jira && cfg.jira.email) || "";
  $("jiraApiToken").value = (cfg.jira && cfg.jira.apiToken) || "";
  $("jiraProjectKey").value = (cfg.jira && cfg.jira.projectKey) || "";
  $("linearApiKey").value = (cfg.linear && cfg.linear.apiKey) || "";
  $("linearTeamKey").value = (cfg.linear && cfg.linear.teamKey) || "";
  document.body.dataset.provider = $("provider").value;
}

$("provider").addEventListener("change", () => {
  document.body.dataset.provider = $("provider").value;
});

$("btnSave").addEventListener("click", async () => {
  await chrome.storage.local.set({ issueReporter: readForm() });
  showStatus("ok", "Saved.");
});

$("btnTest").addEventListener("click", async () => {
  showStatus("ok", "Testing…");
  try {
    const texto = await testIssueConnection(readForm());
    showStatus("ok", texto);
  } catch (e) {
    showStatus("error", "Connection failed: " + (e.message || e));
  }
});

(async () => {
  const { issueReporter } = await chrome.storage.local.get({ issueReporter: null });
  fillForm(issueReporter || { provider: "none" });
})();
