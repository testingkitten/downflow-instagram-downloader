package com.testingkitten.downloadimages;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Opens the full web app when the native companion is launched normally.
 * The share receiver is a separate no-display activity so share handoffs do
 * not leave a visible Android window behind.
 */
public final class LauncherActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.DOWNLOADER_BASE_URL)));
        } finally {
            finish();
        }
    }
}
