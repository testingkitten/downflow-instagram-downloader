import { NextResponse } from "next/server";

function isAllowedMediaUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "instagram.com" ||
        host.endsWith(".instagram.com") ||
        host.endsWith(".cdninstagram.com") ||
        host.endsWith(".fbcdn.net") ||
        host.endsWith(".fbsbx.com") ||
        host === "pbs.twimg.com" ||
        host === "video.twimg.com")
    );
  } catch {
    return false;
  }
}

function safeFileName(value: string | null, contentType: string | null) {
  const extension = contentType?.includes("video")
    ? "mp4"
    : contentType?.includes("png")
      ? "png"
      : contentType?.includes("webp")
        ? "webp"
        : contentType?.includes("gif")
          ? "gif"
          : "jpg";
  const base =
    value
      ?.replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "social-media";
  return `${base}.${extension}`;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const mediaUrl = requestUrl.searchParams.get("url");
  const requestedName = requestUrl.searchParams.get("name");

  if (!mediaUrl || !isAllowedMediaUrl(mediaUrl)) {
    return NextResponse.json({ error: "That media URL is not allowed." }, { status: 400 });
  }

  try {
    const range = request.headers.get("range");
    const upstreamHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0",
    };
    if (range) upstreamHeaders.Range = range;
    const ifRange = request.headers.get("if-range");
    if (ifRange) upstreamHeaders["If-Range"] = ifRange;

    const response = await fetch(mediaUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      cache: "no-store",
    });

    if (response.status === 416) {
      const contentRange = response.headers.get("content-range");
      return new Response(null, {
        status: 416,
        headers: contentRange ? { "Content-Range": contentRange } : undefined,
      });
    }

    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: "The source did not return that media file." },
        { status: 502 },
      );
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
      return NextResponse.json(
        { error: "The resolved URL is not an image or video." },
        { status: 415 },
      );
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeFileName(requestedName, contentType)}"`,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });

    for (const name of [
      "accept-ranges",
      "content-length",
      "content-range",
      "etag",
      "last-modified",
    ]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }

    if (response.status === 206 && !headers.has("accept-ranges")) {
      headers.set("Accept-Ranges", "bytes");
    }
    if (range) headers.set("Vary", "Range");

    return new Response(response.body, {
      status: response.status === 206 ? 206 : 200,
      headers,
    });
  } catch {
    return NextResponse.json(
      { error: "The media file could not be downloaded right now." },
      { status: 502 },
    );
  }
}
