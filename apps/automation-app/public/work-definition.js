// client/src/work-definition.ts
function start(root = document) {
  const form = root.querySelector('[data-form="work-definition"]');
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(form);
  });
}
async function submit(form) {
  const status = form.ownerDocument.querySelector('[data-field="form-status"]');
  const values = new FormData(form);
  const text = (name) => String(values.get(name) ?? "");
  const lines = (name) => text(name).split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const response = await fetch("/api/work-definitions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      purpose: text("purpose"),
      description: text("description"),
      operations: lines("operations"),
      user_confirmations: lines("user_confirmations"),
      safety_notes: lines("safety_notes"),
      requested_lifetime_hours: Number(text("requested_lifetime_hours"))
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!status) return;
  status.setAttribute("data-status", response.ok ? "created" : "error");
  status.textContent = response.ok ? `\u4F5C\u696D\u3092\u4E0B\u66F8\u304D\u3068\u3057\u3066\u4FDD\u5B58\u3057\u307E\u3057\u305F\uFF08${body.work_definition_id ?? ""}\uFF09` : `\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08${body.error ?? String(response.status)}\uFF09`;
}
if (typeof document !== "undefined") start();
export {
  start
};
