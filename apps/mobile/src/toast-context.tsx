import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { Animated, View, Text, StyleSheet, TouchableOpacity } from "react-native";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
  duration?: number;
}

interface ToastContextType {
  addToast: (message: string, type: Toast["type"], duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 20,
    left: 20,
    right: 20,
    zIndex: 1000,
  },
  toast: {
    marginBottom: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  toastText: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
  dismissButton: {
    marginLeft: 12,
    padding: 4,
  },
  dismissText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
  },
  toastSuccess: {
    backgroundColor: "#1F9D55",
  },
  toastError: {
    backgroundColor: "#D64545",
  },
  toastInfo: {
    backgroundColor: "#0B7BE5",
  },
  toastWarning: {
    backgroundColor: "#F59E0B",
  },
});

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const scaleAnim = useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 100,
      friction: 10,
    }).start();
  }, [scaleAnim]);

  const typeStyles = {
    success: styles.toastSuccess,
    error: styles.toastError,
    info: styles.toastInfo,
    warning: styles.toastWarning,
  };

  return (
    <Animated.View
      style={{
        transform: [
          {
            scale: scaleAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [0.8, 1],
            }),
          },
        ],
      }}
    >
      <View style={[styles.toast, typeStyles[toast.type]]}>
        <Text style={styles.toastText}>{toast.message}</Text>
        <TouchableOpacity
          style={styles.dismissButton}
          onPress={() => onDismiss(toast.id)}
        >
          <Text style={styles.dismissText}>×</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

interface ToastOverlayProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastOverlay({ toasts, onDismiss }: ToastOverlayProps) {
  return (
    <View style={styles.container} pointerEvents="box-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

interface ToastProviderProps {
  children: React.ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback(
    (message: string, type: Toast["type"], duration = 3000) => {
      const id = Date.now().toString() + Math.random();
      const toast: Toast = { id, message, type, duration };

      setToasts((prev) => [...prev, toast]);

      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastOverlay toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}
