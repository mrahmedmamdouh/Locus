package com.locus.sdk

import com.locus.core.EngineVenue
import com.locus.core.Floor
import com.locus.core.VenueBoundary
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** A mall from the Locus catalogue (GET /v1/sdk/malls). */
data class LocusMall(
    val id: String,
    val name: String,
    val city: String,
    val country: String,
    val boundary: VenueBoundary,
    val entranceFloorIndex: Int,
    val floors: List<FloorInfo>,
) {
    data class FloorInfo(val index: Int, val label: String, val zMinM: Double, val zMaxM: Double)

    fun floor(index: Int?): FloorInfo? = index?.let { i -> floors.firstOrNull { it.index == i } }

    internal val engineVenue: EngineVenue
        get() = EngineVenue(id, floors.map { Floor(it.label, it.index, it.zMinM, it.zMaxM) }, entranceFloorIndex, boundary)

    internal fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("city", city).put("country", country)
        .put("boundary", JSONObject().put("lat", boundary.lat).put("lon", boundary.lon).put("radiusM", boundary.radiusM))
        .put("entranceFloorIndex", entranceFloorIndex)
        .put("floors", JSONArray(floors.map { JSONObject().put("index", it.index).put("label", it.label).put("zMinM", it.zMinM).put("zMaxM", it.zMaxM) }))

    companion object {
        internal fun fromJson(o: JSONObject): LocusMall {
            val b = o.getJSONObject("boundary")
            val fl = o.getJSONArray("floors")
            return LocusMall(
                id = o.getString("id"),
                name = o.getString("name"),
                city = o.optString("city"),
                country = o.optString("country"),
                boundary = VenueBoundary(b.getDouble("lat"), b.getDouble("lon"), b.getDouble("radiusM")),
                entranceFloorIndex = o.optInt("entranceFloorIndex", 0),
                floors = (0 until fl.length()).map { i ->
                    val f = fl.getJSONObject(i)
                    FloorInfo(f.getInt("index"), f.getString("label"), f.getDouble("zMinM"), f.getDouble("zMaxM"))
                },
            )
        }
    }
}

/** Where the shopper is: a mall and, when the phone can tell, a floor (null = unknown / mall-level). */
data class LocusPlace(val mall: LocusMall, val floor: LocusMall.FloorInfo?)

/** An offer from the bank's own catalogue, ranked for this shopper by the Locus API. */
data class LocusOffer(
    val id: String,
    val merchantId: String,
    val merchantName: String?,
    val floorIndex: Int?,
    val floorLabel: String?,
    val storeName: String?,
    val title: String,
    val body: String,
    val ctaUrl: String?,
    val endsAt: String,
) {
    companion object {
        internal fun fromJson(o: JSONObject): LocusOffer {
            val m = o.getJSONObject("merchant")
            return LocusOffer(
                id = o.getString("id"),
                merchantId = m.getString("id"),
                merchantName = m.optStringOrNull("name"),
                floorIndex = o.optIntOrNull("floorIndex"),
                floorLabel = o.optStringOrNull("floorLabel"),
                storeName = o.optStringOrNull("storeName"),
                title = o.getString("title"),
                body = o.optString("body"),
                ctaUrl = o.optStringOrNull("ctaUrl"),
                endsAt = o.getString("endsAt"),
            )
        }
    }
}

data class LocusOffersResponse(val mallId: String, val floorIndex: Int?, val offers: List<LocusOffer>, val push: LocusOffer?, val reason: String) {
    companion object {
        internal fun fromJson(o: JSONObject): LocusOffersResponse {
            val list = o.getJSONArray("offers")
            return LocusOffersResponse(
                mallId = o.getString("mallId"),
                floorIndex = o.optIntOrNull("floorIndex"),
                offers = (0 until list.length()).map { LocusOffer.fromJson(list.getJSONObject(it)) },
                push = if (o.isNull("push")) null else LocusOffer.fromJson(o.getJSONObject("push")),
                reason = o.optString("reason"),
            )
        }
    }
}

/** One result the SDK reports. Never coordinates. */
data class LocusEvent(val type: String, val mallId: String, val floorIndex: Int? = null, val offerId: String? = null, val t: String = isoNow()) {
    internal fun toJson(): JSONObject = JSONObject().apply {
        put("type", type)
        put("mallId", mallId)
        floorIndex?.let { put("floorIndex", it) }
        offerId?.let { put("offerId", it) }
        put("t", t)
    }

    companion object {
        internal fun fromJson(o: JSONObject) = LocusEvent(o.getString("type"), o.getString("mallId"), o.optIntOrNull("floorIndex"), o.optStringOrNull("offerId"), o.getString("t"))

        internal fun isoNow(date: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(date)
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
internal fun JSONObject.optIntOrNull(key: String): Int? = if (!has(key) || isNull(key)) null else getInt(key)
internal fun JSONObject.optDoubleOrNull(key: String): Double? = if (!has(key) || isNull(key)) null else getDouble(key)
