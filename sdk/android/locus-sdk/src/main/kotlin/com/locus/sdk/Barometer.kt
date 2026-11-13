package com.locus.sdk

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper

/** The phone's pressure sensor at about 1 Hz, delivered on the main thread. */
internal class Barometer(context: Context, private val onSample: (tMs: Long, hPa: Double) -> Unit) {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? = sensors.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private var running = false

    val available: Boolean get() = sensor != null

    private val listener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val hPa = event.values.firstOrNull()?.toDouble() ?: return
            onSample(System.currentTimeMillis(), hPa)
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    fun start() {
        val s = sensor ?: return
        if (running) return
        running = sensors.registerListener(listener, s, 1_000_000, Handler(Looper.getMainLooper()))
    }

    fun stop() {
        if (!running) return
        sensors.unregisterListener(listener)
        running = false
    }
}
