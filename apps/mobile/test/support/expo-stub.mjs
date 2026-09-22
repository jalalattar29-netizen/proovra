/**
 * Stubs for the `expo-*` packages and AsyncStorage, for render tests.
 *
 * Each export keeps the shape the screens consume so their render paths run;
 * the behaviour is inert and deterministic. Anything a test needs to observe
 * (navigation, recorded calls) is captured on `calls`.
 */
import React from "react";

/** Calls made through the stubs, so a test can assert on navigation etc. */
export const calls = {
  push: [],
  replace: [],
  back: 0,
  openURL: [],
  reset() {
    calls.push = [];
    calls.replace = [];
    calls.back = 0;
    calls.openURL = [];
  },
};

/* --------------------------------------------------------------- expo-router */
export const useRouter = () => ({
  push: (r) => calls.push.push(r),
  replace: (r) => calls.replace.push(r),
  back: () => {
    calls.back += 1;
  },
  navigate: (r) => calls.push.push(r),
});
export const usePathname = () => "/";
export const useLocalSearchParams = () => globalThis.__EXPO_PARAMS__ ?? {};
export const useFocusEffect = (cb) => {
  React.useEffect(() => cb(), []);
};
export const Stack = Object.assign(({ children }) => children ?? null, {
  Screen: () => null,
});
export const Tabs = Object.assign(({ children }) => children ?? null, {
  Screen: () => null,
});
export const Link = ({ children }) => children ?? null;
export const Redirect = () => null;

/* ---------------------------------------------------------------- expo-audio */
export const RecordingPresets = { HIGH_QUALITY: {} };
export const useAudioRecorder = () => ({
  record() {},
  async stop() {},
  async prepareToRecordAsync() {},
  getStatus: () => ({ durationMillis: 0 }),
  uri: null,
  isRecording: false,
  id: "stub",
  addListener: () => ({ remove() {} }),
});
export const setAudioModeAsync = async () => {};
export const requestRecordingPermissionsAsync = async () => ({ granted: true });

/* --------------------------------------------------------------- expo-camera */
export const CameraView = ({ children }) => children ?? null;
export const useCameraPermissions = () => [{ granted: true }, async () => ({ granted: true })];
export const useMicrophonePermissions = () => [{ granted: true }, async () => ({ granted: true })];

/* ---------------------------------------------------------- expo-file-system */
export const cacheDirectory = "file:///cache/";
export const EncodingType = { Base64: "base64", UTF8: "utf8" };
export const FileSystemUploadType = { BINARY_CONTENT: 0 };
export const getInfoAsync = async () => ({ exists: true, size: 0, md5: "d41d8cd98f00b204e9800998ecf8427e" });
export const readAsStringAsync = async () => "";
export const copyAsync = async () => {};
export const uploadAsync = async () => ({ status: 200 });

/* -------------------------------------------------------------- expo-crypto */
export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
export const digest = async () => new ArrayBuffer(32);

/* ------------------------------------------------------------ expo-location */
export const Accuracy = { Balanced: 3 };
export const requestForegroundPermissionsAsync = async () => ({ status: "granted" });
export const getCurrentPositionAsync = async () => ({ coords: { latitude: 0, longitude: 0, accuracy: 1 } });

/* ------------------------------------------------------- expo-document-picker */
export const getDocumentAsync = async () => ({ canceled: true, assets: null });

/* --------------------------------------------------------------- expo-linking */
export const useURL = () => null;
export const openURL = async (url) => {
  calls.openURL.push(url);
  return true;
};

/* ------------------------------------------------- expo-apple-authentication */
export const AppleAuthenticationScope = { FULL_NAME: 0, EMAIL: 1 };
export const isAvailableAsync = async () => true;
export const signInAsync = async () => ({ identityToken: "stub-token" });

/* ------------------------------------------------------- expo-auth-session */
export const ResponseType = { IdToken: "id_token" };
export const useAuthRequest = () => [null, null, async () => {}];
export const makeRedirectUri = () => "stub://redirect";

/* ------------------------------------------------------------ AsyncStorage */
const store = new Map();
const AsyncStorage = {
  async getItem(k) {
    return store.has(k) ? store.get(k) : null;
  },
  async setItem(k, v) {
    store.set(k, v);
  },
  async removeItem(k) {
    store.delete(k);
  },
  __reset() {
    store.clear();
  },
};
export default AsyncStorage;
export { AsyncStorage };

/** The imperative router singleton (`import { router } from "expo-router"`). */
export const router = {
  push: (r) => calls.push.push(r),
  replace: (r) => calls.replace.push(r),
  back: () => {
    calls.back += 1;
  },
  navigate: (r) => calls.push.push(r),
  canGoBack: () => true,
  setParams: () => {},
};
