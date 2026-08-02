package com.testingkitten.downloadimages;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves a shared Instagram URL and hands each original media URL to
 * Android DownloadManager. DownloadManager owns the files and continues the
 * transfer after this worker and the receiver activity are gone.
 */
public final class ShareDownloadWorker extends Worker {
    static final String KEY_SHARED_TEXT = "shared_text";

    private static final int MAX_MEDIA_ITEMS = 50;
    private static final int CONNECT_TIMEOUT_MS = 12_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final String RANDOM_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern INSTAGRAM_URL = Pattern.compile(
            "https?://(?:www\\.)?(?:instagram\\.com|instagr\\.am)/[^\\s<>\\\"']+",
            Pattern.CASE_INSENSITIVE
    );

    public ShareDownloadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        String sharedText = getInputData().getString(KEY_SHARED_TEXT);
        String instagramUrl = extractInstagramUrl(sharedText);
        if (instagramUrl == null) return Result.failure();

        try {
            JSONObject resolved = resolve(instagramUrl);
            if (!"ready".equalsIgnoreCase(resolved.optString("status"))) {
                return Result.failure();
            }

            JSONArray media = resolved.optJSONArray("media");
            if (media == null || media.length() == 0) return Result.failure();

            String canonicalUrl = resolved.optString("canonicalUrl", instagramUrl);
            String username = resolved.optString("sourceUsername", "");
            String postId = resolved.optString("sourceId", "");
            String[] identity = resolveIdentity(canonicalUrl, username, postId);

            DownloadManager downloadManager = (DownloadManager) getApplicationContext()
                    .getSystemService(Context.DOWNLOAD_SERVICE);
            if (downloadManager == null) return Result.failure();

            int queued = 0;
            for (int index = 0; index < media.length() && index < MAX_MEDIA_ITEMS; index++) {
                JSONObject item = media.optJSONObject(index);
                if (item == null) continue;

                String mediaUrl = item.optString("url", "");
                String mediaType = item.optString("type", "image").toLowerCase(Locale.US);
                if (mediaUrl.isEmpty() || !isHttpUrl(mediaUrl)) continue;

                boolean video = "video".equals(mediaType);
                String baseName = identity[0] + "-" + identity[1] + "-" + randomToken(6);
                String fileName = baseName + (video ? ".mp4" : ".jpg");

                // The resolver is the only Vercel request. The media bytes go
                // directly from Instagram's signed CDN URL to Android.
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(mediaUrl));
                request.setTitle(fileName);
                request.setDescription("Instagram media");
                request.setMimeType(video ? "video/mp4" : "image/jpeg");
                request.addRequestHeader("User-Agent", "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
                request.addRequestHeader("Referer", "https://www.instagram.com/");
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                );
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(false);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                downloadManager.enqueue(request);
                queued++;
            }

