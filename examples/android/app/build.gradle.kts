plugins {
    id("com.android.application")
}

android {
    namespace = "app.rapier.jxlexample"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.rapier.jxlexample"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/encoder-assets"))
}

val prepareEncoderAssets by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "prepare-assets.mjs")
}
tasks.named("preBuild").configure { dependsOn(prepareEncoderAssets) }

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    testImplementation("junit:junit:4.13.2")
}
