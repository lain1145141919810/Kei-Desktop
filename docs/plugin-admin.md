# Plugin administration for Kei API v1

Use the trusted local main-process client described in host-api.md. The renderer receives sanitized details and the results of user-authorized actions. Host connection credentials, package installation, filesystem access and confirmation stay in the trusted main process.

## Detail, compatibility and settings

GET /v1/plugins/{id} returns the installed identity, version, declared permissions, stored grants, effectiveGrants, activeEntries and declaredEntries. The compatibility object names the supported host API version and feature IDs alongside the package's requirements. GET /v1/status advertises pluginFeatures. Incompatible packages are rejected at install. When present, diagnostics contain stable code, message and an action ID for the operator.

PUT /v1/plugins/{id}/config accepts {"values":{...}} and replaces saved settings with typed values plus defaults. Unknown fields or out-of-range values return invalid_plugin_config. The plugin's configuration starts empty or uses its declared defaults. Saving an enabled plugin leaves the running configuration active until reload. configuration.pendingReload identifies the difference. The plugin sees the new snapshot as context.config when initialized after reload or restart. Disable keeps the saved configuration. Uninstall with retainData=true keeps it with plugin data.

A v1 package may declare requiresFeatures: [config-schema-v1]. The optional _conf_schema.json maps field names to objects with type, description, hint, default, options, minimum and maximum. Only type is required. Supported types are string, text, int, float, bool, list, dict, object and credential_ref. Numeric bounds apply to int and float. options supplies allowed whole values. The credential_ref type holds an environment variable name or null. Store references in plugin settings and secrets in their owning credential store.

## Lifecycle and page routing

Identify a plugin entry by (pluginId, entryId). IDs must be unique inside a plugin. Two independent plugins may reuse the same conventional entry ID. The installer rejects duplicate_entry, unsupported_feature and invalid_config_schema before registration. A failed activation or reload withdraws every entry and retains a diagnostic for repair. A new generation receives fresh page sessions.

Close open frames and subscriptions immediately when a plugin reloads, disables or uninstalls. Reject stale handlers by page session. Use a trusted OS chooser for the package and check the descriptor before forwarding requests. Keep management endpoints out of plugin frames. The protocol for scoped iframe messages remains unchanged.

The published template includes a typed settings field. The Linux acceptance bundle exercises the same management API against two external plugins, and contains the portable counter package for real desktop and admin views.
