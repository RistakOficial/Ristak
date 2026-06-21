# Mobile Store Releases

Mobile store builds are intentionally manual. Pushes to `main` keep the web/Render
pipeline working, but they do not create App Store Connect or Google Play builds.

Run the GitHub Actions workflow `mobile-store-release` when a mobile build is ready.
It supports:

- `ios`: builds the Capacitor iOS shell and uploads to App Store Connect.
- `android`: builds the Android App Bundle and uploads to Google Play.
- `both`: runs both store jobs from the same commit.

## Required GitHub secrets

Shared:

- `INSTALLER_WEBHOOK_URL`
- `INSTALLER_WEBHOOK_SECRET`

iOS:

- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_P8`
- `IOS_DISTRIBUTION_CERTIFICATE_BASE64`
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`
- `IOS_APPSTORE_PROVISIONING_PROFILE_BASE64`
- `IOS_CI_KEYCHAIN_PASSWORD` (optional)

Android:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`

## Review mode

The workflow has a `submit_for_review` input.

- `false`: upload the build and leave review/submission manual.
- `true`: ask the target store to submit the uploaded release for review.

Keep `false` while store metadata, privacy/data safety, screenshots, reviewer
credentials, and release notes are still being configured.
