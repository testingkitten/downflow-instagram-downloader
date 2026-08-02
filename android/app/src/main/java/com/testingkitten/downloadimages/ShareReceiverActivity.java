package com.testingkitten.downloadimages;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.os.Bundle;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

import java.util.UUID;

/**
 * Receives text links from Android's share sheet and immediately finishes.
 * All network and file work happens after this activity has disappeared.
 */
public final class ShareReceiverActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String sharedText = readSharedText(getIntent());
        if (sharedText != null && !sharedText.trim().isEmpty()) {
            Data input = new Data.Builder()
                    .putString(ShareDownloadWorker.KEY_SHARED_TEXT, sharedText)
                    .build();
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ShareDownloadWorker.class)
                    .setInputData(input)
                    .setConstraints(constraints)
                    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                    .build();

            WorkManager.getInstance(getApplicationContext()).enqueueUniqueWork(
                    "instagram-share-" + UUID.randomUUID(),
                    ExistingWorkPolicy.REPLACE,
                    request
            );
        }

        // Remove the receiver from the visible task stack before any download starts.
        finishAndRemoveTask();
    }

    private static String readSharedText(Intent intent) {
        StringBuilder output = new StringBuilder();

        append(output, intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        if (intent.getData() != null) {
            append(output, intent.getData().toString());
        }

        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                ClipData.Item item = clipData.getItemAt(index);
                append(output, item.getText());
                if (item.getUri() != null) {
                    append(output, item.getUri().toString());
                }
            }
        }

        return output.length() == 0 ? null : output.toString();
    }

    private static void append(StringBuilder output, CharSequence value) {
        if (value == null) return;
        String text = value.toString().trim();
        if (text.isEmpty()) return;
        if (output.length() > 0) output.append('\n');
        output.append(text);
    }
}
