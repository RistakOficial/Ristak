# Mobile Store Releases

Mobile store builds are intentionally manual. Pushes to `main` keep the normal
web/Render pipeline working, but they do not create App Store Connect or Google
Play builds.

Use Ristak Installer to trigger the `mobile-store-release` workflow when a
mobile build is ready. Installer stores the Apple and Google credentials in its
database, creates a short-lived token, and sends only that token to GitHub
Actions for the current run.

Operational rule for agents: if the user asks from this repo to upload a mobile
build, do not hunt for Apple/Google secrets in Ristak or create new credentials.
Use Ristak Installer as the control plane. Trigger the **Tiendas móviles** button
or call Installer's `publishMobileStoreRelease` service from the deployed
Installer environment, keeping `submit_for_review=false` unless the user
explicitly says the store listing is ready for review.

For this local machine, use the private operator file:

```bash
npm run mobile:release:init
npm run mobile:release:check -- --platform both
```

This creates:

- `.mobile-release.local.env`: local defaults and pointers for mobile releases.
- `.mobile-release/`: local private vault for files such as `.p8`, `.p12`,
  `.mobileprovision`, and Google service account JSON.

Both paths are ignored by Git. Never commit them, paste their values into docs,
or print their contents in logs.

The workflow supports:

- `ios`: builds the Capacitor iOS shell and uploads to App Store Connect.
- `android`: builds the Android App Bundle and uploads to Google Play.
- `both`: runs both store jobs from the same commit.

## Where credentials live

Preferred production source of truth: Ristak Installer.

Do not store mobile store credentials as GitHub repository secrets. GitHub
Actions should receive only the temporary `mobile_release_token` generated for
one release run.

Before an iOS dispatch, Installer validates the stored `.p12` certificate
against App Store Connect, finds active App Store provisioning profiles for
`com.ristak.app` and `com.ristak.app.NotificationService`, creates missing
profiles with the correct Apple Distribution certificate, and saves the current
base64 profile content back into its encrypted settings table. That makes the
button recover from rotated/expired/missing profiles without leaking Apple
credentials into this repository.

Set them in Ristak Installer under:

`Configuración > Tiendas móviles`

iOS:

- App Store Connect Key ID
- App Store Connect Issuer ID
- App Store Connect `.p8`
- iOS Distribution Certificate `.p12` encoded as base64
- iOS Distribution Certificate password
- iOS App Store provisioning profile encoded as base64 for `com.ristak.app`
- iOS Notification Service provisioning profile encoded as base64 for
  `com.ristak.app.NotificationService`
- iOS CI keychain password (optional)

Both iOS provisioning profiles must be App Store Connect profiles and must
include the exact Apple Distribution certificate stored above. One profile is for
the app bundle `com.ristak.app`; the other is for the Notification Service
Extension bundle `com.ristak.app.NotificationService`. If the `.p12` certificate
is rotated, the next Installer preflight should create or refresh both App Store
profiles with that same certificate and update both fields. CI installs the
stored profiles directly; it does not regenerate profiles by name inside GitHub
Actions. The main app profile can be manually named or Xcode-managed. CI detects
Xcode-managed profiles and switches the archive/export to automatic signing so
the profile is not forced as a manual signing profile.

OJO para avatares en push iOS: el app bundle `com.ristak.app` debe tener
activadas las capabilities Push Notifications y Communication Notifications. El
perfil App Store del app principal debe incluir el entitlement
`com.apple.developer.usernotifications.communication`; si ese perfil se queda
viejo, el archive puede fallar al firmar o iOS puede mostrar el avatar como
attachment normal en vez de avatar de remitente. Cuando cambien capabilities,
regenera/descarga el perfil App Store del app principal y verifica que el perfil
de `com.ristak.app.NotificationService` siga vigente para la Notification
Service Extension.

Android:

- Android release keystore encoded as base64
- Android store password
- Android key alias
- Android key password
- Google Play service account JSON

Local direct signing/upload is supported only as a fallback for this Mac. In that
case, keep secrets in `.mobile-release.local.env`, `.mobile-release/`, and the
existing ignored Android signing files. The local checker validates presence
without printing secret values:

```bash
npm run mobile:release:check -- --source local --platform ios
npm run mobile:release:check -- --source local --platform android
```

## Local private variables

