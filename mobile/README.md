# Ristak Native Mobile

React Native mobile app for Ristak. This app is separate from the legacy
Capacitor `/movil` shell and talks directly to the existing Ristak backend API.

## What Works Now

- Mobile login resolves the tenant automatically through the Installer portal,
  matching `/movil/login`: the user enters email + password, the app calls
  `/api/mobile/resolve`, stores the resolved backend URL, then authenticates
  against `/api/auth/login`.
- Secure token and installation URL storage using Expo SecureStore.
- Chat inbox from `/api/contacts/chats`.
- Native chat inbox parity pass for `/movil`: same high-level header, search,
  quick filter chips, unread emphasis, contact avatar ring/channel badge, and
  last-message preview rules.
- Camera share flow from the chat inbox: take a photo or record a short video,
  pick a recipient, and send through `/api/whatsapp-api/messages/image` or
  `/api/whatsapp-api/messages/video` when the contact has a phone number.
- Native push registration through `expo-notifications`: Settings can request
  OS permission, save the native APNs/FCM token through `/api/push/mobile-devices`,
  and notification taps open the matching chat by `contactId` or `/movil?contact=...`.
- Conversation view from `/api/contacts/:id/journey`.
- Text sending through `/api/whatsapp-api/messages/text`.

## Commands

From the repo root:

```bash
npm run mobile:native:start
npm run mobile:native:ios
npm run mobile:native:android
npm run mobile:native:typecheck
```

From this folder:

```bash
npm run start
npm run ios
npm run android
npm run typecheck
```

`npm run prebuild` generates native `ios/` and `android/` directories using Expo
Continuous Native Generation. The generated directories should stay disposable
unless a native customization is intentionally promoted to tracked code.

Push native note: the local iPhone project currently includes
`mobile/ios/RistakNotificationService` so iOS can render contact avatars through
Communication Notifications. Real iOS push tests must use the store bundle IDs
`com.ristak.app` and `com.ristak.app.NotificationService`; a temporary bundle can
launch the app, but APNs will reject notifications if the device token belongs to
a different topic. APNs credentials belong in Ristak Installer as the central
mobile push broker; this client app should register device tokens, not carry
`.p8` secrets. `mobile/ios` is ignored by `mobile/.gitignore`; if this native iOS
project becomes the permanent app source, either track `ios/` with Pods/build
excluded or move the extension setup into a config plugin before running a clean
prebuild.

## Double-Maintenance Rule

While `/movil` and this React Native app coexist, mobile product changes must be
handled in both places:

- `/movil`: `frontend/src/pages/PhoneChat/` and related mobile web components.
- Native: `mobile/src/`.

If a change intentionally applies to only one surface, document that decision in
the PR/change summary and update `docs/MOBILE_APP.md` when behavior changes.

Login parity note: the native app must not ask the user to paste a backend URL.
Keep `mobile/src/api.ts` aligned with `frontend/src/services/mobileTenantService.ts`
and keep `mobile/src/App.tsx` login behavior aligned with `/movil/login`.

Push parity note: keep `mobile/src/notifications.ts`, `mobile/src/App.tsx`, and
backend `pushNotificationsService` aligned with
`frontend/src/services/mobileAppService.ts`,
`frontend/src/services/pushNotificationsService.ts`, and the iOS/Android native
renderers under `frontend/ios` and `frontend/android`. For a single-contact push,
the backend must send `contactAvatarUrl`: real photo first, generated initials
avatar if no photo exists.

## Parity Rule

The React Native app must match `/movil` as the user-facing product. The code can
be native and structurally different, but the visible result must keep the same
navigation order, section names, hierarchy, flows, permissions, settings, and
states. Do not redesign or simplify a native screen unless the matching `/movil`
behavior is intentionally changed or a documented migration gap remains.

For the chat list specifically, keep `mobile/src/App.tsx` aligned with
`frontend/src/pages/PhoneChat/PhoneChat.tsx` and
`PhoneChat.module.css`: chips are the visible filter surface, rows stay flat
instead of card-based, unread state is shown through background/type/badge, and
social-channel color belongs on the avatar ring/badge rather than the initials
fill.
