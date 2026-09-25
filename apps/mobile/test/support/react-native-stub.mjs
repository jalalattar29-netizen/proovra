/**
 * React Native host-component stub for render tests.
 *
 * React Native's real entry point reaches for the native bridge and cannot load
 * in Node. This stub gives every primitive the screens use a plain host element
 * with the SAME props, so `react-test-renderer` produces a real element tree —
 * the component's own render logic, conditionals, state and handlers all
 * execute for real.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT.
 *   It proves: what a screen renders for a given set of props and data, which
 *   branch it takes, what a press does, whether a state is handled at all,
 *   and whether accessibility roles/labels are present.
 *   It does NOT prove: native layout, gestures, fonts, safe areas or anything
 *   about Hermes. Only the physical-device matrix proves those, and this file
 *   is not a substitute for it.
 *
 * Before this existed the suite had ZERO tests that rendered a component.
 */
import React from "react";

const host = (name) => {
  const C = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement(name, { ...props, ref }, children),
  );
  C.displayName = name;
  return C;
};

export const View = host("View");
export const Text = host("Text");
export const Pressable = host("Pressable");
export const ScrollView = host("ScrollView");
export const TextInput = host("TextInput");
export const Image = host("Image");
// T-05 — ImageBackground renders its children ON TOP of the source, so a
// render test must be able to find those children. Treating it as a host
// component with children preserves that, unlike a stub that drops them.
export const ImageBackground = host("ImageBackground");
// T-07 — expo-linear-gradient is aliased here; it is a plain host component.
export const LinearGradient = host("LinearGradient");
export const Switch = host("Switch");
export const ActivityIndicator = host("ActivityIndicator");
export const Modal = ({ visible = true, children, ...props }) =>
  visible ? React.createElement("Modal", props, children) : null;
export const KeyboardAvoidingView = host("KeyboardAvoidingView");
export const SafeAreaView = host("SafeAreaView");
export const FlatList = ({ data = [], renderItem, ListEmptyComponent, keyExtractor, ...props }) =>
  React.createElement(
    "FlatList",
    props,
    data.length === 0 && ListEmptyComponent
      ? React.createElement(ListEmptyComponent)
      : data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor ? keyExtractor(item, index) : index },
            renderItem({ item, index }),
          ),
        ),
  );

export const StyleSheet = {
  create: (styles) => styles,
  flatten: (style) =>
    Array.isArray(style)
      ? style.filter(Boolean).reduce((acc, s) => ({ ...acc, ...StyleSheet.flatten(s) }), {})
      : style ?? {},
  hairlineWidth: 1,
  absoluteFillObject: {},
};

export const Platform = { OS: "ios", select: (o) => o.ios ?? o.default };
export const Dimensions = { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) };
// Every opened URL is recorded on globalThis.__LINKING_OPENED__ so a test can assert what left the app.
export const Linking = {
  openURL: async (url) => {
    (globalThis.__LINKING_OPENED__ ??= []).push(url);
    return true;
  },
  canOpenURL: async () => true,
};
export const Alert = { alert: () => {} };
export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: 1 });
export const useColorScheme = () => "light";
export const I18nManager = { isRTL: false };
export const Appearance = { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) };
export const RefreshControl = host("RefreshControl");
export const Share = { share: async () => ({ action: "sharedAction" }) };

export default {
  View, Text, Pressable, ScrollView, TextInput, Image, Switch, ActivityIndicator,
  Modal, KeyboardAvoidingView, SafeAreaView, FlatList, StyleSheet, Platform,
  Dimensions, Linking, Alert, useWindowDimensions, useColorScheme, I18nManager,
  Appearance, RefreshControl, Share,
};

/**
 * Additional surfaces reached by the app's own modules (locale detection,
 * animation, layout config). Each is inert; a test that needs to observe one
 * asserts through the component, not through the stub.
 */
export const NativeModules = {
  SettingsManager: { settings: { AppleLocale: "en-US", AppleLanguages: ["en-US"] } },
  I18nManager: { localeIdentifier: "en_US" },
};
export const Animated = {
  View: host("Animated.View"),
  Text: host("Animated.Text"),
  Value: class { constructor(v) { this._v = v; } setValue(v) { this._v = v; } interpolate() { return this; } },
  timing: () => ({ start: (cb) => cb && cb({ finished: true }) }),
  spring: () => ({ start: (cb) => cb && cb({ finished: true }) }),
  parallel: () => ({ start: (cb) => cb && cb({ finished: true }) }),
  loop: () => ({ start: () => {}, stop: () => {} }),
};
export const Easing = { linear: (t) => t, inOut: (f) => f, ease: (t) => t };
export const LayoutAnimation = { configureNext: () => {}, Presets: { easeInEaseOut: {} } };
export const UIManager = { setLayoutAnimationEnabledExperimental: () => {} };
// A test can put the app in the background with globalThis.__APP_STATE__ = "background".
export const AppState = {
  get currentState() {
    return globalThis.__APP_STATE__ ?? "active";
  },
  addEventListener: () => ({ remove() {} }),
};
export const BackHandler = { addEventListener: () => ({ remove() {} }) };
export const Keyboard = { dismiss: () => {}, addListener: () => ({ remove() {} }) };
export const PixelRatio = { get: () => 3, getFontScale: () => 1, roundToNearestPixel: (n) => n };
export const SectionList = FlatList;
export const Button = host("Button");
export const TouchableOpacity = host("TouchableOpacity");
export const useSafeAreaInsets = () => ({ top: 47, bottom: 34, left: 0, right: 0 });
export const SafeAreaProvider = ({ children }) => children ?? null;
