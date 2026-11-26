package com.example.deepseekchat;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 外部应用（WPS / 微信 / QQ / 系统文件管理器）把文件「打开方式 / 分享」给鲸落时的接收入口。
 *
 * <p>这个插件只做**接收与落副本**，一个字节都不解析：把 {@code content://} 读成 App 私有 cache
 * 里的一份副本，然后把「副本路径 + 文件名 + MIME + 大小」交给 JS（{@code ExternalFile} 桥）。
 * 解析、校验、入草稿全在既有的附件链路里（{@code src/services/externalImport.ts} →
 * {@code useAttachmentDrafts().addFiles()} → {@code attachmentManager.addFile()}），
 * **不在这里写第二套解析**。
 *
 * <p>三条 intent 的处理：
 * <ul>
 *   <li>{@code ACTION_VIEW}：{@code getData()}；</li>
 *   <li>{@code ACTION_SEND}：{@code EXTRA_STREAM}（个别应用只给 {@code ClipData}，一并兜住）；</li>
 *   <li>{@code ACTION_SEND_MULTIPLE}：{@code EXTRA_STREAM}（{@code ArrayList<Uri>}）**以及**
 *       {@code getClipData()}（有的 ROM 只填其中一个）。</li>
 * </ul>
 *
 * <p><b>权限</b>：{@code content://} 一律走 {@code ContentResolver.openInputStream()}，
 * 靠发送方给的临时读权限，**不申请任何存储权限**（清单里没有
 * {@code READ_EXTERNAL_STORAGE} / {@code MANAGE_EXTERNAL_STORAGE}，也不会有）。
 *
 * <p><b>时序</b>：冷启动时 {@code MainActivity.onCreate()} 直接把初始 intent 交进来（此时桥可能还没
 * 起来），热启动走 {@code onNewIntent}。为了两条路都不丢数据，收到的批次先进 {@link #PENDING_*}
 * 队列（进程内静态），桥就绪后再由 {@link #deliverIfPossible()} 以 {@code filesReceived} 事件推给 JS，
 * 或由 JS 主动 {@link #consumePending()} 取走 —— **两条路只取一次**（drain 语义）。
 *
 * <p><b>去重</b>：签名 = {@code uri + size + lastModified}，落在 SharedPreferences
 * （TTL 10 分钟，最多记 {@link #DEDUPE_MAX} 条）。配置变更 / 二次点击 / {@code MainActivity}
 * 与 {@code Bridge} 两条分发路同时到达，都会被这一层吃掉，不会重复导入。
 *
 * <p><b>临时文件</b>：副本落在 {@code getCacheDir()/external-import/<uuid>-<name>}；JS 确认导入后调
 * {@link #clearTemp} 删除；漏掉的由冷启动时 {@link #cleanupStale} 清扫（超过 24h 的删掉，
 * 不让缓存目录长期膨胀）。
 */
@CapacitorPlugin(name = "ExternalFile")
public class ExternalFilePlugin extends Plugin {

    private static final String TAG = "ExternalFile";
    /** JS 侧订阅的事件名 */
    private static final String EVENT_FILES_RECEIVED = "filesReceived";
    /** 副本目录（App 私有 cache 下） */
    private static final String DIR_NAME = "external-import";
    /** 冷启动清扫：超过 24h 的副本视为残留 */
    private static final long TEMP_TTL_MS = 24L * 60L * 60L * 1000L;
    /** 去重窗口：10 分钟内同签名视为同一次分享 */
    private static final long DEDUPE_TTL_MS = 10L * 60L * 1000L;
    /** 去重表上限（条），滚动淘汰最旧的 */
    private static final int DEDUPE_MAX = 64;
    private static final String PREFS = "external-import";
    private static final String PREFS_SEEN = "seen-signatures";
    /** 拷贝缓冲区：64KiB，与导出侧的 32KiB 同量级，避免大文件时每修一次都要改两处 */
    private static final int BUFFER_BYTES = 64 * 1024;

    /* ------------------------------------------------------------------ 限制（数字来自 TS 唯一阈值表）
     *
     * 这三个数字**不是**这里的真相源：`src/services/attachments/limits.ts` 的 `ATTACHMENT_LIMITS`
     * （→ `src/services/limits.ts` 的 `LIMITS.attachments.doc.*`）才是，并且
     * `tests/unit/external-import.test.mjs` 有一条断言把本文件里的字面量与 TS 的值对齐 ——
     * 改了 TS 忘了改这里，那条单测会红。
     *
     * 这里先判一次只是为了「超限就**不复制**」：50MB 的 PDF 复制完了再说太大，既慢又白占磁盘。
     * 权威判断仍在 TS 侧（`classifyAttachmentFiles` / `attachmentManager.addFile()`）。
     */
    private static final long TXT_MAX_BYTES = 5L * 1024 * 1024;
    private static final long DOCX_MAX_BYTES = 20L * 1024 * 1024;
    private static final long PDF_MAX_BYTES = 50L * 1024 * 1024;

    /**
     * 扩展名 → 规范 MIME（与 `SUPPORTED_EXTENSIONS` 一一对应）。
     *
     * <p>与清单里的 intent-filter 同源：`AndroidManifest.xml` 声明的就是这三个 MIME 加
     * `application/octet-stream`。**不许出现 `*\/*`** —— 一揽子接会让鲸落在「打开方式」里
     * 抢走本该给别的 App 的文件，也接不住「接住了又解析不了」的那类文件。
     */
    private static final String MIME_TXT = "text/plain";
    private static final String MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    private static final String MIME_PDF = "application/pdf";

    /** 「系统没给 MIME」的两种取值：空串（部分文件提供器）与 octet-stream（下载目录 / 网盘 / 微信） */
    private static final Set<String> UNKNOWN_MIME_TYPES =
            Collections.unmodifiableSet(new HashSet<>(java.util.Arrays.asList("", "application/octet-stream")));

    /* ------------------------------------------------------------------ 进程内批次队列 */
    private static final Object LOCK = new Object();
    private static final List<JSObject> PENDING_FILES = new ArrayList<>();
    private static final List<JSObject> PENDING_REJECTED = new ArrayList<>();
    /** 正在处理的签名（并发保护：同一 intent 被两条分发路同时送进来时只有一条真的去复制） */
    private static final Set<String> IN_FLIGHT = new HashSet<>();
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    /** 当前活着的插件实例（Activity 重建后由 {@link #load()} 换掉） */
    private static volatile ExternalFilePlugin instance;

    /** 太小的兜底：SIZE 拿不到时边拷边判，超了就整份丢掉（不留半截文件） */
    private static final class TooLargeException extends Exception {
        TooLargeException() {
            super("size limit exceeded while copying");
        }
    }

    @Override
    public void load() {
        instance = this;
        final Context context = getContext();
        if (context != null) {
            final Context app = context.getApplicationContext();
            // 冷启动清扫：上一次进程没来得及 clearTemp 的副本不该永远留在缓存里
            IO.execute(() -> cleanupStale(app));
        }
        // 上一次实例收到但还没送出去的批次（极端时序）继续送一次
        deliverIfPossible();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        // Capacitor 的 Bridge 会把 onNewIntent 转发给每个插件；MainActivity 也会主动调
        // capture()（需求要求两条路都在），重复的那一路由签名去重吃掉。
        capture(getContext(), intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    /* ------------------------------------------------------------------ 入口：intent → 副本 */

    /**
     * 把一条 intent 里的文件收进来（读 → 校验 → 复制到私有 cache → 进批次队列）。
     *
     * <p>可被 {@code MainActivity} 直接静态调用：冷启动时桥/插件实例可能还不存在，
     * 所以 IO 与队列都必须是静态的，实例只用来 notify。
     */
    public static void capture(Context context, Intent intent) {
        if (context == null || intent == null) {
            return;
        }
        final List<Uri> uris = urisOf(intent);
        if (uris.isEmpty()) {
            return;
        }
        final Context app = context.getApplicationContext();
        final String intentMime = intent.getType();
        IO.execute(() -> importAll(app, uris, intentMime));
    }

    /** 按 action 取 URI：VIEW 取 getData，SEND/SEND_MULTIPLE 取 EXTRA_STREAM（+ ClipData） */
    private static List<Uri> urisOf(Intent intent) {
        final List<Uri> uris = new ArrayList<>();
        final String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            addIfPresent(uris, intent.getData());
            addClipData(uris, intent);
            return uris;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            addIfPresent(uris, (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM));
            // 个别 ROM / 应用只填 ClipData，不填 EXTRA_STREAM
            addClipData(uris, intent);
            return uris;
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            final ArrayList<Uri> streams;
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            }
            if (streams != null) {
                for (Uri uri : streams) {
                    addIfPresent(uris, uri);
                }
            }
            // 两者都可能存在（也可能只有其中一个），都收；重复由去重层吃掉
            addClipData(uris, intent);
            return uris;
        }
        return uris;
    }

    private static void addIfPresent(List<Uri> uris, Uri uri) {
        if (uri != null && !uris.contains(uri)) {
            uris.add(uri);
        }
    }

    private static void addClipData(List<Uri> uris, Intent intent) {
        final android.content.ClipData clip = intent.getClipData();
        if (clip == null) {
            return;
        }
        for (int index = 0; index < clip.getItemCount(); index += 1) {
            addIfPresent(uris, clip.getItemAt(index).getUri());
        }
    }

    private static void importAll(Context context, List<Uri> uris, String intentMime) {
        final List<JSObject> files = new ArrayList<>();
        final List<JSObject> rejected = new ArrayList<>();
        for (Uri uri : uris) {
            try {
                importOne(context, uri, intentMime, files, rejected);
            } catch (SecurityException error) {
                Log.w(TAG, "读取被拒绝（无权限），已记入 rejected");
                rejected.add(rejectedItem(displayName(context, uri), "noPermission", -1));
            } catch (Throwable error) {
                Log.w(TAG, "导入失败：" + error.getClass().getSimpleName());
                rejected.add(rejectedItem(displayName(context, uri), "readFailed", -1));
            }
        }
        if (files.isEmpty() && rejected.isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            PENDING_FILES.addAll(files);
            PENDING_REJECTED.addAll(rejected);
        }
        deliverIfPossible();
    }

    private static void importOne(
            Context context, Uri uri, String intentMime, List<JSObject> files, List<JSObject> rejected)
            throws IOException {
        final String name = displayName(context, uri);
        final String extension = extensionOf(name);
        final long size = sizeOf(context, uri);
        final String providedMime = normalizeMime(providedMime(context, uri, intentMime));

        // ① 类型：MIME 只信一半 —— octet-stream / 空当作「未提供」，判定交给扩展名；
        //    其余必须与扩展名逐字相符（把 .exe 改名成 .pdf 会在这里被挡下）
        final String mimeType = resolveMime(extension, providedMime);
        if (mimeType == null) {
            Log.i(TAG, "不支持的文件类型，未复制：" + extension);
            rejected.add(rejectedItem(name, "unsupported", size));
            return;
        }
        final long limit = limitOf(extension);

        // ② 大小：拿得到就先判，超了**不复制**（复制完再说太大既慢又占磁盘）
        if (size > limit) {
            rejected.add(rejectedItem(name, "tooLarge", size));
            return;
        }

        // ③ 去重：uri + size + lastModified，TTL 10 分钟
        final String signature = signatureOf(uri, size, lastModifiedOf(context, uri), name);
        synchronized (LOCK) {
            if (IN_FLIGHT.contains(signature) || isDuplicate(context, signature)) {
                Log.i(TAG, "重复的分享意图，已跳过");
                return;
            }
            IN_FLIGHT.add(signature);
        }

        File target = null;
        try {
            target = copy(context, uri, name, limit);
            final JSObject item = new JSObject();
            item.put("id", idOf(target));
            item.put("name", name);
            item.put("mimeType", mimeType);
            item.put("size", target.length());
            item.put("srcPath", target.getAbsolutePath());
            files.add(item);
            markSeen(context, signature);
            Log.i(TAG, "已收下外部文件（副本已落 App 私有 cache）");
        } catch (TooLargeException error) {
            deleteQuietly(target);
            rejected.add(rejectedItem(name, "tooLarge", size <= 0 ? -1 : size));
        } catch (SecurityException error) {
            deleteQuietly(target);
            rejected.add(rejectedItem(name, "noPermission", size));
        } catch (IOException error) {
            deleteQuietly(target);
            rejected.add(rejectedItem(name, "readFailed", size));
        } finally {
            synchronized (LOCK) {
                IN_FLIGHT.remove(signature);
            }
        }
    }

    /* ------------------------------------------------------------------ 读 / 复制 */

    private static InputStream openStream(Context context, Uri uri) throws IOException {
        final String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if ("file".equals(scheme)) {
            // file:// 只用于本机路径（部分 ROM 的文件管理器仍会给）；不申请存储权限，
            // 读不到就是 SecurityException，由上面的 catch 落成 noPermission
            final String path = uri.getPath();
            if (path == null) {
                throw new IOException("file uri without path");
            }
            return new FileInputStream(new File(path));
        }
        // content:// 一律走 resolver（靠发送方授予的临时读权限，**不申请任何存储权限**）
        final InputStream stream = context.getContentResolver().openInputStream(uri);
        if (stream == null) {
            throw new IOException("openInputStream returned null");
        }
        return stream;
    }

    /** 复制到 {@code getCacheDir()/external-import/<uuid>-<name>}；超过 limit 立即中止并删掉半截文件 */
    private static File copy(Context context, Uri uri, String name, long limit) throws IOException, TooLargeException {
        final File dir = new File(context.getCacheDir(), DIR_NAME);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("cannot create import dir");
        }
        final File target = new File(dir, UUID.randomUUID().toString() + "-" + sanitize(name));
        long total = 0;
        try (InputStream input = openStream(context, uri);
                OutputStream output = new FileOutputStream(target)) {
            final byte[] buffer = new byte[BUFFER_BYTES];
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                // SIZE 未知（-1）时的兜底：边拷边判，超了整份丢掉，磁盘上不留半截
                if (total > limit) {
                    throw new TooLargeException();
                }
                output.write(buffer, 0, count);
            }
            output.flush();
        } catch (TooLargeException | IOException error) {
            deleteQuietly(target);
            throw error;
        }
        return target;
    }

    private static String sanitize(String name) {
        final String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        return cleaned.isEmpty() ? "import.bin" : cleaned;
    }

    /**
     * 副本 id = 文件名开头的 UUID（36 字符）。**不能**用「第一个 '-' 之前」切：
     * UUID 自己就带 4 个 '-'，那样切出来的 id 会在 {@link #deleteTempByIds} 里匹配不上。
     */
    private static final int UUID_LENGTH = 36;

    private static String idOf(File file) {
        final String fileName = file.getName();
        return fileName.length() > UUID_LENGTH ? fileName.substring(0, UUID_LENGTH) : fileName;
    }

    private static void deleteQuietly(File file) {
        try {
            if (file != null && file.exists() && !file.delete()) {
                Log.w(TAG, "临时副本删除失败");
            }
        } catch (Exception ignored) {
            // 删不掉就留给 24h 清扫
        }
    }

    /* ------------------------------------------------------------------ 元数据 */

    /** 文件名：优先 {@code OpenableColumns.DISPLAY_NAME}，拿不到退回路径尾段 */
    private static String displayName(Context context, Uri uri) {
        try (Cursor cursor = query(context, uri, OpenableColumns.DISPLAY_NAME)) {
            if (cursor != null && cursor.moveToFirst()) {
                final String value = cursor.getString(0);
                if (value != null && !value.trim().isEmpty()) {
                    return value;
                }
            }
        } catch (Exception ignored) {
            // 提供器不认这一列：退回路径尾段
        }
        final String fallback = uri.getLastPathSegment();
        return fallback == null || fallback.trim().isEmpty() ? "import.bin" : fallback;
    }

    /** 字节数：拿不到返回 -1（拷贝时边写边判） */
    private static long sizeOf(Context context, Uri uri) {
        try (Cursor cursor = query(context, uri, OpenableColumns.SIZE)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Exception ignored) {
            // 同上
        }
        return -1L;
    }

    /** 最后修改时间：只用于去重签名，取不到就是 0 */
    private static long lastModifiedOf(Context context, Uri uri) {
        try (Cursor cursor = query(context, uri, android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Exception ignored) {
            // 非 DocumentsProvider（微信 / WPS 自带的 FileProvider 常见）→ 0
        }
        return 0L;
    }

    private static Cursor query(Context context, Uri uri, String column) {
        final ContentResolver resolver = context.getContentResolver();
        return resolver.query(uri, new String[] {column}, null, null, null);
    }

    private static String providedMime(Context context, Uri uri, String intentMime) {
        try {
            final String type = context.getContentResolver().getType(uri);
            if (type != null && !type.trim().isEmpty()) {
                return type;
            }
        } catch (Exception ignored) {
            // resolver 不认识这个 uri：退回 intent 上的类型
        }
        return intentMime;
    }

    private static String normalizeMime(String mime) {
        if (mime == null) {
            return "";
        }
        final String lower = mime.trim().toLowerCase(Locale.US);
        final int semicolon = lower.indexOf(';');
        return semicolon >= 0 ? lower.substring(0, semicolon).trim() : lower;
    }

    /**
     * 扩展名 + MIME 双判：返回规范 MIME，判定不通过返回 {@code null}。
     *
     * <p>与 JS 侧 {@code manager.ts} 的 {@code resolveExtension()} 同一口径：
     * 「系统没给 MIME」时只看扩展名（WPS / 微信给的经常是 octet-stream），
     * 给了 MIME 就必须与扩展名对得上。
     */
    private static String resolveMime(String extension, String mime) {
        final String canonical = mimeOf(extension);
        if (canonical == null) {
            return null;
        }
        if (UNKNOWN_MIME_TYPES.contains(mime)) {
            return canonical;
        }
        return canonical.equals(mime) ? canonical : null;
    }

    private static String mimeOf(String extension) {
        if (".txt".equals(extension)) {
            return MIME_TXT;
        }
        if (".docx".equals(extension)) {
            return MIME_DOCX;
        }
        if (".pdf".equals(extension)) {
            return MIME_PDF;
        }
        return null;
    }

    private static long limitOf(String extension) {
        if (".txt".equals(extension)) {
            return TXT_MAX_BYTES;
        }
        if (".docx".equals(extension)) {
            return DOCX_MAX_BYTES;
        }
        if (".pdf".equals(extension)) {
            return PDF_MAX_BYTES;
        }
        return 0L;
    }

    private static String extensionOf(String name) {
        if (name == null) {
            return "";
        }
        final int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot).toLowerCase(Locale.US) : "";
    }

    private static JSObject rejectedItem(String name, String reason, long size) {
        final JSObject item = new JSObject();
        item.put("name", name == null ? "" : name);
        item.put("reason", reason);
        if (size >= 0) {
            item.put("size", size);
        }
        return item;
    }

    /* ------------------------------------------------------------------ 去重表 */

    private static String signatureOf(Uri uri, long size, long lastModified, String name) {
        final String raw = uri.toString() + "|" + size + "|" + lastModified + "|" + name;
        return raw.replace("\n", " ");
    }

    /** 记过的签名（10 分钟内）→ true。顺带把过期条目清掉，写回的概率由 {@link #markSeen} 负责 */
    private static boolean isDuplicate(Context context, String signature) {
        final long now = System.currentTimeMillis();
        final String[] entries = readSeen(context);
        for (String entry : entries) {
            final int divider = entry.lastIndexOf('|');
            if (divider <= 0) {
                continue;
            }
            final String stored = entry.substring(0, divider);
            final long stamp;
            try {
                stamp = Long.parseLong(entry.substring(divider + 1));
            } catch (NumberFormatException error) {
                continue;
            }
            if (now - stamp > DEDUPE_TTL_MS) {
                continue;
            }
            if (stored.equals(signature)) {
                return true;
            }
        }
        return false;
    }

    private static void markSeen(Context context, String signature) {
        final long now = System.currentTimeMillis();
        final List<String> kept = new ArrayList<>();
        for (String entry : readSeen(context)) {
            final int divider = entry.lastIndexOf('|');
            if (divider <= 0) {
                continue;
            }
            try {
                if (now - Long.parseLong(entry.substring(divider + 1)) <= DEDUPE_TTL_MS) {
                    kept.add(entry);
                }
            } catch (NumberFormatException ignored) {
                // 坏条目直接丢
            }
        }
        kept.add(signature + "|" + now);
        while (kept.size() > DEDUPE_MAX) {
            kept.remove(0);
        }
        prefs(context).edit().putString(PREFS_SEEN, String.join("\n", kept)).apply();
    }

    private static String[] readSeen(Context context) {
        final String raw = prefs(context).getString(PREFS_SEEN, "");
        return raw == null || raw.isEmpty() ? new String[0] : raw.split("\n");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ------------------------------------------------------------------ 临时文件回收 */

    /** 冷启动清扫：删掉 24h 前的副本（上一次进程没来得及 clearTemp 的那些） */
    private static void cleanupStale(Context context) {
        try {
            final File dir = new File(context.getCacheDir(), DIR_NAME);
            final File[] items = dir.listFiles();
            if (items == null) {
                return;
            }
            final long now = System.currentTimeMillis();
            int removed = 0;
            for (File item : items) {
                if (now - item.lastModified() > TEMP_TTL_MS && item.delete()) {
                    removed += 1;
                }
            }
            if (removed > 0) {
                Log.i(TAG, "冷启动清扫了 " + removed + " 个过期导入副本");
            }
        } catch (Exception error) {
            Log.w(TAG, "清扫导入副本失败：" + error.getClass().getSimpleName());
        }
    }

    private static void deleteTempByIds(Context context, List<String> ids) {
        if (ids.isEmpty()) {
            return;
        }
        try {
            final File dir = new File(context.getCacheDir(), DIR_NAME);
            final File[] items = dir.listFiles();
            if (items == null) {
                return;
            }
            for (File item : items) {
                for (String id : ids) {
                    if (item.getName().startsWith(id + "-")) {
                        if (!item.delete()) {
                            Log.w(TAG, "导入副本删除失败，留给 24h 清扫");
                        }
                        break;
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "删除导入副本失败：" + error.getClass().getSimpleName());
        }
    }

    /* ------------------------------------------------------------------ 桥方法 */

    /**
     * 取走「还没送出去的批次」。冷启动时 JS 先调它一次（那时事件监听器可能还没挂上），
     * 之后再靠 {@code filesReceived} 事件。两条路都是 drain 语义，同一批只会给一次。
     *
     * <p>永远 {@code resolve}，形状固定 {@code { files: [...], rejected: [...] }}（没有就是空数组）。
     */
    @PluginMethod
    public void consumePending(PluginCall call) {
        call.resolve(drain());
    }

    /**
     * JS 确认导入后删掉副本。{@code ids} 是 {@code consumePending} / 事件里给的 {@code id}
     * （= 副本文件名前缀），删不到不报错（可能已被 24h 清扫）。
     */
    @PluginMethod
    public void clearTemp(PluginCall call) {
        final List<String> ids = new ArrayList<>();
        final JSArray array = call.getArray("ids");
        if (array != null) {
            try {
                for (Object value : array.toList()) {
                    if (value != null) {
                        ids.add(String.valueOf(value));
                    }
                }
            } catch (Exception error) {
                Log.w(TAG, "ids 解析失败，本次不删任何副本");
            }
        }
        final Context context = getContext();
        if (context != null && !ids.isEmpty()) {
            final Context app = context.getApplicationContext();
            IO.execute(() -> deleteTempByIds(app, ids));
        }
        call.resolve();
    }

    /** 把队列整个取走（调用方拿到的一定是「此前没人取过」的那一批） */
    private static JSObject drain() {
        final JSArray files = new JSArray();
        final JSArray rejected = new JSArray();
        synchronized (LOCK) {
            for (JSObject item : PENDING_FILES) {
                files.put(item);
            }
            for (JSObject item : PENDING_REJECTED) {
                rejected.put(item);
            }
            PENDING_FILES.clear();
            PENDING_REJECTED.clear();
        }
        final JSObject payload = new JSObject();
        payload.put("files", files);
        payload.put("rejected", rejected);
        return payload;
    }

    /** 桥就绪且 JS 已订阅时把队列推过去；否则留在队列里等 {@link #consumePending()} */
    private static void deliverIfPossible() {
        final ExternalFilePlugin target = instance;
        if (target == null) {
            return;
        }
        synchronized (LOCK) {
            if (PENDING_FILES.isEmpty() && PENDING_REJECTED.isEmpty()) {
                return;
            }
            if (!target.hasListeners(EVENT_FILES_RECEIVED)) {
                return;
            }
            target.notifyListeners(EVENT_FILES_RECEIVED, drain());
        }
    }
}
