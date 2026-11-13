package com.locus.demobank

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.locus.sdk.Locus

/**
 * One screen, top to bottom in the order a tester needs it: settings → consent → permissions →
 * start → where am I → offers here → event log → delete my data. Built in code (no XML) so the
 * whole demo reads in one file.
 */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var logView: TextView
    private lateinit var consentText: TextView
    private lateinit var offersView: TextView

    private val accent = Color.rgb(31, 95, 139)
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(24), dp(16), dp(32))
        }
        setContentView(ScrollView(this).apply { addView(root) })

        root.addView(text("Locus Demo Bank", 24f, bold = true))
        root.addView(text("A demo of the Locus SDK in a bank app: mall arrival, floor and offers.", 14f, muted = true))

        // Status ------------------------------------------------------------------------------
        status = text("", 15f)
        root.addView(card("Now", status))

        // Settings ----------------------------------------------------------------------------
        val url = input("API address (https://…workers.dev)", Demo.apiUrl(this), InputType.TYPE_TEXT_VARIATION_URI)
        val key = input("Publishable key (lk_pub_…)", Demo.publishableKey(this))
        val ref = input("Customer reference (pseudonymous, e.g. cust-001)", Demo.get(this, "customerRef"))
        val segs = input("Segments, comma-separated (e.g. visa-infinite)", Demo.get(this, "segments"))
        val lang = button(if (Demo.arabic(this)) "Language: العربية" else "Language: English") {}
        lang.setOnClickListener {
            val ar = !Demo.arabic(this)
            Demo.put(this, mapOf("language" to if (ar) "ar" else "en"))
            lang.text = if (ar) "Language: العربية" else "Language: English"
            refreshConsentText()
        }
        val save = button("Save settings") {
            Demo.put(this, mapOf("apiUrl" to url.text.toString().trim(), "publishableKey" to key.text.toString().trim(), "customerRef" to ref.text.toString().trim(), "segments" to segs.text.toString()))
            Demo.log(this, if (Demo.apply(this)) "Settings saved" else "Settings saved, but the API address or key is missing")
            refresh()
        }
        root.addView(card("1. Settings", url, key, ref, segs, lang, save))

        // Consent -----------------------------------------------------------------------------
        consentText = text("", 14f)
        val agree = button("I agree") {
            if (!Demo.apply(this)) return@button Demo.log(this, "Save the settings first")
            Locus.setConsent(true, Demo.POLICY_VERSION, consentText.text.toString())
            Demo.log(this, "Consent: agreed (${Demo.POLICY_VERSION})")
            refresh()
        }
        val decline = button("No thanks / withdraw", primary = false) {
            if (!Demo.apply(this)) return@button Demo.log(this, "Save the settings first")
            Locus.setConsent(false, Demo.POLICY_VERSION, consentText.text.toString())
            Demo.log(this, "Consent: withdrawn; monitoring stopped")
            refresh()
        }
        root.addView(card("2. Mall offers (consent)", consentText, row(agree, decline)))

        // Permissions and start ------------------------------------------------------------------
        val loc = button("Allow location") { requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1) }
        val bg = button("Allow location all the time") {
            if (Build.VERSION.SDK_INT >= 29) requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 2)
            else Demo.log(this, "Background location is included on this Android version")
        }
        val notif = button("Allow notifications") {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
            else Demo.log(this, "Notifications are allowed by default on this Android version")
        }
        val start = button("Start mall offers") {
            if (!Demo.apply(this)) return@button Demo.log(this, "Save the settings first")
            Locus.start()
            Demo.log(this, if (Locus.isRunning) "Monitoring started" else "Not started (see the error above)")
            refresh()
        }
        val stop = button("Stop", primary = false) {
            Locus.stop()
            Demo.log(this, "Monitoring stopped")
            refresh()
        }
        root.addView(
            card(
                "3. Permissions and start",
                text("Android asks for “all the time” separately, after “while using the app”. Arrivals while the app is closed need it.", 13f, muted = true),
                loc, bg, notif, row(start, stop),
            ),
        )

        // Offers here --------------------------------------------------------------------------
        offersView = text("", 14f)
        val load = button("Show offers here") {
            Locus.offersHere { r ->
                r.onSuccess { resp ->
                    offersView.text = when {
                        resp.reason == "no-consent" -> "No consent recorded for this install yet."
                        resp.offers.isEmpty() -> "No offers here right now."
                        else -> resp.offers.joinToString("\n\n") { o ->
                            "• ${o.title}" + (if (o.body.isNotEmpty()) "\n  ${o.body}" else "") +
                                "\n  ${o.merchantName ?: ""}${o.storeName?.let { " · $it" } ?: ""}${o.floorLabel?.let { " · $it" } ?: ""}"
                        }
                    }
                }.onFailure { offersView.text = "Not inside a pilot mall (or not started)." }
            }
        }
        root.addView(card("4. Offers here", load, offersView))

        // Event log ----------------------------------------------------------------------------
        logView = text("", 12f).apply { typeface = Typeface.MONOSPACE }
        val clear = button("Clear log", primary = false) { Demo.clearLog(this) }
        root.addView(card("5. What happened", logView, clear))

        // Delete my data -----------------------------------------------------------------------
        val forget = button("Delete my mall-offer data", primary = false) {
            if (!Demo.apply(this)) return@button Demo.log(this, "Save the settings first")
            Locus.forgetMe { r ->
                Demo.log(this, if (r.isSuccess) "Data erased; this install now has a new id" else "Erase failed: ${r.exceptionOrNull()?.message}")
                refresh()
            }
        }
        root.addView(card("6. Privacy", text("Erases visits, offers and purchases held by Locus for this install. The consent trail stays as proof.", 13f, muted = true), forget))

        refreshConsentText()
    }

    override fun onResume() {
        super.onResume()
        Demo.onLog = { runOnUiThread { refresh() } }
        refresh()
    }

    override fun onPause() {
        super.onPause()
        Demo.onLog = null
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        Demo.log(this, "${permissions.joinToString { it.substringAfterLast('.') }}: ${if (granted) "allowed" else "not allowed"}")
    }

    private fun refreshConsentText() {
        val ar = Demo.arabic(this)
        consentText.text = if (ar) Demo.CONSENT_AR else Demo.CONSENT_EN
        consentText.textDirection = if (ar) View.TEXT_DIRECTION_RTL else View.TEXT_DIRECTION_LTR
        if (Demo.apply(this)) Locus.language = if (ar) "ar" else "en"
    }

    private fun refresh() {
        val place = Locus.currentPlace
        val perm = { p: String -> checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED }
        val bgOk = Build.VERSION.SDK_INT < 29 || perm(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        status.text = listOf(
            "Mall: ${place?.mall?.name ?: "not in a pilot mall"}",
            "Floor: ${place?.floor?.label ?: if (place != null) "unknown (mall-level)" else "—"}",
            "Consent: ${if (Locus.consentGranted) "agreed" else "not given"}",
            "Monitoring: ${if (Locus.isRunning) "on" else "off"}",
            "Location: ${if (perm(Manifest.permission.ACCESS_FINE_LOCATION)) "allowed" else "not allowed"}${if (bgOk) ", all the time" else ", only while using"}",
            "Install id: ${Locus.installId ?: "—"}",
        ).joinToString("\n")
        logView.text = Demo.logLines(this).joinToString("\n").ifEmpty { "Nothing yet." }
    }

    // --- tiny view helpers ------------------------------------------------------------------------

    private fun text(s: String, size: Float, bold: Boolean = false, muted: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(if (muted) Color.rgb(92, 103, 115) else Color.rgb(23, 32, 42))
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun input(hint: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint
        setText(value)
        inputType = InputType.TYPE_CLASS_TEXT or type
        isSingleLine = true
        textSize = 14f
    }

    private fun button(label: String, primary: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(if (primary) Color.WHITE else accent)
        background = GradientDrawable().apply {
            cornerRadius = dp(8).toFloat()
            if (primary) setColor(accent) else {
                setColor(Color.WHITE)
                setStroke(dp(1), accent)
            }
        }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
    }

    private fun row(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        views.forEachIndexed { i, v ->
            v.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                topMargin = dp(8)
                if (i > 0) marginStart = dp(8)
            }
            addView(v)
        }
    }

    private fun card(title: String, vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(12), dp(16), dp(16))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(Color.WHITE)
            setStroke(dp(1), Color.rgb(221, 226, 232))
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
        addView(text(title, 17f, bold = true).apply { gravity = Gravity.START })
        views.forEach { addView(it) }
    }
}
