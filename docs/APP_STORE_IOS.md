# Ristak Mobile iOS App Store Release

This is the release path for the native SwiftUI Apple app at `ios/app`. The
App Store build replaces the legacy Capacitor iOS shell and is the official
iPhone/iPad app for Ristak.

The native iOS app uses the same backend contracts, auth, permissions, push
registration and business rules as `/movil`, but renders the experience with
native SwiftUI screens under `ios/app/Ristak`.

## Current app identity

- App name: `Ristak`
- App Store scope: native Apple CRM app for iPhone and iPad
- Bundle ID: `com.ristak.app`
- Apple team: `Y2L8669JNL`
- Category: Business
- Version: `1.0`
- Build: `2`
- Minimum iOS: `26.0`
- Device family: iPhone and iPad
- Orientation: iPhone portrait and landscape; iPad portrait and landscape

## One-time Apple setup

1. Sign in to Xcode with the Apple Developer account that belongs to team `Y2L8669JNL`.
2. Make sure the team has a valid Apple Distribution certificate or lets Xcode create one with automatic signing.
3. In App Store Connect, create the app record with bundle ID `com.ristak.app`.
4. Accept any pending Apple Developer agreements before uploading a build.
5. Complete App Privacy in App Store Connect. The App Store privacy
   questionnaire still needs the product-level data practices for the native
   CRM app.
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

Run from `frontend/` if you need the local fallback commands:

```bash
npm run mobile:ios:archive
npm run mobile:ios:upload
```

`mobile:ios:archive` archives `../ios/app/Ristak.xcodeproj` and creates
`../ios/app/build/Ristak.xcarchive`.

`mobile:ios:upload` exports/uploads that archive using
`../ios/app/ExportOptions-AppStore.plist`.

GitHub Actions releases use the Apple Distribution `.p12` and App Store
`.mobileprovision` stored in Ristak Installer under `Configuración > Tiendas
móviles`. The provisioning profile must include the exact certificate from the
stored `.p12`; App Store profiles only carry one distribution certificate.
Before dispatching the workflow, Installer validates the `.p12` with App Store
Connect, refreshes or creates App Store profiles for `com.ristak.app` and
`com.ristak.app.NotificationService`, and saves the current profile content back
to its encrypted settings. CI supports both manually named App Store profiles and
Xcode-managed App Store profiles. When the profile is Xcode-managed, the
archive/export runs with automatic signing and does not force a manual code
signing identity, so Xcode does not reject the managed profile as a manual one.

If an agent is asked to upload a build, the normal path is Ristak Installer's
**Tiendas móviles** button or its `publishMobileStoreRelease` service. Do not
copy Apple credentials into this repo, GitHub Secrets, or public docs. Use
`submit_for_review=false` unless the user explicitly confirms that the App Store
metadata, reviewer access, screenshots, privacy answers, and release notes are
ready for Apple review.

If local signing fails, open `ios/app/Ristak.xcodeproj` in Xcode and check:

- Target `Ristak` uses team `Y2L8669JNL`.
- Release signing uses an App Store provisioning profile for `com.ristak.app`.
- Push Notifications capability is enabled.
- Communication Notifications capability is enabled on the app profile.
- Bundle ID is still `com.ristak.app`.

## App Store Connect submission checklist

- App record exists for `com.ristak.app`.
- Screenshots are uploaded for the required iPhone and iPad display sizes using the `/movil` flow. Use portrait screenshots for iPhone and landscape screenshots for iPad.
- Description, keywords, support URL, privacy policy URL, age rating, and contact info are complete.
- App Privacy answers match what Ristak collects and how it uses that data.
- TestFlight build finishes processing without validation errors.
- Push notification production credentials are live in the backend before release.