`.mobile-release.local.env` controls how a release should run from this machine.
The template `.mobile-release.local.env.example` is safe to commit because it has
only names and empty placeholders.

Common:

- `MOBILE_RELEASE_CREDENTIAL_SOURCE`: `installer` recommended, `local` for
  direct local signing/upload fallback.
- `MOBILE_RELEASE_DEFAULT_PLATFORM`: `ios`, `android`, or `both`.
- `MOBILE_RELEASE_SUBMIT_FOR_REVIEW`: `false` to upload only, `true` to request
  review.
- `MOBILE_RELEASE_GITHUB_BRANCH`: normally `main`.
- `MOBILE_RELEASE_INSTALLER_URL`: public URL for Ristak Installer when using the
  `installer` credential source.

iOS:

- `MOBILE_RELEASE_IOS_VERSION`: visible App Store version.
- `IOS_APPLE_ID`: optional fallback for Apple account tooling.
- `IOS_APPLE_TEAM_ID`: Apple Developer team ID.
- `IOS_BUNDLE_ID`: must stay `com.ristak.app` unless the native app identity
  changes.
- `IOS_APP_STORE_CONNECT_KEY_ID`: App Store Connect API key ID.
- `IOS_APP_STORE_CONNECT_ISSUER_ID`: App Store Connect issuer ID.
- `IOS_APP_STORE_CONNECT_API_KEY_PATH`: private `.p8` file path, usually
  `.mobile-release/ios/AuthKey_<KEY_ID>.p8`.
- `IOS_DISTRIBUTION_CERTIFICATE_PATH`: private Apple Distribution `.p12` path,
  usually `.mobile-release/ios/AppleDistribution.p12`.
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`: password used when exporting the
  `.p12`.
- `IOS_APPSTORE_PROVISIONING_PROFILE_PATH`: App Store `.mobileprovision` for
  `com.ristak.app`.
- `IOS_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_PATH`: App Store
  `.mobileprovision` for `com.ristak.app.NotificationService`.
- `IOS_CI_KEYCHAIN_PASSWORD`: optional password for a temporary CI/local
  keychain.
- `IOS_EXPORT_OPTIONS_PLIST`: App Store export plist path.

Get the App Store Connect API key from App Store Connect > Users and Access >
Integrations > App Store Connect API. Get the distribution certificate and App
Store provisioning profiles from Apple Developer. Both profiles must include the
same distribution certificate used for signing.

El perfil de `com.ristak.app` tambien debe incluir el entitlement
`com.apple.developer.usernotifications.communication` para que las push de chat,
citas y pagos puedan pintar el avatar del contacto con Communication
Notifications. Si Apple Developer muestra capabilities pendientes o el perfil
fue creado antes de activar esa capability, descarga uno nuevo y actualiza el
archivo/local vault o el campo correspondiente en Ristak Installer.

Android:

- `MOBILE_RELEASE_ANDROID_VERSION_NAME`: visible Play Store version.
- `MOBILE_RELEASE_ANDROID_TRACK`: `internal`, `closed`, or `production`.
- `ANDROID_PACKAGE_NAME`: must stay `com.ristak.app` unless the native app
  identity changes.
- `ANDROID_KEYSTORE_PROPERTIES_PATH`: ignored Gradle signing file, usually
  `frontend/android/app/keystore.properties`.
- `ANDROID_KEYSTORE_PATH`: private Play upload keystore, usually
  `frontend/android/app/ristak-play-upload.jks`.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH`: private Google Play service account
  JSON, usually `.mobile-release/android/google-play-service-account.json`.

Get the keystore from the existing Play upload key or create the upload key for
this package. Get the service account JSON from Google Play Console > Setup >
API access, and grant release permissions to the app.

## Workflow inputs

The Installer dispatches these inputs automatically:

- `platform`
- `submit_for_review`
- `ios_version`
- `android_version_name`
- `android_track`
- `installer_url`
- `mobile_release_token`

Manual runs in GitHub are possible only if you provide a valid temporary
`mobile_release_token` generated by Installer. Without that token, the workflow
cannot read signing or store credentials.

## Review mode

The workflow has a `submit_for_review` input.

- `false`: upload the build and leave review/submission manual.
- `true`: ask the target store to submit the uploaded release for review.

Keep `false` while store metadata, privacy/data safety, screenshots, reviewer
credentials, and release notes are still being configured.
