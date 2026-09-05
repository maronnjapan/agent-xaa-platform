// client/src/home-actions.ts
var ACTION_PATHS = {
  confirm: (id) => `/api/work-definitions/${encodeURIComponent(id)}/confirm`,
  submit: (id) => `/api/work-definitions/${encodeURIComponent(id)}/submit`,
  approve: (id) => `/api/agent-definitions/${encodeURIComponent(id)}/approve`,
  provision: (id) => `/api/agent-definitions/${encodeURIComponent(id)}/provision`
};
function isHomeAction(value) {
  return value !== null && value in ACTION_PATHS;
}
function actionUrl(action, id) {
  return ACTION_PATHS[action](id);
}
function afterProvision(body) {
  if (typeof body.consent_url === "string" && body.consent_url !== "") {
    return { kind: "navigate", url: body.consent_url };
  }
  if (typeof body.agent_id === "string" && body.agent_id !== "") {
    return { kind: "navigate", url: `/agents/${encodeURIComponent(body.agent_id)}` };
  }
  return { kind: "reload" };
}
function dayRange(from, to) {
  return { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
}

// client/src/messages.ts
var MESSAGES = {
  work_definition_not_confirmed: "\u5148\u306B\u4F5C\u696D\u5185\u5BB9\u3092\u78BA\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  approval_required: "\u5148\u306B\u63D0\u793A\u3055\u308C\u305F\u6A29\u9650\u3092\u627F\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  capabilities_changed: "\u63D0\u793A\u3057\u305F\u6A29\u9650\u304C\u5909\u308F\u308A\u307E\u3057\u305F\u3002\u3082\u3046\u4E00\u5EA6\u300C\u5FC5\u8981\u306A\u6A29\u9650\u3092\u8ABF\u3079\u308B\u300D\u304B\u3089\u3084\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  already_approved: "\u3059\u3067\u306B\u627F\u8A8D\u6E08\u307F\u3067\u3059\u3002",
  lifetime_out_of_range: "\u5E0C\u671B\u3059\u308B\u7A3C\u50CD\u6642\u9593\u306F 1\u301C1440 \u306E\u6574\u6570\uFF08\u5206\uFF09\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  agent_not_active: "\u3053\u306E Agent \u306F\u52D5\u3044\u3066\u3044\u306A\u3044\u305F\u3081\u3001\u6307\u793A\u3092\u53D7\u3051\u53D6\u308C\u307E\u305B\u3093\u3002",
  not_found: "\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u753B\u9762\u3092\u66F4\u65B0\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  // The call to the Authorization Platform did not land. Naming it separately is
  // what stops an unreachable service from reading as a missing record.
  authorization_platform_unreachable: "\u6A29\u9650\u3092\u5224\u5B9A\u3059\u308B\u4ED5\u7D44\u307F\u306B\u5C4A\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5C11\u3057\u6642\u9593\u3092\u304A\u3044\u3066\u3001\u3082\u3046\u4E00\u5EA6\u300C\u5FC5\u8981\u306A\u6A29\u9650\u3092\u8ABF\u3079\u308B\u300D\u3092\u62BC\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  invalid_request: "\u5165\u529B\u306E\u5F62\u5F0F\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002"
};
function failureMessage(status, body) {
  const code = typeof body.error === "string" ? body.error : String(status);
  return MESSAGES[code] ?? `\u3046\u307E\u304F\u3044\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08${code}\uFF09`;
}

// client/src/work-definition-request.ts
function toWorkDefinitionBody(read) {
  const lines = (name) => read(name).split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return {
    purpose: read("purpose"),
    description: read("description"),
    operations: lines("operations"),
    user_confirmations: lines("user_confirmations"),
    safety_notes: lines("safety_notes"),
    requested_lifetime_minutes: Number(read("requested_lifetime_minutes"))
  };
}
function readWorkDefinitionForm(form) {
  const values = new FormData(form);
  return toWorkDefinitionBody((name) => String(values.get(name) ?? ""));
}
async function createWorkDefinition(body) {
  const response = await fetch("/api/work-definitions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => ({}))
  };
}

// client/src/home.ts
function start(root = document, reload = () => root.location.reload()) {
  const create = root.querySelector('[data-form="work-definition"]');
  create?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveDraft(root, create, reload);
  });
  root.querySelectorAll('[data-form="revise"]').forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void revise(form, reload);
    });
  });
  const suggestions = root.querySelector('[data-form="suggestions"]');
  suggestions?.addEventListener("submit", (event) => {
    event.preventDefault();
    void suggest(root, suggestions);
  });
  root.querySelectorAll("button[data-action]").forEach((button) => {
    const action = button.getAttribute("data-action");
    if (!isHomeAction(action)) return;
    button.addEventListener("click", () => {
      void run(button, action, reload);
    });
  });
}
async function saveDraft(root, form, reload) {
  const created = await createWorkDefinition(readWorkDefinitionForm(form));
  if (created.ok) return reload();
  report(root.querySelector('[data-field="form-status"]'), failureMessage(created.status, created.body), "error");
}
async function revise(form, reload) {
  const id = form.getAttribute("data-work-definition-id");
  const text = String(new FormData(form).get("text") ?? "").trim();
  if (!id || text === "") return;
  const response = await fetch(`/api/work-definitions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (response.ok) return reload();
  const body = await response.json().catch(() => ({}));
  report(statusFieldFor(form), failureMessage(response.status, body), "error");
}
async function run(button, action, reload) {
  const id = button.getAttribute(action === "confirm" || action === "submit" ? "data-work-definition-id" : "data-agent-definition-id");
  if (!id) return;
  button.disabled = true;
  const response = await fetch(actionUrl(action, id), { method: "POST", credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    button.disabled = false;
    report(statusFieldFor(button), failureMessage(response.status, body), "error");
    return;
  }
  if (action !== "provision") return reload();
  const outcome = afterProvision(body);
  if (outcome.kind === "navigate" && outcome.url) {
    button.ownerDocument.location.assign(outcome.url);
    return;
  }
  reload();
}
async function suggest(root, form) {
  const values = new FormData(form);
  const status = root.querySelector('[data-field="suggest-status"]');
  const list = root.querySelector('[data-field="suggestions"]');
  const response = await fetch("/api/automation/suggestions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dayRange(String(values.get("from") ?? ""), String(values.get("to") ?? "")))
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return report(status, failureMessage(response.status, body), "error");
  const suggestions = body.suggestions ?? [];
  if (list) {
    list.textContent = "";
    for (const suggestion of suggestions) list.appendChild(suggestionItem(root, suggestion));
  }
  report(status, suggestions.length === 0 ? "\u5019\u88DC\u306F\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u4F5C\u696D\u306E\u5185\u5BB9\u3092\u81EA\u5206\u3067\u66F8\u3044\u3066\u304F\u3060\u3055\u3044\u3002" : `${suggestions.length} \u4EF6\u306E\u5019\u88DC\u304C\u6319\u304C\u308A\u307E\u3057\u305F\u3002\u4F7F\u3046\u3082\u306E\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002`, "listed");
}
function suggestionItem(root, suggestion) {
  const item = root.createElement("li");
  const title = root.createElement("p");
  title.textContent = `${suggestion.purpose}\uFF1A${suggestion.description}`;
  const use = root.createElement("button");
  use.setAttribute("type", "button");
  use.setAttribute("data-action", "use-suggestion");
  use.textContent = "\u3053\u306E\u5019\u88DC\u3092\u66F8\u304D\u5199\u3059";
  use.addEventListener("click", () => {
    fill(root, "purpose", suggestion.purpose);
    fill(root, "description", suggestion.description);
    fill(root, "operations", suggestion.operations.join("\n"));
    fill(root, "user_confirmations", suggestion.user_confirmations.join("\n"));
    fill(root, "safety_notes", suggestion.safety_notes.join("\n"));
  });
  item.appendChild(title);
  item.appendChild(use);
  return item;
}
function fill(root, name, value) {
  const field = root.querySelector(`[data-form="work-definition"] [name="${name}"]`);
  if (field) field.value = value;
}
function statusFieldFor(element) {
  return element.closest("article[data-work-definition-id]")?.querySelector('[data-field="action-status"]') ?? null;
}
function report(field, message, state) {
  if (!field) return;
  field.setAttribute("data-status", state);
  field.textContent = message;
}
if (typeof document !== "undefined") start();
export {
  start
};
