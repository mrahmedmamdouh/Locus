package com.locus.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Replays sdk/spec/vectors/visit-engine.json (generated from the TypeScript reference) and checks
 * that the Kotlin engine produces exactly the same outputs.
 */
class VectorTest {
    private val doc: JSONObject by lazy {
        // Gradle runs tests with the module directory as the working directory.
        val f = listOf("../../spec/vectors/visit-engine.json", "../spec/vectors/visit-engine.json", "sdk/spec/vectors/visit-engine.json")
            .map(::File).first { it.exists() }
        JSONObject(f.readText())
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? = if (!has(key) || isNull(key)) null else getDouble(key)
    private fun JSONObject.optIntOrNull(key: String): Int? = if (!has(key) || isNull(key)) null else getInt(key)

    private fun venues(a: JSONArray): List<EngineVenue> = (0 until a.length()).map { i ->
        val v = a.getJSONObject(i)
        val fl = v.getJSONArray("floors")
        val b = v.getJSONObject("boundary")
        EngineVenue(
            id = v.getString("id"),
            floors = (0 until fl.length()).map { j ->
                val f = fl.getJSONObject(j)
                Floor(f.getString("label"), f.getInt("index"), f.getDouble("zMinM"), f.getDouble("zMaxM"))
            },
            entranceFloorIndex = v.optIntOrNull("entranceFloorIndex"),
            boundary = VenueBoundary(b.getDouble("lat"), b.getDouble("lon"), b.getDouble("radiusM")),
        )
    }

    private fun input(o: JSONObject): EngineInput {
        val t = o.getLong("tMs")
        return when (o.getString("type")) {
            "enter" -> EngineInput.Enter(t, o.getString("venueId"), o.optDoubleOrNull("accuracyM"), if (o.has("crossing")) o.getBoolean("crossing") else true)
            "exit" -> EngineInput.Exit(t, o.getString("venueId"))
            "pressure" -> EngineInput.Pressure(t, o.getDouble("hPa"))
            "restart" -> EngineInput.Restart(t)
            else -> error("unknown input ${o.getString("type")}")
        }
    }

    private fun describe(o: EngineOutput): String = when (o) {
        is EngineOutput.Arrived -> "arrived ${o.tMs} ${o.venueId} resumed=${o.resumed}"
        is EngineOutput.Ignored -> "ignored ${o.tMs} ${o.venueId} ${o.reason.wire}"
        is EngineOutput.Baseline -> "baseline ${o.tMs} ${o.venueId} ${o.status.wire} n=${o.sampleCount}"
        is EngineOutput.FloorChanged -> "floor ${o.tMs} ${o.venueId} ${o.floorIndex}"
        is EngineOutput.Left -> "left ${o.tMs} ${o.venueId}"
    }

    private fun describe(e: JSONObject): String {
        val t = e.getLong("tMs")
        val v = e.getString("venueId")
        return when (val type = e.getString("type")) {
            "arrived" -> "arrived $t $v resumed=${e.getBoolean("resumed")}"
            "ignored" -> "ignored $t $v ${e.getString("reason")}"
            "baseline" -> "baseline $t $v ${e.getString("status")} n=${e.getInt("sampleCount")}"
            "floor" -> "floor $t $v ${e.getInt("floorIndex")}"
            "left" -> "left $t $v"
            else -> "unknown $type"
        }
    }

    @Test
    fun configMatchesTheReference() {
        val c = doc.getJSONObject("config")
        val k = EngineConfig()
        assertEquals(c.getLong("captureMs"), k.captureMs)
        assertEquals(c.getLong("maxPendingMs"), k.maxPendingMs)
        assertEquals(c.getLong("reentryWindowMs"), k.reentryWindowMs)
        assertEquals(c.getLong("suspectWindowMs"), k.suspectWindowMs)
        assertEquals(c.getLong("floorDwellMs"), k.floorDwellMs)
        assertEquals(c.getDouble("temperatureC"), k.temperatureC)
        assertEquals(c.getDouble("driftAlpha"), k.driftAlpha)
        assertEquals(c.getLong("driftWindowMs"), k.driftWindowMs)
        assertEquals(c.getDouble("driftMaxRangeM"), k.driftMaxRangeM)
    }

    @Test
    fun allScenariosMatchTheReference() {
        assertEquals("locus-visit-engine-vectors", doc.getString("format"))
        val scenarios = doc.getJSONArray("scenarios")
        assertTrue(scenarios.length() >= 17)
        for (i in 0 until scenarios.length()) {
            val s = scenarios.getJSONObject(i)
            val name = s.getString("name")
            val engine = VisitEngine(venues(s.getJSONArray("venues")))
            val ins = s.getJSONArray("inputs")
            val got = (0 until ins.length()).flatMap { engine.handle(input(ins.getJSONObject(it))) }
            val exp = s.getJSONArray("expected")
            val want = (0 until exp.length()).map { exp.getJSONObject(it) }
            assertEquals(want.map(::describe), got.map(::describe), "scenario $name")
            got.zip(want).forEach { (g, e) ->
                if (g is EngineOutput.Baseline) {
                    val p = e.optDoubleOrNull("baselinePressureHpa")
                    if (p == null) assertNull(g.baselinePressureHpa, name) else assertEquals(p, g.baselinePressureHpa!!, 1e-6, name)
                }
            }
        }
    }

    @Test
    fun snapshotRoundTrips() {
        val scenarios = doc.getJSONArray("scenarios")
        val s = (0 until scenarios.length()).map { scenarios.getJSONObject(it) }.first { it.getString("name") == "drift-is-corrected-while-standing" }
        val vs = venues(s.getJSONArray("venues"))
        val a = VisitEngine(vs)
        val ins = s.getJSONArray("inputs")
        for (i in 0 until ins.length()) a.handle(input(ins.getJSONObject(i)))
        val b = VisitEngine(vs)
        b.restore(a.snapshot())
        assertEquals(a.snapshot(), b.snapshot())
        assertEquals(1, b.currentFloorIndex)
        assertTrue(a.snapshot()!!.driftOffsetM > 1)
    }

    @Test
    fun classifyFloorEdges() {
        val floors = listOf(Floor("G", 0, -2.875, 2.875), Floor("1", 1, 2.875, 8.625))
        assertEquals(1, classifyFloor(2.875, floors)?.index)
        assertEquals(0, classifyFloor(-5.7, floors)?.index)
        assertNull(classifyFloor(-5.8, floors))
        assertNull(classifyFloor(11.5, floors))
        assertNull(classifyFloor(Double.NaN, floors))
    }
}
