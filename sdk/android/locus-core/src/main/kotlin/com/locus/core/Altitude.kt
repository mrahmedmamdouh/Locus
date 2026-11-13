package com.locus.core

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln

// Port of packages/altitude-core/src/{pressure,floors,smoothing}.ts. Keep the arithmetic in the
// same order as the TypeScript reference so the shared vectors match.

/** Specific gas constant for dry air, J/(kg·K). */
const val R_DRY_AIR = 287.053

/** Standard gravity, m/s². */
const val G0 = 9.80665

/** One floor of a mall as a vertical band, metres relative to height 0 of the floor table. */
data class Floor(val label: String, val index: Int, val zMinM: Double, val zMaxM: Double) {
    val centerM: Double get() = (zMinM + zMaxM) / 2
}

/** Height of [pressureHpa] above the point where [baselinePressureHpa] was measured (hypsometric equation). */
fun relativeAltitude(pressureHpa: Double, baselinePressureHpa: Double, temperatureC: Double): Double {
    val tK = temperatureC + 273.15
    return ((R_DRY_AIR * tK) / G0) * ln(baselinePressureHpa / pressureHpa)
}

/** Pressure at height 0 of the floor table, from the pressure measured at height [heightM]. */
fun pressureAtTableZero(entrancePressureHpa: Double, heightM: Double, temperatureC: Double): Double {
    val scale = (R_DRY_AIR * (temperatureC + 273.15)) / G0
    return entrancePressureHpa * exp(heightM / scale)
}

fun median(values: List<Double>): Double? {
    val v = values.filter { it.isFinite() }.sorted()
    if (v.isEmpty()) return null
    val mid = v.size / 2
    return if (v.size % 2 == 1) v[mid] else (v[mid - 1] + v[mid]) / 2
}

/**
 * The floor whose band contains the height; in a gap, the nearest centre; null when more than
 * half a floor beyond the lowest or highest band.
 */
fun classifyFloor(relAltM: Double, floors: List<Floor>): Floor? {
    if (!relAltM.isFinite() || floors.isEmpty()) return null
    floors.firstOrNull { relAltM >= it.zMinM && relAltM < it.zMaxM }?.let { return it }
    var lowest = floors[0]
    var highest = floors[0]
    for (f in floors) {
        if (f.zMinM < lowest.zMinM) lowest = f
        if (f.zMaxM > highest.zMaxM) highest = f
    }
    if (relAltM >= highest.zMaxM + (highest.zMaxM - highest.zMinM) / 2) return null
    if (relAltM < lowest.zMinM - (lowest.zMaxM - lowest.zMinM) / 2) return null
    var best: Floor? = null
    var bestDist = Double.POSITIVE_INFINITY
    for (f in floors) {
        val d = abs(relAltM - f.centerM)
        if (d < bestDist) {
            bestDist = d
            best = f
        }
    }
    return best
}
