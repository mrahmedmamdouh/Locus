package expo.modules.locuswifi

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * One Wi-Fi scan for Locus Field. Never reads or returns SSIDs (network names):
 * only BSSID, signal, frequency, RTT support and result age.
 */
class LocusWifiModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LocusWifi")

    AsyncFunction("scan") { timeoutMs: Int, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.resolve(emptyResult(true, true, 0, "React context not available"))
        return@AsyncFunction
      }
      Handler(Looper.getMainLooper()).post { scan(context, timeoutMs, promise) }
    }
  }

  private fun emptyResult(granted: Boolean, locationEnabled: Boolean, elapsedMs: Int, error: String?): Map<String, Any?> =
    mapOf(
      "started" to false,
      "updated" to false,
      "permission" to (if (granted) "granted" else "denied"),
      "locationEnabled" to locationEnabled,
      "wifiEnabled" to false,
      "elapsedMs" to elapsedMs,
      "results" to emptyList<Map<String, Any?>>(),
      "error" to error
    )

  /** Runs on the main looper; resolves exactly once. */
  private fun scan(context: Context, timeoutMs: Int, promise: Promise) {
    val startMs = SystemClock.elapsedRealtime()
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    val locationEnabled = locationManager != null && LocationManagerCompat.isLocationEnabled(locationManager)
    val wifiManager = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    if (wifiManager == null) {
      promise.resolve(emptyResult(granted, locationEnabled, 0, "No Wi-Fi hardware"))
      return
    }
    if (!granted) {
      promise.resolve(emptyResult(false, locationEnabled, 0, null))
      return
    }

    val handler = Handler(Looper.getMainLooper())
    var settled = false
    var started = false
    var receiver: BroadcastReceiver? = null
    var timeout: Runnable? = null

    fun finish(updated: Boolean, error: String?) {
      if (settled) return
      settled = true
      timeout?.let { handler.removeCallbacks(it) }
      var err = error
      var results: List<Map<String, Any?>> = emptyList()
      var wifiEnabled = false
      try {
        wifiEnabled = wifiManager.isWifiEnabled
        results = readResults(wifiManager)
      } catch (e: SecurityException) {
        err = err ?: ("SecurityException: " + (e.message ?: ""))
      } catch (e: Exception) {
        err = err ?: (e.javaClass.simpleName + ": " + (e.message ?: ""))
      } finally {
        receiver?.let {
          try {
            context.unregisterReceiver(it)
          } catch (ignored: Exception) {
          }
        }
        receiver = null
      }
      promise.resolve(
        mapOf(
          "started" to started,
          "updated" to updated,
          "permission" to "granted",
          "locationEnabled" to locationEnabled,
          "wifiEnabled" to wifiEnabled,
          "elapsedMs" to (SystemClock.elapsedRealtime() - startMs).toInt(),
          "results" to results,
          "error" to err
        )
      )
    }

    try {
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
          val updated = intent?.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false) ?: false
          finish(updated, null)
        }
      }
      ContextCompat.registerReceiver(
        context,
        r,
        IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION),
        ContextCompat.RECEIVER_EXPORTED
      )
      receiver = r
      @Suppress("DEPRECATION")
      val accepted = wifiManager.startScan()
      started = accepted
      if (!started) {
        // Throttled or Wi-Fi scanning unavailable: return the cached results now.
        finish(false, null)
        return
      }
      val t = Runnable { finish(false, null) }
      timeout = t
      handler.postDelayed(t, timeoutMs.coerceIn(500, 30000).toLong())
    } catch (e: SecurityException) {
      finish(false, "SecurityException: " + (e.message ?: ""))
    } catch (e: Exception) {
      finish(false, e.javaClass.simpleName + ": " + (e.message ?: ""))
    }
  }

  private fun readResults(wifiManager: WifiManager): List<Map<String, Any?>> {
    val nowMs = SystemClock.elapsedRealtime()
    val list: List<ScanResult> = wifiManager.scanResults ?: emptyList()
    return list.mapNotNull { result ->
      val bssid: String? = result.BSSID
      if (bssid == null) {
        null
      } else {
        @Suppress("DEPRECATION")
        val rtt: Boolean? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) result.is80211mcResponder() else null
        mapOf(
          "bssid" to bssid,
          "rssiDbm" to result.level,
          "frequencyMhz" to result.frequency,
          "rttResponder" to rtt,
          // ScanResult.timestamp is microseconds since boot.
          "ageMs" to (nowMs - result.timestamp / 1000L)
        )
      }
    }
  }
}
