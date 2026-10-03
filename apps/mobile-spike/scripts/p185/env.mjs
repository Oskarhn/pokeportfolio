// Imported FIRST by the P185 drivers (scripts/android-adb.mjs reads these when it is evaluated):
// this phase's build is installed under its own application id, on its own emulator.
process.env.SPIKE_PACKAGE ??= 'invalid.pokeportfolio.spike.p185'
process.env.ANDROID_SERIAL ??= 'emulator-5558'
// The device identity every recovery is checked against (scripts/adb-recovery.cjs).
process.env.ANDROID_AVD_NAME ??= 'p185_api36'