            return queued > 0 ? Result.success() : Result.failure();
        } catch (IOException error) {
            // WorkManager can retry transient resolver/network failures while
            // DownloadManager handles the longer media transfers itself.
            return getRunAttemptCount() < 2 ? Result.retry() : Result.failure();
        } catch (JSONException | RuntimeException error) {
            return Result.failure();
        }
    }

    private static JSONObject resolve(String instagramUrl) throws IOException, JSONException {
        URL endpoint = new URL(BuildConfig.DOWNLOADER_BASE_URL + "/api/resolve");
        HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setDoOutput(true);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

        byte[] body = new JSONObject().put("url", instagramUrl)
                .toString()
                .getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);

        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }

        int responseCode = connection.getResponseCode();
        InputStream responseStream = responseCode >= 200 && responseCode < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        String responseBody = responseStream == null ? "" : read(responseStream);
        connection.disconnect();

        if (responseCode < 200 || responseCode >= 300) {
            throw new IOException("Resolver returned HTTP " + responseCode);
        }
        return new JSONObject(responseBody);
    }

    private static String extractInstagramUrl(String sharedText) {
        if (sharedText == null) return null;

        String direct = findInstagramUrl(sharedText);
        if (direct != null) return direct;

        String decoded = decode(sharedText);
        direct = findInstagramUrl(decoded);
        if (direct != null) return direct;

        try {
            Uri redirect = Uri.parse(sharedText.trim());
            String target = redirect.getQueryParameter("u");
            if (target != null) {
                direct = findInstagramUrl(target);
                if (direct != null) return direct;
            }
        } catch (RuntimeException ignored) {
            // The share payload may include arbitrary text; it is safe to
            // fall through and report an invalid link to the worker.
        }
        return null;
    }

    private static String findInstagramUrl(String value) {
        if (value == null) return null;
        Matcher matcher = INSTAGRAM_URL.matcher(value);
        if (!matcher.find()) return null;

        String candidate = matcher.group().replaceFirst("[),.;!?]+$", "");
        try {
            Uri parsed = Uri.parse(candidate);
            String host = parsed.getHost();
            if (host == null) return null;
            host = host.toLowerCase(Locale.US);
            if (!host.equals("instagram.com") && !host.equals("www.instagram.com")
                    && !host.equals("instagr.am") && !host.equals("www.instagr.am")) {
                return null;
            }
            return candidate;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String[] resolveIdentity(String canonicalUrl, String sourceUsername, String sourceId) {
        String username = firstNonBlank(sourceUsername, "instagram");
        String postId = firstNonBlank(sourceId, "media");

        try {
            Uri uri = Uri.parse(canonicalUrl);
            java.util.List<String> segments = uri.getPathSegments();
            int markerIndex = -1;
            for (int index = 0; index < segments.size(); index++) {
                String value = segments.get(index);
                if ("p".equals(value) || "reel".equals(value) || "tv".equals(value)
                        || "stories".equals(value)) {
                    markerIndex = index;
                    break;
                }
            }

            if ("instagram".equals(username) && markerIndex >= 0) {
                if ("stories".equals(segments.get(markerIndex))) {
                    if (markerIndex + 1 < segments.size()
                            && !"highlights".equals(segments.get(markerIndex + 1))) {
                        username = segments.get(markerIndex + 1);
                    }
                } else if (markerIndex > 0) {
                    username = segments.get(markerIndex - 1);
                }
            }

            if ("media".equals(postId) && markerIndex >= 0) {
                int idIndex = markerIndex + 1;
                if ("stories".equals(segments.get(markerIndex))
                        && idIndex < segments.size()
                        && "highlights".equals(segments.get(idIndex))) {
                    idIndex++;
                }
                if (idIndex < segments.size()) postId = segments.get(idIndex);
            }
        } catch (RuntimeException ignored) {
            // Keep the resolver-provided identity when the canonical URL is unusual.
        }

        return new String[]{sanitize(username, "instagram"), sanitize(postId, "media")};
    }

    private static String firstNonBlank(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private static String sanitize(String value, String fallback) {
        String cleaned = value == null
                ? ""
                : value.replaceAll("[^a-zA-Z0-9_-]+", "-")
                        .replaceAll("^-+|-+$", "")
                        .toLowerCase(Locale.US);
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private static String randomToken(int length) {
        StringBuilder output = new StringBuilder(length);
        for (int index = 0; index < length; index++) {
            output.append(RANDOM_ALPHABET.charAt(RANDOM.nextInt(RANDOM_ALPHABET.length())));
        }
        return output.toString();
    }

    private static boolean isHttpUrl(String value) {
        try {
            Uri uri = Uri.parse(value);
            return "https".equalsIgnoreCase(uri.getScheme())
                    || "http".equalsIgnoreCase(uri.getScheme());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            return value;
        }
    }

    private static String read(InputStream stream) throws IOException {
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line);
            }
        }
        return output.toString();
    }
}
