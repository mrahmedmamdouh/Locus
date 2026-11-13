package com.locus.sdk

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.Executor
import java.util.concurrent.Executors

sealed class LocusError(message: String) : Exception(message) {
    object NotConfigured : LocusError("Locus is not configured. Call Locus.configure first.")
    class Http(val status: Int, val code: String?, message: String?) : LocusError("HTTP $status ${code ?: ""} ${message ?: ""}".trim())
    class Transport(message: String) : LocusError(message)
    class Decoding(message: String) : LocusError(message)
}

/** Thin client for the Locus SDK routes. Work runs on [io]; callbacks run on [callback]. */
class ApiClient(
    baseUrl: String,
    private val key: String,
    private val io: Executor = Executors.newSingleThreadExecutor(),
    private val callback: Executor,
) {
    private val base = baseUrl.trimEnd('/')

    private fun <T> request(method: String, path: String, body: JSONObject?, parse: (String) -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val result: Result<T> = try {
                val conn = URL("$base/$path").openConnection() as HttpURLConnection
                conn.requestMethod = method
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                conn.setRequestProperty("Authorization", "Bearer $key")
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                }
                val status = conn.responseCode
                val text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                conn.disconnect()
                if (status !in 200..299) {
                    val err = runCatching { JSONObject(text).getJSONObject("error") }.getOrNull()
                    Result.failure(LocusError.Http(status, err?.optStringOrNull("code"), err?.optStringOrNull("message")))
                } else {
                    try {
                        Result.success(parse(text))
                    } catch (e: Exception) {
                        Result.failure(LocusError.Decoding(e.message ?: "bad JSON"))
                    }
                }
            } catch (e: IOException) {
                Result.failure(LocusError.Transport(e.message ?: "network error"))
            }
            callback.execute { done(result) }
        }
    }

    /** Pilot malls, nearest first. Only a rough position is sent (2 decimals ≈ 1 km). */
    fun malls(lat: Double?, lon: Double?, limit: Int, done: (Result<List<LocusMall>>) -> Unit) {
        var q = "limit=$limit"
        if (lat != null && lon != null) {
            q += "&lat=" + URLEncoder.encode(String.format(Locale.US, "%.2f", lat), "UTF-8")
            q += "&lon=" + URLEncoder.encode(String.format(Locale.US, "%.2f", lon), "UTF-8")
        }
        request("GET", "v1/sdk/malls?$q", null, { text ->
            val arr = JSONObject(text).getJSONArray("malls")
            (0 until arr.length()).map { LocusMall.fromJson(arr.getJSONObject(it)) }
        }, done)
    }

    fun offers(installId: String, mallId: String, floorIndex: Int?, done: (Result<LocusOffersResponse>) -> Unit) {
        val body = JSONObject().put("installId", installId).put("mallId", mallId).put("floorIndex", floorIndex ?: JSONObject.NULL)
        request("POST", "v1/sdk/offers", body, { LocusOffersResponse.fromJson(JSONObject(it)) }, done)
    }

    fun sendEvents(events: List<LocusEvent>, installId: String, done: (Result<Unit>) -> Unit) {
        val body = JSONObject().put("installId", installId).put("platform", "android").put("events", JSONArray(events.map { it.toJson() }))
        request("POST", "v1/sdk/events", body, { }, done)
    }
}
