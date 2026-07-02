# Ristak Mobile iOS App Store Release

This is the release path for the Capacitor iOS shell at `frontend/ios/App`. The App Store build is for the mobile `/movil` experience, not the full desktop dashboard.

The native iOS shell keeps users inside the mobile `/movil` flow:

- `/movil`
- `/movil/login`
- `/movil/tenant`
- required setup, SSO, and license-blocked routes

Any other route opened inside the native iOS shell is redirected back to `/movil` or the required login/tenant step. Legacy `/phone/*` links are redirected to the matching `/movil/*` route.

## Current app identity

- App name: `Ristak`
- App Store scope: mobile chat shell for `/movil`
- Bundle ID: `com.ristak.app`
- Apple team: `Y2L8669JNL`
- Category: Business
- Version: `1.0`
- Build: `2`
- Minimum iOS: `15.0`
- Device family: iPhone and iPad
- Orientation: iPhone portrait; iPad landscape

## One-time Apple setup

1. Sign in to Xcode with the Apple Developer account that belongs to team `Y2L8669JNL`.
2. Make sure the team has a valid Apple Distribution certificate or lets Xcode create one with automatic signing.
3. In App Store Connect, create the app record with bundle ID `com.ristak.app`.
4. Accept any pending Apple Developer agreements before uploading a build.
5. Complete App Privacy in App Store Connect. The native privacy manifest in this repo covers the required file timestamp API reason used by the Capacitor Filesystem plugin; the App Store privacy questionnaire still needs the product-level data practices.
6. Add the Privacy Policy URL in App Store Connect.
7. Enable Push Notifications for the explicit App ID and configure APNs production credentials in the backend:

```bash
APNS_KEY_ID=
APNS_TEAM_ID=Y2L8669JNL
APNS_BUNDLE_ID=com.ristak.app
APNS_PRIVATE_KEY=
APNS_ENV=production
```

## Build and upload

Before a local archive or upload, validate the private operator config from the
repo root:

```bash
npm run mobile:release:check -- --platform ios
```

Run from `frontend/`:

```bash
npm run mobile:ios:archive
npm run mobile:ios:upload
```

`mobile:ios:archive` builds the web app, syncs Capacitor using Node 22, and creates `ios/build/RistakChat.xcarchive`.

`mobile:ios:upload` uploads that archive to App Store Connect using `ios/App/ExportOptions-AppStore.plist`.

GitHub Actions releases use the Apple Distribution `.p12` and App Store
`.mobileprovision` stored in Ristak Installer under `Configuración > Tiendas
móviles`. The provisioning profile must include the exact certificate from the
stored `.p12`; App Store profiles only carry one distribution certificate. CI
supports both manually named App Store profiles and Xcode-managed App Store
profiles. When the profile is Xcode-managed, the archive/export runs with
automatic signing and does not force a manual code signing identity, so Xcode
does not reject the managed profile as a manual one.

If local signing fails, open `frontend/ios/App/App.xcodeproj` in Xcode and check:

- Target `App` uses team `Y2L8669JNL`.
- Release signing uses an App Store provisioning profile for `com.ristak.app`.
- Push Notifications capability is enabled.
- Bundle ID is still `com.ristak.app`.

## App Store Connect submission checklist

- App record exists for `com.ristak.app`.
- Screenshots are uploaded for the required iPhone and iPad display sizes using the `/movil` flow. Use portrait screenshots for iPhone and landscape screenshots for iPad.
- Description, keywords, support URL, privacy policy URL, age rating, and contact info are complete.
- App Privacy answers match what Ristak collects and how it uses that data.
- TestFlight build finishes processing without validation errors.
- Push notification production credentials are live in the backend before release.
