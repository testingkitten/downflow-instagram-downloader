# Download images — Android companion

This small native companion adds a real Android share-sheet target named **Download images**. When an Instagram link is shared to it:

1. the receiver reads the shared URL;
2. the receiver schedules the existing Vercel `/api/resolve` endpoint;
3. Android `DownloadManager` queues each signed original CDN URL directly in the device's `Downloads` folder;
4. the receiver finishes immediately and leaves no visible app screen behind.

The Vercel app does not store the files or proxy the media bytes on this native path. It only resolves the public media URL once; Android owns the background transfer and local file storage.

## Build

Open this `android` folder in Android Studio, or run the GitHub Actions workflow in `.github/workflows/android.yml`. The workflow produces a debug APK artifact for installation on an Android device.

The project targets Android API 36, requires Android 10 or newer, and uses Java 17. A release build still needs an application signing key before it can be distributed through Google Play or installed as a production-signed APK.
