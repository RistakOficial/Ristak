# Ristak Native Mobile Instructions

This folder is the React Native mobile app for Ristak. It is not the legacy
Capacitor `/movil` WebView shell.

Before changing code in this folder:

- Read `../docs/MOBILE_APP.md`.
- Read `../docs/DOCUMENTATION_SYSTEM.md` if docs need to change.
- Check the equivalent `/movil` behavior in `../frontend/src/pages/PhoneChat/`
  or the matching mobile web surface.

Maintenance rule:

- Any user-facing mobile feature, label, API contract, permission, push payload,
  chat behavior, payment behavior, calendar behavior, or mobile setting changed
  in `/movil` must also be implemented or explicitly evaluated here.
- Any behavior added here must also be implemented or explicitly evaluated in
  `/movil` while both mobile surfaces coexist.
- Do not duplicate secrets, API keys, tokens, signing credentials, or private
  store credentials in this app. Use runtime setup, secure storage, and the
  existing backend/Installer flows.

Expo SDK 57 is the current runtime for this app. When changing Expo config,
native generation, permissions, or native modules, use the versioned Expo docs:
https://docs.expo.dev/versions/v57.0.0/
