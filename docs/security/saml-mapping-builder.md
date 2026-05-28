# Visual SAML Attribute Mapping Builder (Phase P1.1)

**Audience:** identity admins configuring SAML 2.0 SSO for a workspace.

**Canonical path:** `/security-center/sso/mapping`.

---

## 1. What it does

Before P1.1, SAML attribute mappings were a JSON blob persisted on `SsoConnection.samlAttributeMapping`, editable only by direct DB write or backend deploy. The Visual Mapping Builder gives admins a UI that:

1. Reads the field-by-field **schema** (which attributes exist, which are privilege-affecting, suggested attribute names).
2. Reads the **current persisted mapping** for the selected connection.
3. Lets the operator edit each field with inline help, then **runs a preview** before save.
4. Surfaces **warnings** when the change is operationally risky (privilege escalation, SCIM overlap, default-role downgrade, email mapping removal, external subject override).
5. Routes **step-up** automatically when the change is privilege-affecting.

## 2. Mapping fields

| Field | Privilege-affecting | Purpose |
| --- | --- | --- |
| `email` | no | IdP attribute that carries the operator's email. Used for identification + auto-provisioning. |
| `name` | no | Display name attribute. Used for profile-name population. |
| `externalId` | **yes** | Optional override for the stable external subject (NameID). Changing this re-identifies existing operators on next login. |
| `groupClaim` | **yes** | IdP attribute carrying group memberships. Advisory only when SCIM is authoritative. |
| `defaultRole` | **yes** | Fallback role for JIT-provisioned users with no group match. |
| `groupRoleMap` | **yes** | Per-group role override. The first matching group wins. |

## 3. Preview warnings

The preview endpoint computes a bounded set of warning codes:

- `GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN` — a new group mapping grants OWNER or ADMIN. **Triggers step-up at save time.**
- `GROUP_ROLE_OVERLAPS_SCIM` — the connection is SCIM-managed; group claims are ignored at assertion time.
- `DEFAULT_ROLE_DOWNGRADED` — the default fallback role was lowered (MEMBER → VIEWER). New JIT users will have reduced privileges.
- `EMAIL_MAPPING_REMOVED` — the operator cleared the email attribute; logins fall back to the IdP's standard candidates.
- `EXTERNAL_ID_OVERRIDE_RISKY` — the external subject attribute was changed. **Triggers step-up at save time.**

## 4. Step-up

Save is gated on step-up purpose `SAML_MAPPING_PRIVILEGE_UPDATE` when **either**:

- The preview returned `privilegeAffecting: true`, OR
- The operator explicitly set `acknowledgePrivilegeImpact: true` in the request.

The backend re-runs the preview server-side before persisting, so a malicious client cannot bypass the gate by lying about `privilegeAffecting`.

## 5. Sample resolution

The preview accepts an optional `sampleAttributes` map (paste a JSON object of attribute → value pairs from a real IdP assertion). The response includes a `sampleResolution` showing the resolved email / name / externalId / role for that sample. **Sample data is never persisted.**

## 6. Operating procedure

1. Open `/security-center/sso/mapping`.
2. Select the SAML connection from the dropdown (only `GENERIC_SAML` connections are listed).
3. Edit attribute names. The autocomplete suggestions come from the backend schema endpoint (IETF and SAML 2.0 standard claim URIs).
4. Add group → role mappings in the table.
5. (Optional) Paste a sample assertion JSON to verify resolution.
6. Click **Preview changes**.
7. Review the diff, warnings, and sample resolution.
8. Click **Save mapping**. If privilege-affecting, the step-up modal appears.

## 7. Audit events

- `saml_mapping_previewed` (every preview call, INFO)
- `saml_mapping_updated` (every save, INFO for safe / WARNING for privilege-affecting)
- `saml_mapping_privilege_warning` (additional event on privilege-affecting saves with the warning codes captured)

## 8. Metrics

- `saml_mapping_previewed_total`
- `saml_mapping_update_total`

## 9. Honest scope

- The builder edits the same JSON blob the backend has always consumed. There is **no second mapping engine** — this is a visual front for the existing `SsoConnection.samlAttributeMapping` field.
- The mapping is **advisory at assertion-time** when `samlScimManaged === true` for the connection. The builder still lets you edit it (mappings persist), but operationally the IdP's group claims are ignored in favor of SCIM-pushed memberships. The UI surfaces this with the SCIM overlap warning.
- The "Sample resolution" is a client-side simulation of the mapping rules — it does **not** validate against a real assertion or invoke the SAML library.
