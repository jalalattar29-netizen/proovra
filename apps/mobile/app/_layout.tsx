// D:\digital-witness\apps\mobile\app\_layout.tsx
import { Stack } from "expo-router";
import { LocaleProvider } from "../src/locale-context";
import { AuthProvider } from "../src/auth-context";
import { ToastProvider } from "../src/toast-context";
import { initSentry } from "../src/sentry";
import { ErrorBoundary } from "../src/error-boundary";
import { appTheme } from "../src/app-theme";

export default function RootLayout() {
  initSentry();
  return (
    <ErrorBoundary>
      {/* خلفية عامة حتى ما يطلع white flash */}
      <LocaleProvider>
        <AuthProvider>
          <ToastProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: appTheme.bg }
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="(stack)/auth" />
              <Stack.Screen name="(stack)/capture" />
              <Stack.Screen name="(stack)/billing" />
              <Stack.Screen name="(stack)/case/[id]" />
              <Stack.Screen name="(stack)/evidence/[id]" />
              <Stack.Screen name="verify" />
            </Stack>
          </ToastProvider>
        </AuthProvider>
      </LocaleProvider>
    </ErrorBoundary>
  );
}