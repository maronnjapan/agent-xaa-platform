// client/src/messages.ts
var MESSAGES = {
  work_definition_not_confirmed: "\u5148\u306B\u4F5C\u696D\u5185\u5BB9\u3092\u78BA\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  approval_required: "\u5148\u306B\u63D0\u793A\u3055\u308C\u305F\u6A29\u9650\u3092\u627F\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  capabilities_changed: "\u63D0\u793A\u3057\u305F\u6A29\u9650\u304C\u5909\u308F\u308A\u307E\u3057\u305F\u3002\u3082\u3046\u4E00\u5EA6\u300C\u5FC5\u8981\u306A\u6A29\u9650\u3092\u8ABF\u3079\u308B\u300D\u304B\u3089\u3084\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  already_approved: "\u3059\u3067\u306B\u627F\u8A8D\u6E08\u307F\u3067\u3059\u3002",
  lifetime_out_of_range: "\u5E0C\u671B\u3059\u308B\u7A3C\u50CD\u6642\u9593\u306F 1\u301C24 \u306E\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
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

// client/src/agent-detail.ts
function start(root = document, reload = () => root.location.reload()) {
  const form = root.querySelector('[data-form="instruction"]');
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void instruct(root, form);
  });
  const stop = root.querySelector('button[data-action="stop"]');
  stop?.addEventListener("click", () => {
    void halt(root, stop, reload);
  });
}
async function instruct(root, form) {
  const agentId = form.getAttribute("data-agent-id");
  const field = form.querySelector('[name="text"]');
  const text = (field?.value ?? "").trim();
  if (!agentId || text === "") return;
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/instructions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return report(root, failureMessage(response.status, body), "error");
  if (field) field.value = "";
  report(root, "\u6307\u793A\u3092\u8FFD\u52A0\u3057\u307E\u3057\u305F\u3002Agent \u304C\u6B21\u306E\u533A\u5207\u308A\u3067\u8AAD\u307F\u53D6\u308A\u307E\u3059\u3002", "done");
}
async function halt(root, button, reload) {
  const agentId = button.getAttribute("data-agent-id");
  if (!agentId) return;
  button.disabled = true;
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
    method: "POST",
    credentials: "same-origin"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    button.disabled = false;
    return report(root, failureMessage(response.status, body), "error");
  }
  reload();
}
function report(root, message, state) {
  const field = root.querySelector('[data-field="control-status"]');
  if (!field) return;
  field.setAttribute("data-status", state);
  field.textContent = message;
}
if (typeof document !== "undefined") start();
export {
  start
};
