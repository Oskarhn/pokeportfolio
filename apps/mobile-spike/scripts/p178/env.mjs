// Imported FIRST by the P178 drivers: ES module imports run in order, and scripts/android-adb.mjs
// reads SPIKE_PACKAGE when it is evaluated. This session's build is installed under its own
// application id, never P173/P175's shared default, so it never shares device state with another
// session's install.
process.env.SPIKE_PACKAGE ??= 'invalid.pokeportfolio.spike.p178'
