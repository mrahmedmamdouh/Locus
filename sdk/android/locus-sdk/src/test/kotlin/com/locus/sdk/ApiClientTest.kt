package com.locus.sdk

import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApiClientTest {
    // A tiny one-request-per-connection HTTP server (com.sun.net.httpserver is not on Android's classpath).
    private lateinit var server: ServerSocket
    private val seen = mutableListOf<Triple<String, String, String>>() // method+uri, auth, body
    @Volatile private var reply: Pair<Int, String> = 200 to "{}"

    @BeforeTest
    fun setUp() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val sock = runCatching { server.accept() }.getOrNull() ?: break
                sock.use { s ->
                    val input = s.getInputStream().bufferedReader(Charsets.UTF_8)
                    val requestLine = input.readLine() ?: return@use
                    val headers = generateSequence { input.readLine()?.takeIf { it.isNotEmpty() } }
                        .map { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }.toMap()
                    val len = headers["content-length"]?.toInt() ?: 0
                    val buf = CharArray(len)
                    var read = 0
                    while (read < len) {
                        val n = input.read(buf, read, len - read)
                        if (n < 0) break
                        read += n
                    }
                    val parts = requestLine.split(" ")
                    synchronized(seen) { seen += Triple("${parts[0]} ${parts[1]}", headers["authorization"] ?: "", String(buf, 0, read)) }
                    val (status, body) = reply
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    val out = s.getOutputStream()
                    out.write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    out.write(bytes)
                    out.flush()
                }
            }
        }
    }

    @AfterTest
    fun tearDown() = server.close()

    private fun client() = ApiClient("http://127.0.0.1:${server.localPort}/", "lk_pub_test", callback = Executor { it.run() })

    private fun <T> await(call: ((Result<T>) -> Unit) -> Unit): Result<T> {
        val latch = CountDownLatch(1)
        var out: Result<T>? = null
        call { out = it; latch.countDown() }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return out!!
    }

    @Test
    fun mallsSendsKeyAndOnlyARoughPosition() {
        reply = 200 to """{"malls":[{"id":"mall-of-oman","name":"Mall of Oman","city":"Muscat","country":"OM","status":"pilot","boundary":{"lat":23.5718,"lon":58.4045,"radiusM":400},"entranceFloorIndex":0,"floors":[{"index":0,"label":"Level 1","zMinM":-2.875,"zMaxM":2.875}],"updatedAt":"x"}],"refreshAfterSeconds":86400}"""
        val r = await<List<LocusMall>> { client().malls(23.571234, 58.404567, 15, it) }
        assertEquals("Level 1", r.getOrThrow().single().engineVenue.floors.single().label)
        assertEquals("GET /v1/sdk/malls?limit=15&lat=23.57&lon=58.40", seen.single().first)
        assertEquals("Bearer lk_pub_test", seen.single().second)
    }

    @Test
    fun offersSendsExplicitNullFloorAndParsesPush() {
        reply = 200 to """{"mallId":"mall-of-oman","floorIndex":null,"offers":[],"push":{"id":"o1","merchant":{"id":"m1","name":"Costa"},"floorIndex":null,"floorLabel":null,"storeName":null,"title":"20% off","body":"","ctaUrl":null,"endsAt":"2026-12-31T00:00:00.000Z"},"reason":"ok"}"""
        val r = await<LocusOffersResponse> { client().offers("install-0001", "mall-of-oman", null, it) }
        assertEquals("o1", r.getOrThrow().push?.id)
        val body = JSONObject(seen.single().third)
        assertTrue(body.isNull("floorIndex"))
        assertEquals("install-0001", body.getString("installId"))
    }

    @Test
    fun errorsCarryTheApiCode() {
        reply = 401 to """{"error":{"code":"unauthorized","message":"Unknown or revoked key."}}"""
        val r = await<Unit> { client().sendEvents(listOf(LocusEvent("arrived", "mall-of-oman")), "install-0001", it) }
        val e = r.exceptionOrNull() as LocusError.Http
        assertEquals(401, e.status)
        assertEquals("unauthorized", e.code)
    }

    @Test
    fun eventsNeverContainCoordinates() {
        val keys = LocusEvent("floor", "mall-of-oman", 1).toJson().keys().asSequence().toSet()
        assertEquals(setOf("type", "mallId", "floorIndex", "t"), keys)
    }

    @Test
    fun snapshotJsonRoundTrips() {
        val s = com.locus.core.VisitSnapshot("mall-of-oman", com.locus.core.VisitSnapshot.Phase.ACTIVE, 1L, null, 1014.5, 1.25, 2)
        assertEquals(s, Store.snapshotFromJson(JSONObject(Store.snapshotToJson(s).toString())))
    }
}
