// Locus Demo Bank: a small app that uses the Android SDK the way a bank app would.
// For bank developers and QA, and for field tests of arrivals, floors and offers.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.locus.demobank"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.locus.demobank"
        minSdk = 24
        targetSdk = 35
        versionCode = (System.getenv("DEMO_VERSION_CODE") ?: "1").toInt()
        versionName = "0.1.0"
        // Optional defaults baked in at build time (the app also lets you type them in).
        buildConfigField("String", "DEFAULT_API_URL", "\"${System.getenv("LOCUS_API_URL") ?: ""}\"")
        buildConfigField("String", "DEFAULT_PUBLISHABLE_KEY", "\"${System.getenv("LOCUS_DEMO_PUBLISHABLE_KEY") ?: ""}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":locus-sdk"))
    implementation("androidx.core:core:1.13.1")
}
