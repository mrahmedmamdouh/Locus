package com.locus.sdk

import android.content.Context
import android.content.SharedPreferences
import com.locus.core.VisitSnapshot
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * What the SDK keeps on the device (SharedPreferences "com.locus.sdk"): the configuration (so a
 * background wake-up can run before the app's own code), a random install id, the mall list, the
 * visit snapshot and unsent events. No location history.
 */
internal class Store(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("com.locus.sdk", Context.MODE_PRIVATE)

    val installId: String
        get() = prefs.getString("installId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("installId", it).apply() }

    var publishableKey: String?
        get() = prefs.getString("publishableKey", null)
        set(v) = prefs.edit().putString("publishableKey", v).apply()

    var apiBaseUrl: String?
        get() = prefs.getString("apiBaseUrl", null)
        set(v) = prefs.edit().putString("apiBaseUrl", v).apply()

    var options: LocusOptions?
        get() = prefs.getString("options", null)?.let { runCatching { LocusOptions.fromJson(JSONObject(it)) }.getOrNull() }
        set(v) = prefs.edit().putString("options", v?.toJson()?.toString()).apply()

    /** The bank's pseudonymous customer reference (set by the app). */
    var customerRef: String?
        get() = prefs.getString("customerRef", null)
        set(v) = prefs.edit().putString("customerRef", v).apply()

    var segments: List<String>
        get() = prefs.getString("segments", null)?.let { s -> runCatching { JSONArray(s).let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrNull() } ?: emptyList()
        set(v) = prefs.edit().putString("segments", JSONArray(v).toString()).apply()

    var running: Boolean
        get() = prefs.getBoolean("running", false)
        set(v) = prefs.edit().putBoolean("running", v).apply()

    var malls: List<LocusMall>
        get() = prefs.getString("malls", null)?.let { s ->
            runCatching { JSONArray(s).let { a -> (0 until a.length()).map { LocusMall.fromJson(a.getJSONObject(it)) } } }.getOrNull()
        } ?: emptyList()
        set(v) = prefs.edit().putString("malls", JSONArray(v.map { it.toJson() }).toString()).putLong("mallsFetchedAt", System.currentTimeMillis()).apply()

    val mallsFetchedAt: Long get() = prefs.getLong("mallsFetchedAt", 0)

    var snapshot: VisitSnapshot?
        get() = prefs.getString("snapshot", null)?.let { runCatching { snapshotFromJson(JSONObject(it)) }.getOrNull() }
        set(v) = prefs.edit().putString("snapshot", v?.let { snapshotToJson(it).toString() }).apply()

    var queue: List<LocusEvent>
        get() = prefs.getString("queue", null)?.let { s ->
            runCatching { JSONArray(s).let { a -> (0 until a.length()).map { LocusEvent.fromJson(a.getJSONObject(it)) } } }.getOrNull()
        } ?: emptyList()
        set(v) = prefs.edit().putString("queue", JSONArray(v.takeLast(MAX_QUEUE).map { it.toJson() }).toString()).apply()

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val MAX_QUEUE = 500

        fun snapshotToJson(s: VisitSnapshot): JSONObject = JSONObject()
            .put("venueId", s.venueId)
            .put("phase", s.phase.wire)
            .put("enteredAtMs", s.enteredAtMs)
            .put("exitedAtMs", s.exitedAtMs ?: JSONObject.NULL)
            .put("baselineHpa", s.baselineHpa ?: JSONObject.NULL)
            .put("driftOffsetM", s.driftOffsetM)
            .put("emittedFloor", s.emittedFloor ?: JSONObject.NULL)

        fun snapshotFromJson(o: JSONObject) = VisitSnapshot(
            venueId = o.getString("venueId"),
            phase = VisitSnapshot.Phase.fromWire(o.getString("phase")),
            enteredAtMs = o.getLong("enteredAtMs"),
            exitedAtMs = if (o.isNull("exitedAtMs")) null else o.getLong("exitedAtMs"),
            baselineHpa = o.optDoubleOrNull("baselineHpa"),
            driftOffsetM = o.optDouble("driftOffsetM", 0.0),
            emittedFloor = o.optIntOrNull("emittedFloor"),
        )
    }
}
