// Imported FIRST by the P184 drivers (scripts/android-adb.mjs reads these when it is evaluated):
// this phase's build is installed under its own application id, on its own emulator.
process.env.SPIKE_PACKAGE ??= 'invalid.pokeportfolio.spike.p184'
process.env.ANDROID_SERIAL ??= 'emulator-5556'
