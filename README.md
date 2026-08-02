# downflow

A focused Next.js utility for resolving media exposed by public Instagram post, reel, video, and story URLs.

## What it does

- Accepts a full Instagram URL in the input field.
- Resolves public page metadata, Instagram's public media endpoint, and public embed HTML on the server.
- Shows image and video media when Instagram exposes direct media URLs.
- Extracts direct MP4 variants for video posts and keeps their image thumbnails for preview.
- Prefers Instagram's original/full-resolution CDN candidate when available, then falls back to the largest exposed HD variant without upscaling.
- Starts each resolved item as its own download; photos are converted to full-resolution PNG files and videos remain individual MP4 files.
- Downloads media directly in the browser from Instagram's CDN when allowed; the Vercel download route is only a fallback for CDN requests the browser cannot fetch.
- Falls back to the public Instagram embed when direct media is not exposed.

## Important limitation

This app does not bypass Instagram login walls, private accounts, rate limits, or media URLs that Instagram does not expose to an embed or public page request. Use it only for content you own or have permission to save.

## Android share-sheet companion

The optional native Android companion in [`android/`](./android/) adds a `Download images` target to the Android share sheet. It receives a shared Instagram URL, queues the original media with Android's system `DownloadManager`, and finishes its invisible receiver activity immediately. Files are saved to the device's Downloads folder; the Vercel app does not store them.

The companion source is built by [`.github/workflows/android.yml`](./.github/workflows/android.yml), which publishes a debug APK as a GitHub Actions artifact. Install that APK on Android to make the native target appear in the share sheet. The browser/PWA path remains available independently.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

The app is designed to run on Vercel with no environment variables. `/api/resolve` performs the minimum server-side page parsing needed to work around browser CORS, while `/api/download` is a same-origin fallback only when direct browser downloads are unavailable.
