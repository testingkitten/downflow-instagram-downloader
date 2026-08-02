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
        host.endsWith(".fbsbx.com"))
    );
  } catch {
    return false;
  }
}

function safeFileName(value: string | null, contentType: string | null) {
  const extension = contentType?.includes("video") ? "mp4" : "jpg";
  const base =
    value
      ?.replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "instagram-media";
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
    const response = await fetch(mediaUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      cache: "no-store",
    });

    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: "Instagram did not return that media file." },
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

    return new Response(response.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeFileName(requestedName, contentType)}"`,
        "Content-Type": contentType,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "The media file could not be downloaded right now." },
      { status: 502 },
    );
  }
}
