import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiFetch, getAuthToken } from "../api";
import { usePlatformContext } from "../product/platform-context";

type Turn = {
  role: "user" | "assistant";
  content: string;
  warnings?: string[];
  suggestions?: string[];
};

type ChatResult = {
  data?: {
    status: "ok" | "blocked" | "disabled" | "error";
    summary?: string;
    warnings?: string[];
    suggestions?: string[];
  };
};

type Availability = {
  data?: {
    available: boolean;
    decision?: string;
  };
};

const PURPLE = "#7139d8";

const QUESTIONS = [
  "How do I capture evidence?",
  "What is a verification package?",
  "What does TSA failed mean?",
  "What can AI do in PROOVRA?",
];

// Allow only known, non-sensitive application screens.
function allowedRoute(path: string): boolean {
  return /^\/(?:home|capture|cases|evidence|settings|support|reports|billing|pricing|teams)?\/?$/.test(path);
}

function errorMessage(error: unknown): string {
  const e = error as {
    code?: string;
    statusCode?: number;
  };

  switch (e?.code) {
    case "AI_WORKSPACE_POLICY_DENIED":
    case "AI_DISABLED":
      return "AI assistance is disabled for this workspace.";

    case "AI_PLAN_NOT_ENTITLED":
    case "AI_PLAN_REQUIRED":
      return "AI assistance is not included in your plan.";

    case "AI_BUDGET_EXCEEDED":
    case "AI_COST_BUDGET_EXCEEDED":
      return "The AI usage budget has been reached.";

    case "AI_RATE_LIMITED":
      return "AI request limit reached. Try again later.";

    case "LEGAL_REACCEPT_REQUIRED":
      return "Please accept the updated legal terms.";
  }

  if (e?.statusCode === 401) {
    return "Your session has expired. Please sign in again.";
  }

  if (e?.statusCode === 403) {
    return "AI assistance is not permitted in this workspace.";
  }

  if (e?.statusCode === 429) {
    return "Too many requests. Please try again later.";
  }

  return "The assistant could not complete this request.";
}

