# Security and operating boundaries

Orbit is designed to keep a person in control of browser actions with external effects. That reduces risk; it does not make Orbit a sandbox or replace user review.

## Approval model

The agent plans one atomic step, then the server inspects that step and the resolved target on the actual page. Approval is required for, among other cases:

- Sending, saving, creating, deleting, purchasing, publishing, inviting, confirming, or accepting.
- Fields that may save automatically.
- Ambiguous controls and script-triggering links.
- Newlines typed into a field, since they can submit a form.
- Navigation associated with a sensitive operation.

Navigation, scrolling, search, and reads can proceed without approval only when the verified target is read-only. A model may make policy stricter through its declared impact; it cannot weaken policy.

Before an approval is accepted, Orbit records a fingerprint of the target and the current values in its logical form or container. If those values change, approval is refused and the action does not run. Failures that could repeat an external write are never retried automatically.

## Credentials and data

- Provider keys are read by the server from `.env`; they are not sent to the frontend or saved in workspace files.
- Browser profiles, persisted cookies, downloads, artifacts, and logs stay on the local machine or configured Docker volume.
- Orbit sends observable page text to the selected AI provider for planning. Do not use it on pages whose content you cannot share with that provider.
- Logs contain observable events, and errors are redacted before reaching logs or the UI. They do not contain model reasoning.
- Orbit does not type passwords or payment data and does not solve CAPTCHA or 2FA. A person must complete login in the browser.

## Local network

Orbit accepts only local same-origin requests. Mutating `/api` requests also need `X-Orbit-Client: local`. Agents cannot navigate to Orbit's own port or ports listed in `ORBIT_BLOCKED_PORTS`.

Docker publishes Orbit and noVNC to `127.0.0.1` intentionally. **Do not expose these mappings to a shared network or the Internet**: neither the Orbit control surface nor noVNC has an authentication layer.

## Recommended practice

1. Use a dedicated or test account for demos and experimental automation.
2. Review every approval prompt; it exposes both the proposed action and current form state.
3. Keep `.env`, workspace directories, and Docker volumes out of public repositories and backups that should not contain session data.
4. State timezones explicitly in calendar tasks and verify results directly in the destination site.
5. Close agent browsers when they are not needed, and delete agents or workspaces that should no longer retain data.

## Known limitations

Sites can change their UI, use complex iframes or Shadow DOM, limit automation, or request extra verification. Google may challenge a login in an automated browser. Human intervention can therefore be needed even before a step that Orbit considers read-only.

If you find a vulnerability, do not publish it with secrets or session data. Send a minimized, reproducible description to the repository owner or responsible team.
