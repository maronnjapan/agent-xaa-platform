# Firestore seed collections

| Collection | Document ID | Required fields | Writer |
|---|---|---|---|
| `capability_taxonomy` | capability_id | resource, object, action, description, default_characteristics | seed |
| `human_permissions` | human_subject__capability_id | human_subject, capability_id, granted_at | seed |
| `delegatable_permissions` | capability_id | capability_id | seed |
| `organization_policies` | policy_id | policy_id, effect, description | seed |
| `risk_policies` | policy_id | policy_id, capability_id, requires_approval, isolation_level | seed |
| `catalog_connectors` | connector_id | connector_id, resource_type, authorization, bridge, status, risk_level, tools | seed |
| `catalog_tools` | tool_id | tool_id, connector_id, description, required_capability, authorization, token_provider, api, parameters, constraints, response_schema, risk_level | seed |

`default_characteristics` contains `capability_risk`, `resource_sensitivity`, `admin_permission`, `personal_data_access`, `write_permission`, and `financial_operation`.
