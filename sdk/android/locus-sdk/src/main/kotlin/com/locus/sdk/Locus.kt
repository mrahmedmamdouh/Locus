package com.locus.sdk

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.locus.core.BaselineStatus
import com.locus.core.EngineConfig
import com.locus.core.EngineInput
import com.locus.core.EngineOutput
import com.locus.core.VisitEngine
import org.json.JSONObject
import java.util.concurrent.Executor

/** Settings for [Locus.configure]. */
data class LocusOptions(
    /** The Locus API (your deployment). */
    val apiBaseUrl: String,
    /** Malls to monitor at once, nearest first (Android allows 100 geofences per app). */
    val maxMonitoredMalls: Int = 30,
    /**
     * Keep reading the barometer while the app is in the background inside a mall. Off by default:
     * in the background the SDK still detects arrival, takes the baseline and reports the entrance floor.
     * Background sensor use needs a foreground service on recent Android versions, which your app provides.
     */
    val backgroundFloorTracking: Boolean = false,
    /** Post a notification for the offer the API says to show (when the listener does not decline it). */
    val postLocalNotifications: Boolean = false,
) {
    internal fun toJson(): JSONObject = JSONObject()
        .put("apiBaseUrl", apiBaseUrl).put("maxMonitoredMalls", maxMonitoredMalls)
        .put("backgroundFloorTracking", backgroundFloorTracking).put("postLocalNotifications", postLocalNotifications)

    internal companion object {
        fun fromJson(o: JSONObject) = LocusOptions(
            apiBaseUrl = o.getString("apiBaseUrl"),
            maxMonitoredMalls = o.optInt("maxMonitoredMalls", 30),
            backgroundFloorTracking = o.optBoolean("backgroundFloorTracking", false),
            postLocalNotifications = o.optBoolean("postLocalNotifications", false),
        )
    }
}

/** Callbacks on the main thread. All methods are optional. */
interface LocusListener {
    fun onArrived(mall: LocusMall) {}

    /** The floor changed (or became known). `place.floor` is null for a mall-level visit. */
    fun onPlaceChanged(place: LocusPlace) {}
    fun onLeft(mall: LocusMall) {}

    /** The API picked this offer to show now. Return false to skip it (it is then not counted as delivered). */
    fun shouldPresent(offer: LocusOffer, place: LocusPlace): Boolean = true
    fun onError(error: Throwable) {}
}

/**
 * The Locus SDK. Call from the main thread.
 *
 * Your app asks for location permission (including background location for arrivals while the app is
 * closed); the SDK never prompts. Call [configure] in `Application.onCreate` and [start] once permission
 * is granted. Mall arrivals wake the app through [LocusGeofenceReceiver] even when it is not running.
 */
object Locus {
    private const val REGION_PREFIX = "locus."
    private const val CHANNEL_ID = "locus_offers"

    var listener: LocusListener? = null

    /** Where the shopper is now, or null when not inside a pilot mall. */
    var currentPlace: LocusPlace? = null
        private set

    val isRunning: Boolean get() = store?.running == true

    private val main = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { main.post(it) }
    private var appContext: Context? = null
    private var store: Store? = null
    private var api: ApiClient? = null
    private var options: LocusOptions? = null
    private var engine = VisitEngine(emptyList())
    private var malls: Map<String, LocusMall> = emptyMap()
    private var barometer: Barometer? = null
    private var captureUntilMs = 0L
    private var inForeground = false
    private var flushing = false
    private var lifecycleHooked = false

    /** The random id this install reports with (no personal data). */
    val installId: String? get() = store?.installId

    fun configure(context: Context, publishableKey: String, options: LocusOptions) {
        val ctx = context.applicationContext
        val s = Store(ctx)
        s.publishableKey = publishableKey
        s.apiBaseUrl = options.apiBaseUrl
        s.options = options
        setUp(ctx, s, publishableKey, options)
    }

    /** Starts mall monitoring. Safe to call on every launch. Needs location permission. */
    fun start() {
        val s = store
        if (s == null) {
            listener?.onError(LocusError.NotConfigured)
            return
        }
        s.running = true
        registerGeofences()
        checkWhereWeAre()
        refreshMallsIfNeeded(force = s.malls.isEmpty())
        updateBarometer()
        flush()
    }

