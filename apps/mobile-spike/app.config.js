/**
 * Expo dynamic configuration (P188). app.json stays the LOCAL base (placeholder identity, local
 * cleartext, local-network iOS keys); this file applies the build profile named by
 * EXPO_PUBLIC_BUILD_PROFILE on top of it. LOCAL_DEV and LOCAL_RELEASE_TEST return the base unchanged
 * (plus `extra.buildProfile`); PRODUCTION_RELEASE takes its identity from the build environment and
 * throws, naming the variable, when anything is missing. See config/build-profile.cjs and
 * docs/mobile/BUILD_CONFIGURATION_PROFILES.md.
 */
const { applyBuildProfile } = require('./config/build-profile.cjs')

module.exports = ({ config }) => applyBuildProfile(config, process.env)
