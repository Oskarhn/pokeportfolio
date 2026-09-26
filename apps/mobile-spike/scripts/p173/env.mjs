// Imported FIRST by the P173 drivers: ES module imports run in order, and scripts/android-adb.mjs
// reads SPIKE_PACKAGE when it is evaluated. This session's build is installed under its own
// application id (see build-apk.mjs), never the shared default.
process.env.SPIKE_PACKAGE ??= 'invalid.pokeportfolio.spike.p173'
