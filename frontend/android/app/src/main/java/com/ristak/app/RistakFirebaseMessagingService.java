package com.ristak.app;

import android.Manifest;
import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Process;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

public class RistakFirebaseMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL_ALERTS = "ristak_alerts";
    private static final String CHANNEL_SOUND = "ristak_sound";
    private static final String CHANNEL_VIBRATE = "ristak_vibrate";
    private static final String CHANNEL_SILENT = "ristak_silent";
    private static final int IMAGE_DOWNLOAD_TIMEOUT_MS = 5000;
    private static final int MAX_IMAGE_BYTES = 5 * 1024 * 1024;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        PushNotificationsPlugin.sendRemoteMessage(remoteMessage);

        if (isAppInForeground()) {
            return;
        }

        showNotification(remoteMessage);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
    }

    private void showNotification(RemoteMessage remoteMessage) {
        if (!canPostNotifications()) {
            return;
        }

        Map<String, String> data = remoteMessage.getData();
        RemoteMessage.Notification firebaseNotification = remoteMessage.getNotification();
        String title = first(data.get("title"), firebaseNotification != null ? firebaseNotification.getTitle() : "", getString(R.string.app_name));
        String body = first(data.get("body"), firebaseNotification != null ? firebaseNotification.getBody() : "", "");
        String category = first(data.get("category"), "ristak");
        String channelId = first(data.get("androidChannelId"), data.get("channelId"), getDefaultChannelId(data));
        String contactName = first(data.get("contactName"), data.get("senderName"), title);
        String avatarUrl = first(data.get("contactAvatarUrl"), data.get("senderAvatarUrl"));
        String mediaUrl = first(data.get("notificationImageUrl"), data.get("notificationAttachmentUrl"));
        String threadId = first(data.get("threadId"), data.get("contactId"), data.get("tag"), category);
        String messageId = first(data.get("messageId"), remoteMessage.getMessageId(), data.get("tag"), threadId);
        String tag = first(data.get("tag"), threadId);

        createNotificationChannels();

        Bitmap avatar = toCircleBitmap(downloadBitmap(avatarUrl));
        Bitmap media = isSameUrl(avatarUrl, mediaUrl) ? null : downloadBitmap(mediaUrl);
        Bitmap fallbackLogo = avatar == null ? BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher) : null;
        Bitmap largeIcon = avatar != null ? avatar : fallbackLogo;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_ristak)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(isChatNotification(category) ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_STATUS)
            .setGroup(threadId)
            .setContentIntent(buildContentIntent(data, messageId));

        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon);
        }

        if (media != null) {
            NotificationCompat.BigPictureStyle style = new NotificationCompat.BigPictureStyle()
                .bigPicture(media)
                .setSummaryText(body);
            if (largeIcon != null) {
                style.bigLargeIcon(largeIcon);
            }
            builder.setStyle(style);
        } else if (isChatNotification(category)) {
            builder.setStyle(buildMessagingStyle(contactName, body, avatar));
        } else {
            builder.setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }

        NotificationManagerCompat.from(this).notify(tag, stableNotificationId(messageId), builder.build());
    }

    private NotificationCompat.MessagingStyle buildMessagingStyle(String senderName, String body, Bitmap avatar) {
        Person.Builder senderBuilder = new Person.Builder()
            .setName(first(senderName, getString(R.string.app_name)))
            .setKey(first(senderName, "ristak-sender"));
        if (avatar != null) {
            senderBuilder.setIcon(IconCompat.createWithBitmap(avatar));
        }

        Person user = new Person.Builder()
            .setName(getString(R.string.app_name))
            .setKey("ristak")
            .setBot(true)
            .build();

        Person sender = senderBuilder.build();
        return new NotificationCompat.MessagingStyle(user)
            .addMessage(body, System.currentTimeMillis(), sender);
    }

    private PendingIntent buildContentIntent(Map<String, String> data, String messageId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction("OPEN_RISTAK");
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("google.message_id", messageId);
        for (Map.Entry<String, String> entry : data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, stableNotificationId(messageId), intent, flags);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        manager.createNotificationChannel(buildChannel(
            CHANNEL_ALERTS,
            getString(R.string.notification_channel_alerts_name),
            getString(R.string.notification_channel_alerts_description),
            NotificationManager.IMPORTANCE_HIGH,
            true,
            true
        ));
        manager.createNotificationChannel(buildChannel(
            CHANNEL_SOUND,
            getString(R.string.notification_channel_sound_name),
            getString(R.string.notification_channel_sound_description),
            NotificationManager.IMPORTANCE_HIGH,
            true,
            false
        ));
        manager.createNotificationChannel(buildChannel(
            CHANNEL_VIBRATE,
            getString(R.string.notification_channel_vibration_name),
            getString(R.string.notification_channel_vibration_description),
            NotificationManager.IMPORTANCE_HIGH,
            false,
            true
        ));
        manager.createNotificationChannel(buildChannel(
            CHANNEL_SILENT,
            getString(R.string.notification_channel_silent_name),
            getString(R.string.notification_channel_silent_description),
            NotificationManager.IMPORTANCE_DEFAULT,
            false,
            false
        ));
    }

    private NotificationChannel buildChannel(String id, String name, String description, int importance, boolean sound, boolean vibration) {
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.enableVibration(vibration);
        channel.enableLights(sound || vibration);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        if (!sound) {
            channel.setSound(null, null);
        } else {
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttributes);
        }

        return channel;
    }

    private String getDefaultChannelId(Map<String, String> data) {
        boolean sound = !"false".equalsIgnoreCase(first(data.get("soundEnabled"), "true"));
        boolean vibration = !"false".equalsIgnoreCase(first(data.get("vibrationEnabled"), "true"));
        if (sound && vibration) {
            return CHANNEL_ALERTS;
        }
        if (sound) {
            return CHANNEL_SOUND;
        }
        if (vibration) {
            return CHANNEL_VIBRATE;
        }
        return CHANNEL_SILENT;
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isAppInForeground() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }

        for (ActivityManager.RunningAppProcessInfo processInfo : manager.getRunningAppProcesses()) {
            if (processInfo.pid == Process.myPid()) {
                return processInfo.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        }
        return false;
    }

    private Bitmap downloadBitmap(String value) {
        String url = first(value);
        if (!isPublicImageUrl(url)) {
            return null;
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
            connection.setReadTimeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.connect();

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                return null;
            }

            String contentType = first(connection.getContentType()).toLowerCase();
            if (!contentType.isEmpty() && !contentType.startsWith("image/")) {
                return null;
            }

            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_IMAGE_BYTES) {
                        return null;
                    }
                    output.write(buffer, 0, count);
                }
                byte[] bytes = output.toByteArray();
                return bytes.length > 0 ? BitmapFactory.decodeByteArray(bytes, 0, bytes.length) : null;
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private Bitmap toCircleBitmap(Bitmap source) {
        if (source == null) {
            return null;
        }

        int size = Math.min(source.getWidth(), source.getHeight());
        Bitmap output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        BitmapShader shader = new BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        float dx = (size - source.getWidth()) / 2f;
        float dy = (size - source.getHeight()) / 2f;
        Matrix matrix = new Matrix();
        matrix.setTranslate(dx, dy);
        shader.setLocalMatrix(matrix);
        paint.setShader(shader);
        canvas.drawOval(new RectF(0, 0, size, size), paint);
        return output;
    }

    private int stableNotificationId(String value) {
        int hash = first(value, "ristak").hashCode();
        return hash == Integer.MIN_VALUE ? 1 : Math.abs(hash);
    }

    private boolean isChatNotification(String category) {
        return "chat".equalsIgnoreCase(first(category));
    }

    private boolean isSameUrl(String left, String right) {
        String cleanLeft = first(left);
        String cleanRight = first(right);
        return !cleanLeft.isEmpty() && cleanLeft.equals(cleanRight);
    }

    private boolean isPublicImageUrl(String value) {
        String url = first(value).toLowerCase();
        return url.startsWith("https://") || url.startsWith("http://");
    }

    private String first(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            if (value != null) {
                String clean = value.trim();
                if (!clean.isEmpty()) {
                    return clean;
                }
            }
        }
        return "";
    }
}
