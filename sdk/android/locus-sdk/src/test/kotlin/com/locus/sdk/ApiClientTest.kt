package com.locus.sdk

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApiClientTest {
    private lateinit var server: HttpServer
    private val seen = mutableListOf<Triple<String, String, String>>() // method+uri, auth, body
    private var reply: Pair<Int, String> = 200 to "{}"

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            synchronized(seen) { seen += Triple("${ex.requestMethod} ${ex.requestURI}", ex.requestHeaders.getFirst("Authorization") ?: "", body) }
            val bytes = reply.second.toByteArray()
            ex.sendResponseHeaders(reply.first, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest
    fun tearDown() = server.stop(0)

    private fun client() = ApiClient("http://127.0.0.1:${server.address.port}/", "lk_pub_test", callback = Executor { it.run() })

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
