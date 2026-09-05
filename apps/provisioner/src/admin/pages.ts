import type { CapabilityRow, MappingOverview, ResourceGroup } from './mapping-store.js';

/**
 * The mapping screen, as a string.
 *
 * One form per resource, posted as an ordinary HTML form, so the console works through
 * `gcloud run services proxy` — which attaches the administrator's identity token to
 * whatever the page submits — without any script that would have to hold a token of
 * its own.
 */

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1.5rem; line-height: 1.6; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #8881; }
code { font-family: ui-monospace, monospace; }
select { padding: 0.2rem; }
button { padding: 0.4rem 1rem; margin-top: 0.6rem; }
.note { color: #666; font-size: 0.9rem; }
.warn { border: 1px solid #c80; padding: 0.6rem 1rem; }
.errors { border: 1px solid #c00; padding: 0.6rem 1rem; }
.saved { border: 1px solid #0a0; padding: 0.6rem 1rem; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function mappingPage(overview: MappingOverview, options: {
  errors?: readonly string[];
  saved?: readonly string[];
} = {}): string {
  const capabilityIds = overview.capabilities.map((capability) => capability.capability_id);
  const banner = [
    (options.errors ?? []).length === 0 ? '' : `<div class="errors"><ul>${
      (options.errors ?? []).map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>`,
    (options.saved ?? []).length === 0 ? '' : `<div class="saved"><ul>${
      (options.saved ?? []).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>`,
    unmappedWarning(overview.capabilities),
  ].join('');

  const resources = overview.resources.map((resource) => resourceSection(resource, capabilityIds)).join('');

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>権限とリソースのマッピング｜Agent Provisioner</title><style>${STYLE}</style></head>`
    + `<body><h1>権限とリソースのマッピング</h1>${banner}
    <p class="note">各リソース（Connector）の操作が、どの権限（Capability）で実行できるかを決める。
    権限そのものを作る・直すのは Authorization Platform の <code>/admin/permissions</code> である。</p>
    <p class="note">API の URL、HTTP メソッド、scope、audience はここでは変えられない。
    Agent には Provisioning 済みの Tool しか渡らないため（RULE-17）、変えられるのは対応付けだけである。</p>
    <p class="note">変更が効くのは、これ以降に Provisioning される Agent である。
    実行中の Agent は Provisioning 時に確定した Tool Manifest で動き続ける（RULE-19）。</p>
    <p class="note">seed をもう一度流すと、この対応付けは <code>infra/seed/tools/</code> の YAML の内容へ戻る。</p>
    ${resources}
    ${capabilityTable(overview.capabilities)}
    </body></html>`;
}

function resourceSection(resource: ResourceGroup, capabilityIds: readonly string[]): string {
  if (resource.tools.length === 0) {
    return `<h2><code>${escapeHtml(resource.connector_id)}</code></h2><p class="note">操作が登録されていない。</p>`;
  }
  const rows = resource.tools.map((tool) => `<tr>
    <td><code>${escapeHtml(tool.tool_id)}</code></td>
    <td>${escapeHtml(tool.description)}</td>
    <td><code>${escapeHtml(`${tool.method} ${tool.path}`)}</code></td>
    <td>${escapeHtml(tool.risk_level)}</td>
    <td><select name="${escapeHtml(tool.tool_id)}">${
      capabilityIds.map((capabilityId) =>
        `<option value="${escapeHtml(capabilityId)}"${capabilityId === tool.required_capability ? ' selected' : ''}>${escapeHtml(capabilityId)}</option>`).join('')
    }</select></td>
  </tr>`).join('');

  return `<h2><code>${escapeHtml(resource.connector_id)}</code>
      <span class="note">${escapeHtml(`${resource.resource_type} / ${resource.status} / risk ${resource.risk_level}`)}</span></h2>
    <form method="post" action="/admin/mappings">
      <table><thead><tr>
        <th>操作（Tool）</th><th>説明</th><th>API</th><th>リスク</th><th>必要な権限</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <button type="submit">このリソースのマッピングを保存する</button>
    </form>`;
}

/**
 * The list read from the other direction, which is the one an administrator who has
 * just created a permission needs: it says whether anything can execute it yet.
 */
function capabilityTable(capabilities: readonly CapabilityRow[]): string {
  const rows = capabilities.map((capability) => `<tr>
    <td><code>${escapeHtml(capability.capability_id)}</code></td>
    <td>${escapeHtml(capability.description)}</td>
    <td>${capability.tool_ids.length === 0
      ? '<span class="note">なし</span>'
      : capability.tool_ids.map((toolId) => `<code>${escapeHtml(toolId)}</code>`).join('<br>')}</td>
  </tr>`).join('');
  return `<h2>権限ごとの対応</h2><table><thead><tr>
      <th>capability_id</th><th>説明</th><th>実行できる操作</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function unmappedWarning(capabilities: readonly CapabilityRow[]): string {
  const unmapped = capabilities.filter((capability) => capability.tool_ids.length === 0);
  if (unmapped.length === 0) return '';
  return `<div class="warn">操作が1つも対応していない権限がある：${
    unmapped.map((capability) => `<code>${escapeHtml(capability.capability_id)}</code>`).join('、')
  }。この権限は Organization Policy で拒否され、Agent へ付与されない。</div>`;
}
