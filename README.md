# downflow

A focused PWA for resolving media exposed by public Instagram posts, reels, videos, stories, and X/Twitter posts.

## What it does

- Accepts a full Instagram, X, or Twitter URL in the input field or installed PWA share target.
- Resolves public page and embed metadata without API keys.
- Shows every exposed image, video, and X animated-GIF MP4 in its original order.
- Extracts direct MP4 variants for video posts and keeps their image thumbnails for preview.
- Prefers the original image rendition and highest-resolution audio-bearing MP4 variant without upscaling.
- Starts each resolved item as its own download; photos are converted to full-resolution PNG files and videos remain individual MP4 files.
- Fetches media directly from Instagram/X into the browser, converts photos to PNG locally, and never relays or stores media on Vercel.
- Reuses successful post resolutions from the device for five minutes and briefly caches public resolver responses at the CDN.
- Falls back to the source's public embed when direct media is not exposed.

## Important limitation

This app does not bypass login walls, private accounts, protected posts, rate limits, or media URLs the source does not expose to a public page or embed request. Use it only for content you own or have permission to save.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

The app is designed to run on Vercel with no environment variables. The static interface is CDN-hosted, and the only compute route is the small `/api/resolve` metadata parser. Media previews and downloads go directly from the source CDN to the user's device.