export function NativeChatAssistant() {
  const path = usePathname();
  const platform = usePlatformContext();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [available, setAvailable] = useState(false);
  const [notice, setNotice] = useState("");

  const requestId = useRef(0);
  const logRef = useRef<ScrollView>(null);

  const boundary = JSON.stringify(platform.envelope ?? null);

  const permitted =
    allowedRoute(path) &&
    Boolean(getAuthToken()) &&
    Boolean(platform.envelope);

  // Clear the conversation whenever account/workspace context changes.
  useEffect(() => {
    requestId.current += 1;
    setOpen(false);
    setTurns([]);
    setDraft("");
    setNotice("");
    setAvailable(false);
    setBusy(false);
  }, [boundary]);

  // Never keep the assistant open on a sensitive route.
  useEffect(() => {
    if (!allowedRoute(path)) {
      requestId.current += 1;
      setOpen(false);
      setDraft("");
      setBusy(false);
    }
  }, [path]);

  // Check workspace AI policy before allowing a message.
  useEffect(() => {
    if (!open || !permitted) return;

    const id = ++requestId.current;

    setProbing(true);
    setAvailable(false);
    setNotice("");

    apiFetch("/v1/ai/availability", { method: "GET" })
      .then((payload: Availability) => {
        if (requestId.current !== id) return;

        if (!payload?.data) {
          setNotice("AI availability could not be confirmed.");
          return;
        }

        if (!payload.data.available) {
          setNotice(
            "AI assistance is disabled or unavailable for this workspace."
          );
          return;
        }

        setAvailable(true);
      })
      .catch((error: unknown) => {
        if (requestId.current === id) {
          setNotice(errorMessage(error));
        }
      })
      .finally(() => {
        if (requestId.current === id) {
          setProbing(false);
        }
      });

    return () => {
      requestId.current += 1;
    };
  }, [open, permitted, boundary]);

  async function send(value: string) {
    const text = value.trim().slice(0, 5000);

    if (
      !text ||
      busy ||
      !available ||
      !permitted ||
      !allowedRoute(path)
    ) {
      return;
    }

    const id = ++requestId.current;

    const next: Turn[] = [
      ...turns,
      { role: "user", content: text },
    ];

    setTurns(next);
    setDraft("");
    setBusy(true);
    setNotice("");

    try {
      // Send transcript only. Never send page titles,
      // evidence names, case IDs or verification tokens.
      const messages = next.slice(-20).map(
        ({ role, content }) => ({ role, content })
      );

      const response = (await apiFetch("/v1/ai/chat", {
        method: "POST",
        body: JSON.stringify({ messages }),
      })) as ChatResult;

      if (requestId.current !== id) return;

      const result = response?.data;

      if (!result || result.status !== "ok") {
        if (result?.status === "disabled") {
          setNotice("AI assistance is disabled for this workspace.");
          setAvailable(false);
        } else if (result?.status === "blocked") {
          setNotice("This request was blocked by the assistant's safety policy.");
        } else {
          setNotice("The assistant could not answer this request.");
        }
        return;
      }

      if (typeof result.summary !== "string") {
        setNotice("The assistant returned an invalid response.");
        return;
      }

      setTurns((previous) => [
        ...previous,
        {
          role: "assistant",
          content: result.summary!,
          warnings: result.warnings,
          suggestions: result.suggestions,
        },
      ]);
    } catch (error: unknown) {
      if (requestId.current === id) {
        setNotice(errorMessage(error));
      }
    } finally {
      if (requestId.current === id) {
        setBusy(false);
      }
    }
  }

  if (!permitted) return null;

  const tablet = width >= 700;

  return (
    <>
      <Pressable
        testID="native-ai-launcher"
        accessibilityRole="button"
        accessibilityLabel="Open PROOVRA assistant"
        onPress={() => setOpen(true)}
        style={styles.launcher}
      >
        <Feather name="message-circle" size={26} color="#fff" />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalRoot}
        >
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close assistant"
          />

          <View
            style={[
              styles.panel,
              tablet
                ? {
                    width: Math.min(430, width - 40),
                    maxHeight: height - 60,
                    marginRight: 20,
                    marginBottom: Math.max(20, insets.bottom),
                  }
                : {
                    width: width - 24,
                    maxHeight: height - insets.top - insets.bottom - 24,
                    marginBottom: Math.max(12, insets.bottom),
                  },
            ]}
          >
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>
                  PROOVRA Assistant
                </Text>

                <Text style={styles.disclosure}>
                  Advisory only. Answers questions about using PROOVRA.
                  Does not determine evidence authenticity or provide
                  legal advice.
                </Text>
              </View>

              <Pressable
                onPress={() => setOpen(false)}
                accessibilityLabel="Close assistant"
                hitSlop={12}
              >
                <Feather name="x" size={24} color="#263348" />
              </Pressable>
            </View>

            <ScrollView
              ref={logRef}
              style={styles.log}
              contentContainerStyle={styles.logContent}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() =>
                logRef.current?.scrollToEnd({ animated: true })
              }
            >
              {turns.length === 0 ? (
                <>
                  <Text style={styles.lead}>
                    Ask about capturing, organising or verifying evidence.
                  </Text>

                  {QUESTIONS.map((question) => (
                    <Pressable
                      key={question}
                      disabled={!available || busy}
                      onPress={() => void send(question)}
                      style={styles.question}
                    >
                      <Text style={styles.questionText}>
                        {question}
                      </Text>
                    </Pressable>
                  ))}
                </>
              ) : (
                turns.map((turn, index) => (
                  <View
                    key={index}
                    style={[
                      styles.bubble,
                      turn.role === "user"
                        ? styles.userBubble
                        : styles.answerBubble,
                    ]}
                  >
                    <Text style={styles.message}>
                      {turn.content}
                    </Text>

                    {turn.warnings?.map((warning, i) => (
                      <Text key={`w${i}`} style={styles.warning}>
                        {warning}
                      </Text>
                    ))}

                    {turn.suggestions?.map((suggestion, i) => (
                      <Text key={`s${i}`} style={styles.suggestion}>
                        {suggestion}
                      </Text>
                    ))}
                  </View>
                ))
              )}

              {busy || probing ? (
                <ActivityIndicator color={PURPLE} />
              ) : null}
            </ScrollView>

            {notice ? (
              <Text accessibilityRole="alert" style={styles.notice}>
                {notice}
              </Text>
            ) : null}

            <View style={styles.composer}>
              <TextInput
                accessibilityLabel="Ask the assistant"
                placeholder="Ask a question..."
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={5000}
                editable={available && !busy && !probing}
                style={styles.input}
              />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                disabled={!draft.trim() || !available || busy}
                onPress={() => void send(draft)}
                style={[
                  styles.send,
                  (!draft.trim() || !available || busy) && {
                    opacity: 0.4,
                  },
                ]}
              >
                <Feather name="send" size={19} color="#fff" />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  launcher: {
    position: "absolute",
    bottom: 18,
    right: 18,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
    elevation: 9,
    zIndex: 100,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(10,17,29,0.35)",
    alignItems: "flex-end",
    justifyContent: "flex-end",
  },
  panel: {
    backgroundColor: "#fff",
    borderRadius: 18,
    overflow: "hidden",
    minHeight: 360,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e7eaf0",
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#1a2435",
  },
  disclosure: {
    fontSize: 12,
    lineHeight: 18,
    color: "#59677b",
    marginTop: 5,
  },
  log: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 160,
  },
  logContent: {
    gap: 12,
    padding: 14,
  },
  lead: {
    fontSize: 14,
    color: "#39485d",
    marginBottom: 8,
  },
  question: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#ddd6f6",
  },
  questionText: {
    fontSize: 13,
    color: "#4d3694",
  },
  bubble: {
    borderRadius: 12,
    padding: 12,
    maxWidth: "94%",
    gap: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#e9ddfa",
  },
  answerBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#f2f4f8",
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    color: "#263348",
  },
  warning: {
    fontSize: 12,
    color: "#96551d",
  },
  suggestion: {
    fontSize: 12,
    color: "#4d3694",
  },
  notice: {
    padding: 12,
    color: "#863d22",
    backgroundColor: "#fff1e7",
    fontSize: 13,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#e7eaf0",
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#d9dfe8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: "#263348",
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
  },
});
