package ca.hardpointnetworks.bytemonitor;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.List;

/**
 * Byte Monitor native sensors for Android: device info, per-core CPU speed, RAM,
 * battery (charge counter, current, cycles, design capacity), thermal state and
 * readable thermal zones, and storage volumes. Read-only; needs no permissions.
 */
@CapacitorPlugin(name = "ByteMonitor")
public class ByteMonitorPlugin extends Plugin {

    private static String readLine(String path) {
        try (BufferedReader r = new BufferedReader(new FileReader(path))) {
            String l = r.readLine();
            return l == null ? null : l.trim();
        } catch (Throwable t) {
            return null;
        }
    }

    private static long readLong(String path) {
        String s = readLine(path);
        if (s == null) return -1;
        try { return Long.parseLong(s); } catch (Throwable t) { return -1; }
    }

    private static String firstExisting(String... paths) {
        for (String p : paths) if (new File(p).exists()) return p;
        return null;
    }

    /** Battery design capacity in mAh via PowerProfile (hidden API, works on most phones), else -1. */
    private double designCapacityMah() {
        try {
            Class<?> c = Class.forName("com.android.internal.os.PowerProfile");
            Object profile = c.getConstructor(Context.class).newInstance(getContext());
            Object v = c.getMethod("getBatteryCapacity").invoke(profile);
            double mah = ((Number) v).doubleValue();
            return mah > 100 ? mah : -1;
        } catch (Throwable t) {
            return -1;
        }
    }

    @PluginMethod
    public void getStatic(PluginCall call) {
        JSObject o = new JSObject();
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("brand", Build.BRAND);
        o.put("model", Build.MODEL);
        o.put("device", Build.DEVICE);
        o.put("board", Build.BOARD);
        o.put("hardware", Build.HARDWARE);
        o.put("android", Build.VERSION.RELEASE);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("securityPatch", Build.VERSION.SECURITY_PATCH);
        o.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        if (Build.VERSION.SDK_INT >= 31) {
            o.put("socManufacturer", Build.SOC_MANUFACTURER);
            o.put("socModel", Build.SOC_MODEL);
        }
        int n = Runtime.getRuntime().availableProcessors();
        o.put("cores", n);
        long maxAll = 0;
        JSArray maxf = new JSArray();
        for (int i = 0; i < n; i++) {
            long f = readLong("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
            maxf.put(f);
            if (f > maxAll) maxAll = f;
        }
        o.put("maxFreqKHz", maxf);
        o.put("maxKHz", maxAll);

        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("ramTotal", mi.totalMem);

        String name = null;
        try { name = Settings.Global.getString(getContext().getContentResolver(), Settings.Global.DEVICE_NAME); } catch (Throwable ignored) { }
        o.put("deviceName", name);
        o.put("designCapacityMah", designCapacityMah());
        String version = "";
        try { version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; } catch (Throwable ignored) { }
        o.put("appVersion", version);
        call.resolve(o);
    }

    @PluginMethod
    public void getLive(PluginCall call) {
        JSObject o = new JSObject();

        // per-core CPU speed (Android 8+ hides system-wide CPU load from apps)
        int n = Runtime.getRuntime().availableProcessors();
        JSArray cur = new JSArray();
        JSArray max = new JSArray();
        for (int i = 0; i < n; i++) {
            String base = "/sys/devices/system/cpu/cpu" + i + "/cpufreq/";
            cur.put(readLong(base + "scaling_cur_freq"));
            max.put(readLong(base + "cpuinfo_max_freq"));
        }
        o.put("curKHz", cur);
        o.put("maxKHz", max);

        // memory
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("ramTotal", mi.totalMem);
        o.put("ramAvail", mi.availMem);
        o.put("lowMemory", mi.lowMemory);

        // battery
        JSObject b = new JSObject();
        Intent bi = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bi != null) {
            b.put("present", bi.getBooleanExtra(BatteryManager.EXTRA_PRESENT, true));
            b.put("level", bi.getIntExtra(BatteryManager.EXTRA_LEVEL, -1));
            b.put("scale", bi.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
            b.put("status", bi.getIntExtra(BatteryManager.EXTRA_STATUS, -1));
            b.put("plugged", bi.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0));
            b.put("health", bi.getIntExtra(BatteryManager.EXTRA_HEALTH, 1));
            b.put("temperature", bi.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -10000) / 10.0);
            b.put("voltage", bi.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1));
            b.put("technology", bi.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY));
            if (Build.VERSION.SDK_INT >= 34) b.put("cycleCount", bi.getIntExtra(BatteryManager.EXTRA_CYCLE_COUNT, -1));
        }
        BatteryManager bm = (BatteryManager) getContext().getSystemService(Context.BATTERY_SERVICE);
        if (bm != null) {
            b.put("chargeCounter", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)); // µAh
            b.put("currentNow", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW));       // µA
            b.put("currentAvg", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE));
        }
        // the battery driver's own figures, on phones that let apps read them (µAh)
        String ps = firstExisting("/sys/class/power_supply/battery", "/sys/class/power_supply/Battery", "/sys/class/power_supply/bms");
        if (ps != null) {
            b.put("chargeFull", readLong(ps + "/charge_full"));
            b.put("chargeFullDesign", readLong(ps + "/charge_full_design"));
            long cyc = readLong(ps + "/cycle_count");
            if (cyc > 0 && !b.has("cycleCount")) b.put("cycleCount", cyc);
        }
        o.put("battery", b);

        // thermal
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            if (Build.VERSION.SDK_INT >= 29) o.put("thermalStatus", pm.getCurrentThermalStatus());
            if (Build.VERSION.SDK_INT >= 30) {
                float h = pm.getThermalHeadroom(0);
                if (!Float.isNaN(h)) o.put("thermalHeadroom", h);
            }
        }
        JSArray zones = new JSArray();
        for (int i = 0; i < 100; i++) {
            String dir = "/sys/class/thermal/thermal_zone" + i;
            if (!new File(dir).exists()) { if (i > 10) break; else continue; }
            String type = readLine(dir + "/type");
            long t = readLong(dir + "/temp");
            if (type == null || t == -1) continue;
            double c = Math.abs(t) > 1000 ? t / 1000.0 : (Math.abs(t) > 200 ? t / 10.0 : t);
            JSObject z = new JSObject();
            z.put("type", type);
            z.put("temp", c);
            zones.put(z);
        }
        o.put("thermal", zones);
        call.resolve(o);
    }

    @PluginMethod
    public void getStorage(PluginCall call) {
        JSObject o = new JSObject();
        JSArray vols = new JSArray();
        try {
            StatFs fs = new StatFs(Environment.getDataDirectory().getPath());
            JSObject v = new JSObject();
            v.put("name", "Internal storage");
            v.put("total", fs.getTotalBytes());
            v.put("free", fs.getAvailableBytes());
            v.put("removable", false);
            vols.put(v);
        } catch (Throwable ignored) { }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                StorageManager sm = (StorageManager) getContext().getSystemService(Context.STORAGE_SERVICE);
                List<StorageVolume> list = sm.getStorageVolumes();
                for (StorageVolume sv : list) {
                    if (!sv.isRemovable() || sv.getDirectory() == null) continue;
                    StatFs fs = new StatFs(sv.getDirectory().getPath());
                    JSObject v = new JSObject();
                    v.put("name", sv.getDescription(getContext()));
                    v.put("total", fs.getTotalBytes());
                    v.put("free", fs.getAvailableBytes());
                    v.put("removable", true);
                    vols.put(v);
                }
            } catch (Throwable ignored) { }
        }
        o.put("volumes", vols);
        call.resolve(o);
    }
}
