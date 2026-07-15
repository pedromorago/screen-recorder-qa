"use strict";

// E2E for issue-reporter.js: the issue-creation logic (Jira REST v2 and
// Linear GraphQL) exercised with REAL fetch against the test server's
// mocks, which capture the received request so it can be asserted.

const jiraCfg = () => ({
  siteUrl: `${Cypress.config("baseUrl")}/mock/jira`,
  email: "tester@example.com",
  apiToken: "secret-token",
  projectKey: "QA",
});

const linearCfg = () => ({
  apiKey: "lin_api_secret",
  teamKey: "QA",
  apiUrl: `${Cypress.config("baseUrl")}/mock/linear/graphql`,
});

describe("issue-reporter.js (Jira/Linear)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.injectExtensionScript("issue-reporter.js");
  });

  it("builds the Jira request: URL, Basic auth and payload", () => {
    cy.window().then((win) => {
      const { url, options } = win.buildJiraCreate(jiraCfg(), "Title", "Body");
      expect(url).to.equal(`${Cypress.config("baseUrl")}/mock/jira/rest/api/2/issue`);
      expect(options.headers.Authorization).to.equal(
        "Basic " + win.btoa("tester@example.com:secret-token")
      );
      const payload = JSON.parse(options.body);
      expect(payload.fields.project.key).to.equal("QA");
      expect(payload.fields.issuetype.name).to.equal("Bug");
      expect(payload.fields.summary).to.equal("Title");
      expect(payload.fields.description).to.equal("Body");
    });
  });

  it("creates a Jira issue and returns key and link", () => {
    cy.window()
      .then((win) => win.jiraCreateIssue(jiraCfg(), "[QA Recorder] Demo", "# report"))
      .then((res) => {
        expect(res.key).to.equal("QA-123");
        expect(res.url).to.equal(`${Cypress.config("baseUrl")}/mock/jira/browse/QA-123`);
      });
    cy.request("/mock/__last").its("body.jira").then((last) => {
      expect(last.authorization).to.contain("Basic ");
      expect(last.body.fields.summary).to.equal("[QA Recorder] Demo");
    });
  });

  it("a Jira error (401) propagates with the status", () => {
    const cfg = { ...jiraCfg(), siteUrl: `${Cypress.config("baseUrl")}/mock/jira-broken` };
    cy.window().then((win) =>
      win.jiraCreateIssue(cfg, "t", "b").then(
        () => {
          throw new Error("should have failed");
        },
        (e) => {
          expect(e.message).to.contain("401");
          expect(e.message).to.contain("invalid credentials");
        }
      )
    );
  });

  it("creates a Linear issue resolving the team key", () => {
    cy.window()
      .then((win) => win.linearCreateIssue(linearCfg(), "[QA Recorder] Demo", "# report"))
      .then((res) => {
        expect(res.key).to.equal("QA-7");
        expect(res.url).to.contain("linear.app");
      });
    cy.request("/mock/__last").its("body.linear").then((last) => {
      expect(last.authorization).to.equal("lin_api_secret");
      expect(last.body.query).to.contain("issueCreate");
      expect(last.body.variables.input.title).to.equal("[QA Recorder] Demo");
      expect(last.body.variables.input.teamId).to.equal("team-uuid-1");
    });
  });

  it("test connection greets with the user's name on both providers", () => {
    cy.window()
      .then((win) => win.testIssueConnection({ provider: "jira", jira: jiraCfg() }))
      .then((text) => expect(text).to.contain("Test User"));
    cy.window()
      .then((win) => win.testIssueConnection({ provider: "linear", linear: linearCfg() }))
      .then((text) => expect(text).to.contain("Test User"));
  });

  it("encodes non-Latin-1 credentials without throwing (UTF-8 Basic auth)", () => {
    cy.window().then((win) => {
      const { options } = win.buildJiraCreate(
        { ...jiraCfg(), email: "tëster@exämple.com" },
        "t",
        "b"
      );
      expect(options.headers.Authorization).to.match(/^Basic [A-Za-z0-9+/=]+$/);
    });
  });

  it("clips huge report bodies before sending (Jira caps descriptions ~32K)", () => {
    cy.window().then((win) =>
      win.createIssueFromReport({ provider: "jira", jira: jiraCfg() }, "big", "x".repeat(40000))
    );
    cy.request("/mock/__last").its("body.jira.body.fields.description").then((desc) => {
      expect(desc.length).to.be.lessThan(31000);
      expect(desc).to.contain("(truncated");
    });
  });

  it("with no provider configured, createIssueFromReport fails with a clear message", () => {
    cy.window().then((win) =>
      win.createIssueFromReport({ provider: "none" }, "t", "b").then(
        () => {
          throw new Error("should have failed");
        },
        (e) => expect(e.message).to.contain("provider")
      )
    );
  });
});
