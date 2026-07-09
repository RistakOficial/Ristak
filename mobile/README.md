# Ristak Android Mobile

React Native/Expo Android app for Ristak. This app is separate from the `/movil`
web surface and talks directly to the existing Ristak backend API.

Mobile routes are split intentionally:

- `/movil`: mobile web/PWA surface from `frontend/`.
- `mobile/`: Android/Google-device React Native app.
- `ios/app`: native Apple app for iPhone and iPad.

Do not add iOS scripts, APNs config, entitlements, Xcode targets, Notification
Service extensions, or Apple native code in this folder. Apple work belongs in
`../ios/app`.

## What Works Now

- Email/password login that resolves the correct Ristak installation
  automatically through the installer mobile resolver.
- Secure token and resolved installation URL storage using Expo SecureStore.
- Native push registration for Android, notification tap handling, and
  device-level alert activation from Settings.
- Chat inbox from `/api/contacts/chats`.
- Native chat inbox parity pass for `/movil`: same high-level header, search,
  quick filter chips, unread emphasis, contact avatar ring/channel badge, and
  last-message preview rules.
- Native appointments page parity pass for `/movil`: original mobile calendar
  header, calendar selector sheet, month grid, agenda list, event details sheet,
  create/edit/delete appointment flow, timeline long-press creation, synchronized
  month-title swipe, haptic locked timeline range selection, compact agenda
  cards, compact month typography with large selected-day marker, responsive
  visible-month height, appointment-only contact picker, original-order
  appointment form, and business-timezone grouping.
- Native payments, analytics, settings, bottom dock, and notification parity
  passes from the mobile migration worktrees.
- Conversation view from `/api/contacts/:id/journey`.
- Text sending through `/api/whatsapp-api/messages/text`.
- Native chat/conversation pass with swipe actions, reusable bottom sheets,
  camera/photo/video send, templates, CLABE/payment helpers, scheduling, tags,
  agent actions, attachments and channel selection.
- Native appointments pass with business-timezone month/timeline views,
  day agenda, appointment create/edit/delete, free-slot lookup and calendar
  users.
- Payments native parity pass for `/movil/payments`: type selector, gateway
  capability gating, recent received payments by period, product/price CRUD,
  manual one-time payments, HighLevel invoice send, payment links, installment
  plans, subscriptions, contact picker, and external link opening with React
  Native `Linking`. Payment creation reads account currency/timezone from the
  backend config and blocks instead of creating money records when the account
  currency cannot be resolved.
- Native settings pass with WhatsApp number management, AI-agent business
  context dictation through `expo-audio` + `/api/ai-agent/transcribe`, native
  push permission/token registration through `expo-notifications`, user/app
  preference persistence, and theme background updates for the installed app.
- Native Android push registration is wired through `/api/push/mobile-devices`.

## Commands

From the repo root:

```bash
npm run mobile:native:start
npm run mobile:native:android
npm run mobile:native:typecheck
```

From this folder:

```bash
npm run start
npm run android
npm run typecheck
```

`npm run prebuild` is only allowed to promote Android output. If Expo generates
`mobile/ios`, treat it as disposable local output and delete it; the Apple app
lives in `../ios/app`.

## Double-Maintenance Rule

While `/movil` and this React Native app coexist, mobile product changes must be
handled in both places:

- `/movil`: `frontend/src/pages/PhoneChat/` and related mobile web components.
- Native: `mobile/src/`.

If a change intentionally applies to only one surface, document that decision in
the PR/change summary and update `docs/MOBILE_APP.md` when behavior changes.

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
