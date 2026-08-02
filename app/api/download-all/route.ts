import { NextResponse } from "next/server";

const MEDIA_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com",
];
const MAX_ITEMS = 20;
const MAX_ITEM_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const REQUEST_HEADERS = {
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36",
};

type RequestedMedia = {
  type?: "image" | "video";
  url?: string;
};

type ZipFile = {
  name: string;
  data: Uint8Array;
};

function isAllowedMediaUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    );
  } catch {
    return false;
  }
}

function inferExtension(contentType: string, requestedType: RequestedMedia["type"]) {
  if (contentType.includes("mp4") || contentType.startsWith("video/")) return "mp4";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return requestedType === "video" ? "mp4" : "jpg";
}

function writeUint16(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function writeUint32(value: number) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concatBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files: ZipFile[]) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const checksum = crc32(file.data);
    const localHeader = concatBytes(
      writeUint32(0x04034b50),
      writeUint16(20),
      writeUint16(0),
      writeUint16(0),
      writeUint16(0),
      writeUint16(0),
      writeUint32(checksum),
      writeUint32(file.data.length),
      writeUint32(file.data.length),
      writeUint16(name.length),
      writeUint16(0),
      name,
      file.data,
    );
    localParts.push(localHeader);

    centralParts.push(
      concatBytes(
        writeUint32(0x02014b50),
        writeUint16(20),
        writeUint16(20),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint32(checksum),
        writeUint32(file.data.length),
        writeUint32(file.data.length),
        writeUint16(name.length),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint32(0),
        writeUint32(offset),
        name,
      ),
    );
    offset += localHeader.length;
  }

  const centralDirectory = concatBytes(...centralParts);
  const endOfDirectory = concatBytes(
    writeUint32(0x06054b50),
    writeUint16(0),
    writeUint16(0),
    writeUint16(files.length),
    writeUint16(files.length),
    writeUint32(centralDirectory.length),
    writeUint32(offset),
    writeUint16(0),
  );

  return concatBytes(...localParts, centralDirectory, endOfDirectory);
}

async function fetchMedia(item: RequestedMedia) {
  if (!item.url || !isAllowedMediaUrl(item.url)) throw new Error("Unsupported media source");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(item.url, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !response.ok ||
      !isAllowedMediaUrl(response.url) ||
      (!contentType.startsWith("image/") && !contentType.startsWith("video/")) ||
      contentLength > MAX_ITEM_BYTES
    ) {
      throw new Error("Instagram media could not be read");
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > MAX_ITEM_BYTES) throw new Error("Instagram media is too large");
    return {
      name: `downflow-${inferExtension(contentType, item.type)}-${Date.now()}`,
      data,
      extension: inferExtension(contentType, item.type),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const rawItems = formData.get("items");
    if (typeof rawItems !== "string") {
      return NextResponse.json({ error: "No media was selected." }, { status: 400 });
    }

    const items = JSON.parse(rawItems) as RequestedMedia[];
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
      return NextResponse.json({ error: "That carousel is too large to bundle." }, { status: 422 });
    }

    const files = await Promise.all(items.map(fetchMedia));
    const totalBytes = files.reduce((total, file) => total + file.data.length, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Those files are too large to bundle." }, { status: 413 });
    }

    const zipFiles = files.map((file, index) => ({
      name: `downflow-${index + 1}.${file.extension}`,
      data: file.data,
    }));
    const zip = createZip(zipFiles);

    return new NextResponse(new Blob([zip], { type: "application/zip" }), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="downflow-carousel.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "The carousel could not be bundled." }, { status: 502 });
  }
}
