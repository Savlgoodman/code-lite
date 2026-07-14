package com.codelite.remote;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "ImageAlbum",
    permissions = { @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) }
)
public class ImageAlbumPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void save(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("图片内容为空");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "saveAfterPermission");
            return;
        }
        dispatchSave(call);
    }

    @PermissionCallback
    private void saveAfterPermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("没有保存图片到相册的权限");
            return;
        }
        dispatchSave(call);
    }

    private void dispatchSave(PluginCall call) {
        String base64 = call.getString("base64", "");
        String mimeType = normalizeMimeType(call.getString("mimeType", "image/png"));
        String fileName = sanitizeFileName(call.getString("fileName", "code-lite-image.png"));
        executor.execute(() -> saveToAlbum(call, base64, mimeType, fileName));
    }

    private void saveToAlbum(PluginCall call, String base64, String mimeType, String fileName) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            Uri uri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? saveScoped(bytes, mimeType, fileName)
                : saveLegacy(bytes, mimeType, fileName);
            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("保存到相册失败", "SAVE_FAILED", error);
        }
    }

    private Uri saveScoped(byte[] bytes, String mimeType, String fileName) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Code-Lite");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("无法创建相册文件");

        boolean completed = false;
        try (OutputStream stream = resolver.openOutputStream(uri)) {
            if (stream == null) throw new IOException("无法打开相册文件");
            stream.write(bytes);
            stream.flush();
            completed = true;
        } finally {
            if (!completed) resolver.delete(uri, null, null);
        }

        ContentValues published = new ContentValues();
        published.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, published, null, null);
        return uri;
    }

    @SuppressWarnings("deprecation")
    private Uri saveLegacy(byte[] bytes, String mimeType, String fileName) throws IOException {
        File pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
        File directory = new File(pictures, "Code-Lite");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("无法创建相册目录");
        }
        File file = new File(directory, fileName);
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(bytes);
            stream.flush();
        }
        MediaScannerConnection.scanFile(
            getContext(),
            new String[] { file.getAbsolutePath() },
            new String[] { mimeType },
            null
        );
        return Uri.fromFile(file);
    }

    private String normalizeMimeType(String value) {
        return value != null && value.startsWith("image/") ? value : "image/png";
    }

    private String sanitizeFileName(String value) {
        String sanitized = value == null ? "" : value.replaceAll("[^a-zA-Z0-9._-]", "_");
        return sanitized.isEmpty() ? "code-lite-image.png" : sanitized;
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
