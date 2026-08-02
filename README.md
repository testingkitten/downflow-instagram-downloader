# downflow

A focused Next.js utility for resolving media exposed by public Instagram post, reel, video, and story URLs.

## What it does

- Accepts a full Instagram URL in the input field.
- Resolves public page metadata, Instagram's public media endpoint, and public embed HTML on the server.
- Shows image and video media when Instagram exposes direct media URLs.
- Prefers Instagram's original/full-resolution CDN candidate when available, then falls back to the largest exposed HD variant without upscaling.
- Starts each resolved item as its own download; photos are converted to full-resolution PNG files and videos remain individual MP4 files.
- Falls back to the public Instagram embed when direct media is not exposed.

## Important limitation

This app does not bypass Instagram login walls, private accounts, rate limits, or media URLs that Instagram does not expose to an embed or public page request. Use it only for content you own or have permission to save.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

The app is designed to run on Vercel with no environment variables. The `/api/resolve` and `/api/download` routes handle public-page parsing and the same-origin download fallback.
