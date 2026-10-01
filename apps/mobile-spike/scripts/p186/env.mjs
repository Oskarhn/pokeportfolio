// Imported FIRST by the P186 drivers (scripts/android-adb.mjs reads these when it is evaluated).
// P186 reuses the P185 drivers under its own application id, emulator, stack, proxy port and
// evidence directory so it never touches another phase's stack or device.
process.env.SPIKE_PACKAGE ??= 'invalid.pokeportfolio.spike.p186'
process.env.ANDROID_SERIAL ??= 'emulator-5560'
process.env.ANDROID_AVD_NAME ??= 'p186_api36'
process.env.P185_STACK ??= 'p186'
process.env.P185_PROXY_PORT ??= '55841'
process.env.P185_API_PORT ??= '55971'
process.env.P185_DB_CONTAINER ??= 'supabase_db_pokeportfolio-p186-app'
process.env.P185_EVIDENCE_DIR ??= 'p186-evidence'
