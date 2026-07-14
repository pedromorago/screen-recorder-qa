"use strict";

// E2E de issue-reporter.js: la lógica de creación de issues (Jira REST v2
// y Linear GraphQL) ejecutada con fetch REAL contra los mocks del servidor
// de pruebas, que capturan la petición recibida para poder asertarla.

const jiraCfg = () => ({
  siteUrl: `${Cypress.config("baseUrl")}/mock/jira`,
  email: "tester@example.com",
  apiToken: "token-secreto",
  projectKey: "QA",
});

const linearCfg = () => ({
  apiKey: "lin_api_secreta",
  teamKey: "QA",
  apiUrl: `${Cypress.config("baseUrl")}/mock/linear/graphql`,
});

describe("issue-reporter.js (Jira/Linear)", () => {
  beforeEach(() => {
    cy.visit("/cypress/pages/sandbox.html");
    cy.injectExtensionScript("issue-reporter.js");
  });

  it("construye la petición de Jira: URL, Basic auth y payload", () => {
    cy.window().then((win) => {
      const { url, options } = win.buildJiraCreate(jiraCfg(), "Título", "Cuerpo");
      expect(url).to.equal(`${Cypress.config("baseUrl")}/mock/jira/rest/api/2/issue`);
      expect(options.headers.Authorization).to.equal(
        "Basic " + win.btoa("tester@example.com:token-secreto")
      );
      const payload = JSON.parse(options.body);
      expect(payload.fields.project.key).to.equal("QA");
      expect(payload.fields.issuetype.name).to.equal("Bug");
      expect(payload.fields.summary).to.equal("Título");
      expect(payload.fields.description).to.equal("Cuerpo");
    });
  });

  it("crea un issue en Jira y devuelve clave y enlace", () => {
    cy.window()
      .then((win) => win.jiraCreateIssue(jiraCfg(), "[QA Recorder] Demo", "# informe"))
      .then((res) => {
        expect(res.key).to.equal("QA-123");
        expect(res.url).to.equal(`${Cypress.config("baseUrl")}/mock/jira/browse/QA-123`);
      });
    cy.request("/mock/__last").its("body.jira").then((last) => {
      expect(last.authorization).to.contain("Basic ");
      expect(last.body.fields.summary).to.equal("[QA Recorder] Demo");
    });
  });

  it("un error de Jira (401) se propaga con el status", () => {
    const cfg = { ...jiraCfg(), siteUrl: `${Cypress.config("baseUrl")}/mock/jira-roto` };
    cy.window().then((win) =>
      win.jiraCreateIssue(cfg, "t", "b").then(
        () => {
          throw new Error("debería haber fallado");
        },
        (e) => {
          expect(e.message).to.contain("401");
          expect(e.message).to.contain("credenciales inválidas");
        }
      )
    );
  });

  it("crea un issue en Linear resolviendo la clave del equipo", () => {
    cy.window()
      .then((win) => win.linearCreateIssue(linearCfg(), "[QA Recorder] Demo", "# informe"))
      .then((res) => {
        expect(res.key).to.equal("QA-7");
        expect(res.url).to.contain("linear.app");
      });
    cy.request("/mock/__last").its("body.linear").then((last) => {
      expect(last.authorization).to.equal("lin_api_secreta");
      expect(last.body.query).to.contain("issueCreate");
      expect(last.body.variables.input.title).to.equal("[QA Recorder] Demo");
      expect(last.body.variables.input.teamId).to.equal("team-uuid-1");
    });
  });

  it("probar conexión saluda con el nombre del usuario en ambos proveedores", () => {
    cy.window()
      .then((win) => win.testIssueConnection({ provider: "jira", jira: jiraCfg() }))
      .then((texto) => expect(texto).to.contain("Tester de Prueba"));
    cy.window()
      .then((win) => win.testIssueConnection({ provider: "linear", linear: linearCfg() }))
      .then((texto) => expect(texto).to.contain("Tester de Prueba"));
  });

  it("sin proveedor configurado, createIssueFromReport falla con mensaje claro", () => {
    cy.window().then((win) =>
      win.createIssueFromReport({ provider: "none" }, "t", "b").then(
        () => {
          throw new Error("debería haber fallado");
        },
        (e) => expect(e.message).to.contain("proveedor")
      )
    );
  });
});
