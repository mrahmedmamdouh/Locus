package com.locus.sdk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/** Receives mall boundary crossings from Google Play services, also while the app is closed. */
class LocusGeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) return
        val transition = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> true
            Geofence.GEOFENCE_TRANSITION_EXIT -> false
            else -> return
        }
        val ids = event.triggeringGeofences?.map { it.requestId } ?: return
        val accuracy = event.triggeringLocation?.takeIf { it.hasAccuracy() }?.accuracy?.toDouble()
        // Keep the process alive for the baseline capture (a few seconds).
        val pending = goAsync()
        Locus.onGeofence(context.applicationContext, ids, entered = transition, accuracyM = accuracy) { pending.finish() }
    }
}

/** Geofences are cleared on reboot and app update; register them again if the SDK was running. */
class LocusBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Locus.restoreAfterBoot(context.applicationContext)
    }
}
