/** @type {import('@react-native-community/cli-types').Config} */
module.exports = {
    dependencies: {
      expo: {
        platforms: {
          android: {
            packageImportPath: 'import expo.modules.ExpoModulesPackage;',
            packageInstance: 'new ExpoModulesPackage()',
          },
        },
      },
    },
  };