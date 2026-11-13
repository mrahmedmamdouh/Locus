package com.locus.demobank

import android.app.Application
import android.content.Context
import com.locus.sdk.Locus
import com.locus.sdk.LocusListener
import com.locus.sdk.LocusMall
import com.locus.sdk.LocusOffer
import com.locus.sdk.LocusOptions
import com.locus.sdk.LocusPlace
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Configures Locus at process start, because mall arrivals can start the app in the background. */
class DemoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Demo.apply(this)
    }
}

/** The demo's settings and event log (kept in SharedPreferences so background events show up later). */
object Demo {
    const val POLICY_VERSION = "demo-mall-offers-2026-11"

    const val CONSENT_EN =
        "Mall offers: when you visit a partner mall, Demo Bank shows you card offers from shops near you, " +
            "including on your floor. To do this, the app detects when you arrive at partner malls, even when it is closed. " +
            "Your location history never leaves your phone. You can turn this off at any time."

    const val CONSENT_AR =
        "عروض المراكز التجارية: عند زيارتك لمركز تجاري شريك، يعرض لك بنك العرض عروض البطاقات من المتاجر القريبة منك، " +
            "بما في ذلك الطابق الذي أنت فيه. لذلك يكتشف التطبيق وصولك إلى المراكز الشريكة حتى عندما يكون مغلقاً. " +
            "لا يغادر سجل مواقعك هاتفك. يمكنك إيقاف ذلك في أي وقت."

    private const val PREFS = "demo"
    private const val MAX_LOG = 100
    var onLog: (() -> Unit)? = null

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun get(ctx: Context, key: String, default: String = ""): String = prefs(ctx).getString(key, default) ?: default

    fun put(ctx: Context, values: Map<String, String>) {
        val e = prefs(ctx).edit()
        values.forEach { (k, v) -> e.putString(k, v) }
        e.apply()
    }

    fun apiUrl(ctx: Context) = get(ctx, "apiUrl", BuildConfig.DEFAULT_API_URL)
    fun publishableKey(ctx: Context) = get(ctx, "publishableKey", BuildConfig.DEFAULT_PUBLISHABLE_KEY)
    fun arabic(ctx: Context) = get(ctx, "language", if (Locale.getDefault().language == "ar") "ar" else "en") == "ar"

    /** Configures the SDK from the saved settings. Returns false until the API address and key are set. */
    fun apply(ctx: Context): Boolean {
        val url = apiUrl(ctx).trim()
        val key = publishableKey(ctx).trim()
        if (url.isEmpty() || !key.startsWith("lk_pub_")) return false
        Locus.configure(ctx, key, LocusOptions(apiBaseUrl = url, postLocalNotifications = true))
        Locus.listener = listener(ctx.applicationContext)
        Locus.setCustomerRef(get(ctx, "customerRef").trim().ifEmpty { null })
        Locus.setSegments(get(ctx, "segments").split(',', ' ').map { it.trim().lowercase() }.filter { it.isNotEmpty() })
        Locus.language = if (arabic(ctx)) "ar" else "en"
        return true
    }

    fun log(ctx: Context, line: String) {
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val lines = (listOf("$stamp  $line") + logLines(ctx)).take(MAX_LOG)
        prefs(ctx).edit().putString("log", lines.joinToString("\n")).apply()
        onLog?.invoke()
    }

    fun logLines(ctx: Context): List<String> = get(ctx, "log").split("\n").filter { it.isNotEmpty() }

    fun clearLog(ctx: Context) {
        prefs(ctx).edit().remove("log").apply()
        onLog?.invoke()
    }

    private fun listener(ctx: Context) = object : LocusListener {
        override fun onArrived(mall: LocusMall) = log(ctx, "Arrived at ${mall.name}")

        override fun onPlaceChanged(place: LocusPlace) =
            log(ctx, "Floor: ${place.floor?.label ?: "unknown (mall-level)"} in ${place.mall.name}")

        override fun onLeft(mall: LocusMall) = log(ctx, "Left ${mall.name}")

        override fun shouldPresent(offer: LocusOffer, place: LocusPlace): Boolean {
            log(ctx, "Offer shown: ${offer.title}${offer.storeName?.let { " ($it)" } ?: ""}")
            return true
        }

        override fun onError(error: Throwable) = log(ctx, "Error: ${error.message}")
    }
}