    /** Stops monitoring and forgets the current visit. Unsent events are kept. */
    fun stop() {
        val ctx = appContext ?: return
        store?.running = false
        LocationServices.getGeofencingClient(ctx).removeGeofences(geofenceIntent(ctx))
        barometer?.stop()
        engine.restore(null)
        store?.snapshot = null
        currentPlace = null
    }

    /** Removes everything the SDK stored on the device, including the install id. */
    fun reset() {
        stop()
        store?.clearAll()
    }

    fun offersHere(done: (Result<LocusOffersResponse>) -> Unit) {
        val a = api
        val p = currentPlace
        val s = store
        if (a == null || p == null || s == null) return done(Result.failure(LocusError.NotConfigured))
        a.offers(query(s, p), done)
    }

    /**
     * The bank's own pseudonymous reference for the signed-in customer (never a national ID, card or
     * account number). Needed for webhook delivery and for matching card purchases. Null when signed out.
     */
    fun setCustomerRef(ref: String?) {
        store?.customerRef = ref
    }

    /** Segment tags for offer eligibility, e.g. listOf("visa-infinite", "salary"). */
    fun setSegments(segments: List<String>) {
        store?.segments = segments
    }

    /** Offer language: "ar" or "en". Null (default) follows the phone's language. */
    var language: String? = null

    private fun resolvedLanguage(): String {
        language?.let { return if (it == "ar") "ar" else "en" }
        return if (java.util.Locale.getDefault().language == "ar") "ar" else "en"
    }

    private fun query(s: Store, p: LocusPlace) =
        ApiClient.OffersQuery(s.installId, p.mall.id, p.floor?.index, s.customerRef, s.segments, resolvedLanguage())

    fun recordOfferOpened(offer: LocusOffer) = recordOffer("offer_opened", offer)
    fun recordOfferDismissed(offer: LocusOffer) = recordOffer("offer_dismissed", offer)

    // -------------------------------------------------------------------------------------------
    // Set-up (also from a background wake-up, before the app's own code ran)
    // -------------------------------------------------------------------------------------------

