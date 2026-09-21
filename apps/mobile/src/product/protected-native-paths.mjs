/**
 * PROTECTED NATIVE CAPTURE ENGINE REGISTER.
 *
 * Extracted from the deleted `native-surface-contract.ts`. That file mixed a
 * legitimate PLATFORM concern — "these native capture sources must not be
 * deleted as collateral by UI work" — with an illegitimate PRODUCT one — a
 * hand-authored table deciding which Web surfaces Native would implement. The
 * product half is now derived (`tools/derive-product-manifest.mjs`); this is
 * the platform half, kept because it protects code that is proven to work:
 * ReplayKit recorded real segments on device, and MediaProjection is intact.
 *
 * Paths are relative to `apps/mobile`. A proven functional defect requiring a
 * change to one of these is a deliberate, reviewed act — not collateral.
 */
export const PROTECTED_NATIVE_PATHS = [
  // JS boundary (the ONLY sanctioned way screens touch native)
  "modules/proovra-screen-capture/index.ts",
  "modules/proovra-screen-capture/expo-module.config.json",
  // Android MediaProjection engine
  "modules/proovra-screen-capture/android/build.gradle",
  "modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ProovraScreenCaptureModule.kt",
  // iOS ReplayKit module + App Group shared contract
  "modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift",
  "modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift",
  "modules/proovra-screen-capture/ios/ProovraScreenCapture.podspec",
  // iOS Broadcast Upload Extension (config plugin + extension sources)
  "plugins/withProovraIosScreenBroadcast.cjs",
  "plugins/broadcast-extension/SampleHandler.swift",
  "plugins/broadcast-extension/Info.plist",
  "plugins/broadcast-extension/ProovraBroadcast.entitlements",
  // Canonical pure flow reducers + sealing clients (custody/integrity authority)
  "src/screen-capture-flow.ts",
  "src/continuous-capture-flow.ts",
  "src/screen-capture.ts",
  "src/continuous-capture.ts",
  "src/direct-capture.ts",
];
