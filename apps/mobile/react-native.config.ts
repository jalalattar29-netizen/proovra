/**
 * React Native autolinking config, consumed by expo-modules-autolinking's
 * `react-native-config` command (Android RN PackageList generation).
 *
 * Why `.ts` and not `.js`/`.cjs`:
 *  - expo-modules-autolinking's loadConfigAsync loads ONLY `react-native.config.js`
 *    or `react-native.config.ts` (never `.cjs`), so a `.cjs` override is silently
 *    ignored and Android autolinking derives the WRONG import
 *    `expo.core.ExpoModulesPackage` (from the expo Android module namespace
 *    `expo.core`) instead of the real class `expo.modules.ExpoModulesPackage`.
 *  - This package is `"type": "module"`, so a CJS `react-native.config.js` crashes
 *    iOS RN codegen, which does a native `require()` of it ("module is not
 *    defined"). A `.ts` is transpiled + evaluated by expo-modules-autolinking via
 *    require-from-string (CJS-safe) and is NOT native-required by iOS codegen
 *    (which looks for `.js`), so it satisfies both toolchains.
 *
 * Pins the `expo` dependency's Android package so the generated PackageList uses
 * the correct SDK-52 class.
 */
export default {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: "import expo.modules.ExpoModulesPackage;",
          packageInstance: "new ExpoModulesPackage()",
        },
      },
    },
  },
};