    private fun setUp(ctx: Context, s: Store, key: String, opts: LocusOptions) {
        appContext = ctx
        store = s
        options = opts
        api = ApiClient(opts.apiBaseUrl, key, callback = mainExecutor)
        barometer = barometer ?: Barometer(ctx) { t, hPa -> onPressure(t, hPa) }
        engine = VisitEngine(emptyList(), EngineConfig())
        setMalls(s.malls)
        engine.restore(s.snapshot)
        refreshPlace()
        if (!lifecycleHooked) {
            lifecycleHooked = true
            main.post {
                ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) {
                        inForeground = true
                        if (isRunning) {
                            updateBarometer()
                            refreshMallsIfNeeded()
                            flush()
                        }
                    }

                    override fun onStop(owner: LifecycleOwner) {
                        inForeground = false
                        store?.snapshot = engine.snapshot()
                        updateBarometer()
                        flush()
                    }
                })
            }
        }
    }

    /** Configures from saved settings when woken in the background. Returns false if never configured. */
    private fun ensureConfigured(ctx: Context): Boolean {
        if (store != null) return true
        val s = Store(ctx)
        val key = s.publishableKey ?: return false
        val opts = s.options ?: return false
        setUp(ctx, s, key, opts)
        return true
    }

    internal fun restoreAfterBoot(ctx: Context) {
        if (!ensureConfigured(ctx) || store?.running != true) return
        registerGeofences()
    }

    // -------------------------------------------------------------------------------------------
    // Malls and geofences
    // -------------------------------------------------------------------------------------------

    private fun setMalls(list: List<LocusMall>) {
        malls = list.associateBy { it.id }
        engine.setVenues(list.map { it.engineVenue })
    }

    private fun hasLocationPermission(ctx: Context) =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    private fun lastLocation(done: (Location?) -> Unit) {
        val ctx = appContext ?: return done(null)
        if (!hasLocationPermission(ctx) && ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return done(null)
        try {
            LocationServices.getFusedLocationProviderClient(ctx).lastLocation
                .addOnSuccessListener { done(it) }
                .addOnFailureListener { done(null) }
        } catch (e: SecurityException) {
            done(null)
        }
    }

    private fun refreshMallsIfNeeded(force: Boolean = false) {
        val s = store ?: return
        val a = api ?: return
        if (!force && System.currentTimeMillis() - s.mallsFetchedAt < 86_400_000) return
        lastLocation { loc ->
            a.malls(loc?.latitude, loc?.longitude, (options?.maxMonitoredMalls ?: 30).coerceIn(1, 100)) { r ->
                r.onSuccess { list ->
                    s.malls = list
                    setMalls(list)
                    if (isRunning) {
                        registerGeofences()
                        checkWhereWeAre()
                    }
                }.onFailure { listener?.onError(it) }
            }
        }
    }

    private fun geofenceIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx, LocusGeofenceReceiver::class.java)
        // Geofencing needs a mutable PendingIntent (Play services fills in the event).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, 4711, intent, flags)
    }

    @SuppressLint("MissingPermission")
    private fun registerGeofences() {
        val ctx = appContext ?: return
        if (!hasLocationPermission(ctx) || malls.isEmpty()) return
        val fences = malls.values.take(100).map {
            Geofence.Builder()
                .setRequestId(REGION_PREFIX + it.id)
                .setCircularRegion(it.boundary.lat, it.boundary.lon, it.boundary.radiusM.toFloat())
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                .build()
        }
        // No initial trigger: "already inside" is decided by checkWhereWeAre() as a non-crossing.
        val request = GeofencingRequest.Builder().setInitialTrigger(0).addGeofences(fences).build()
        val client = LocationServices.getGeofencingClient(ctx)
        val pi = geofenceIntent(ctx)
        try {
            client.removeGeofences(pi).addOnCompleteListener {
                client.addGeofences(request, pi).addOnFailureListener { e -> listener?.onError(e) }
            }
        } catch (e: SecurityException) {
            listener?.onError(e)
        }
    }

    /** At start: a phone already inside a mall is a mall-level visit (it may be upstairs). */
    private fun checkWhereWeAre() {
        lastLocation { loc ->
            if (loc == null || System.currentTimeMillis() - loc.time > 120_000) return@lastLocation
            val acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null
            val current = engine.currentVenueId
            for (m in malls.values) {
                val d = FloatArray(1)
                Location.distanceBetween(loc.latitude, loc.longitude, m.boundary.lat, m.boundary.lon, d)
                val inside = d[0] <= m.boundary.radiusM
                if (inside && current != m.id) {
                    feed(EngineInput.Enter(System.currentTimeMillis(), m.id, acc, crossing = false))
                    return@lastLocation
                }
                if (!inside && current == m.id && d[0] > m.boundary.radiusM + (acc ?: 0.0)) {
                    feed(EngineInput.Exit(System.currentTimeMillis(), m.id))
                }
            }
        }
    }

    internal fun onGeofence(ctx: Context, requestIds: List<String>, entered: Boolean, accuracyM: Double?, done: () -> Unit) {
        if (!ensureConfigured(ctx) || store?.running != true) return done()
        val now = System.currentTimeMillis()
        for (rid in requestIds) {
            if (!rid.startsWith(REGION_PREFIX)) continue
            val id = rid.removePrefix(REGION_PREFIX)
            feed(if (entered) EngineInput.Enter(now, id, accuracyM, crossing = true) else EngineInput.Exit(now, id))
        }
        // Give the baseline capture time to finish before the broadcast ends (goAsync allows ~10 s).
        val wait = if (entered) EngineConfig().captureMs + 2_000 else 0L
        main.postDelayed({
            updateBarometer()
            flush()
            done()
        }, wait)
    }

    // -------------------------------------------------------------------------------------------
    // Engine
    // -------------------------------------------------------------------------------------------

    private fun onPressure(tMs: Long, hPa: Double) {
        feed(EngineInput.Pressure(tMs, hPa))
        if (captureUntilMs != 0L && tMs > captureUntilMs) {
            captureUntilMs = 0
            updateBarometer()
        }
    }

    private fun feed(input: EngineInput) {
        val outputs = engine.handle(input)
        if (outputs.isEmpty()) return
        store?.snapshot = engine.snapshot()
        outputs.forEach(::handle)
    }

    private fun handle(o: EngineOutput) {
        when (o) {
            is EngineOutput.Arrived -> {
                val mall = malls[o.venueId] ?: return
                refreshPlace()
                if (!o.resumed) {
                    enqueue(LocusEvent("arrived", o.venueId))
                    listener?.onArrived(mall)
                    captureUntilMs = System.currentTimeMillis() + EngineConfig().captureMs + 2_000
                    updateBarometer()
                    if (barometer?.available != true) fetchOffers()
                }
            }
            is EngineOutput.Baseline -> if (o.status == BaselineStatus.UNAVAILABLE) fetchOffers()
            is EngineOutput.FloorChanged -> {
                refreshPlace()
                enqueue(LocusEvent("floor", o.venueId, o.floorIndex))
                currentPlace?.let { listener?.onPlaceChanged(it) }
                fetchOffers()
            }
            is EngineOutput.Left -> {
                enqueue(LocusEvent("left", o.venueId))
                refreshPlace()
                malls[o.venueId]?.let { listener?.onLeft(it) }
                updateBarometer()
                flush()
            }
            is EngineOutput.Ignored -> Unit
        }
    }

    private fun refreshPlace() {
        val id = engine.currentVenueId
        val mall = id?.let { malls[it] }
        currentPlace = mall?.let { LocusPlace(it, it.floor(engine.currentFloorIndex)) }
    }

    /** Barometer on while inside a mall and (app in foreground, capture running, or background tracking on). */
    private fun updateBarometer() {
        val b = barometer ?: return
        val inside = engine.currentVenueId != null
        val capturing = captureUntilMs != 0L && System.currentTimeMillis() <= captureUntilMs
        if (inside && (inForeground || capturing || options?.backgroundFloorTracking == true)) b.start() else b.stop()
    }

    // -------------------------------------------------------------------------------------------
    // Offers and events
    // -------------------------------------------------------------------------------------------

    private fun fetchOffers() {
        val a = api ?: return
        val s = store ?: return
        val place = currentPlace ?: return
        a.offers(query(s, place)) { r ->
            r.onSuccess { resp ->
                val now = currentPlace ?: return@onSuccess
                val offer = resp.push ?: return@onSuccess
                if (now.mall.id != resp.mallId || now.floor?.index != resp.floorIndex) return@onSuccess
                // Webhook delivery: the bank's server pushes it and Locus already counted it as delivered.
                if (resp.delivery == "webhook") return@onSuccess
                val show = listener?.shouldPresent(offer, now) ?: (options?.postLocalNotifications == true)
                if (!show) return@onSuccess
                enqueue(LocusEvent("offer_delivered", now.mall.id, now.floor?.index, offer.id))
                if (options?.postLocalNotifications == true) postNotification(offer, now)
                flush()
            }.onFailure { listener?.onError(it) }
        }
    }

    @SuppressLint("MissingPermission")
    private fun postNotification(offer: LocusOffer, place: LocusPlace) {
        val ctx = appContext ?: return
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26) {
            val sys = ctx.getSystemService(NotificationManager::class.java)
            if (sys.getNotificationChannel(CHANNEL_ID) == null) sys.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Offers nearby", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply { putExtra("locusOfferId", offer.id) }
        val pi = launch?.let { PendingIntent.getActivity(ctx, offer.id.hashCode(), it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        val text = offer.body.ifEmpty { offer.storeName?.let { "$it, ${place.mall.name}" } ?: place.mall.name }
        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(offer.title)
            .setContentText(text)
            .setAutoCancel(true)
            .apply { pi?.let { setContentIntent(it) } }
            .build()
        try {
            nm.notify("locus-${offer.id}".hashCode(), n)
        } catch (e: SecurityException) {
            listener?.onError(e)
        }
    }

    private fun recordOffer(type: String, offer: LocusOffer) {
        val place = currentPlace ?: return
        enqueue(LocusEvent(type, place.mall.id, place.floor?.index, offer.id))
        flush()
    }

    private fun enqueue(e: LocusEvent) {
        val s = store ?: return
        s.queue = s.queue + e
        if (s.queue.size >= 20) flush()
    }

    private fun flush() {
        val a = api ?: return
        val s = store ?: return
        if (flushing) return
        val batch = s.queue.take(50)
        if (batch.isEmpty()) return
        flushing = true
        a.sendEvents(batch, s.installId) { r ->
            flushing = false
            r.onSuccess {
                s.queue = s.queue.drop(batch.size)
                if (s.queue.isNotEmpty()) flush()
            }.onFailure { e ->
                // A 400 can never be accepted; drop that batch rather than retry forever.
                if (e is LocusError.Http && e.status == 400) s.queue = s.queue.drop(batch.size)
                listener?.onError(e)
            }
        }
    }
}
