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
// ONE object, as expo-router's useRouter() returns its stable imperative
// `router`. A fresh object per render made every effect that lists `router`
// as a dependency re-run on each state change — behaviour the real app never
// has, which reset screens mid-flow in tests only.
const stableRouter = {
  push: (r) => calls.push.push(r),
  replace: (r) => calls.replace.push(r),
  back: () => {
    calls.back += 1;
  },
  navigate: (r) => calls.push.push(r),
};
export const useRouter = () => stableRouter;
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
// A test observes the storage PUT by setting globalThis.__UPLOAD_ASYNC__.
export const uploadAsync = async (...a) => (typeof globalThis.__UPLOAD_ASYNC__ === "function" ? globalThis.__UPLOAD_ASYNC__(...a) : { status: 200 });

/* -------------------------------------------------------------- expo-crypto */
export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
export const digest = async () => new ArrayBuffer(32);
// A REAL SHA-256 (hex), so a test can assert the exact hash the server will see.
export const digestStringAsync = async (_alg, text) => {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};
let uuidSeq = 0;
export const randomUUID = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`;

/* ------------------------------------------------------------ expo-location */
export const Accuracy = { Balanced: 3 };
// globalThis.__LOCATION__ = { granted?: false, fail?: true, coords?, timestamp? } scripts the device.
export const requestForegroundPermissionsAsync = async () => {
  const granted = globalThis.__LOCATION__?.granted !== false;
  return { status: granted ? "granted" : "denied", granted, canAskAgain: true };
};
export const getCurrentPositionAsync = async () => {
  const l = globalThis.__LOCATION__ ?? {};
  if (l.fail) throw new Error("Location unavailable");
  return { coords: l.coords ?? { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: l.timestamp ?? 0 };
};

/* ------------------------------------------------------- expo-document-picker */
// A test stages a document by setting globalThis.__DOC_PICK__; unset, the picker is cancelled.
export const getDocumentAsync = async () => globalThis.__DOC_PICK__ ?? { canceled: true, assets: null };

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

/* ---------------------------------------------------------- expo-secure-store */
const secure = new Map();
export const getItemAsync = async (k) => (secure.has(k) ? secure.get(k) : null);
export const setItemAsync = async (k, v) => {
  secure.set(k, v);
};
export const deleteItemAsync = async (k) => {
  secure.delete(k);
};

/* ------------------------------------------------------------------ expo-font
 *
 * T-04 — the real `expo-font` is a native module and the `@expo-google-fonts/*`
 * packages ship .ttf binaries. Neither loads under Node.
 *
 * `useFonts` returns `[true, null]`: render tests then exercise the tree the
 * user actually sees, i.e. AFTER registration. The root layout deliberately
 * returns `null` until fonts load, so a stub that reported `false` would make
 * every authenticated render test assert against an empty tree — the exact
 * class of self-affirming test this harness exists to avoid.
 *
 * The font constants are opaque handles in production; identity is all that
 * matters, so a string is sufficient and keeps the bundle free of binaries.
 */
export const useFonts = () => [true, null];
export const loadAsync = async () => undefined;
export const isLoaded = () => true;

const face = (name) => name;
export const PlusJakartaSans_400Regular = face("PlusJakartaSans_400Regular");
export const PlusJakartaSans_500Medium = face("PlusJakartaSans_500Medium");
export const PlusJakartaSans_600SemiBold = face("PlusJakartaSans_600SemiBold");
export const PlusJakartaSans_700Bold = face("PlusJakartaSans_700Bold");
export const PlusJakartaSans_800ExtraBold = face("PlusJakartaSans_800ExtraBold");
export const NotoSansArabic_400Regular = face("NotoSansArabic_400Regular");
export const NotoSansArabic_500Medium = face("NotoSansArabic_500Medium");
export const NotoSansArabic_600SemiBold = face("NotoSansArabic_600SemiBold");
export const NotoSansArabic_700Bold = face("NotoSansArabic_700Bold");

/* ------------------------------------------------ expo-clipboard / expo-sharing */
// A test reads what was copied from globalThis.__CLIPBOARD__ and what was
// shared from globalThis.__SHARED__ (array of { uri, options }).
export const setStringAsync = async (text) => {
  globalThis.__CLIPBOARD__ = String(text);
  return true;
};
export const getStringAsync = async () => globalThis.__CLIPBOARD__ ?? "";
export const shareAsync = async (uri, options) => {
  (globalThis.__SHARED__ ??= []).push({ uri, options });
};
export const writeAsStringAsync = async (uri, contents) => {
  (globalThis.__WRITTEN__ ??= {})[uri] = contents;
};
