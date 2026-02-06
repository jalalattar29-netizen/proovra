import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, ListRow, Tabs } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useMemo, useState } from "react";
import { apiFetch } from "../../src/api";
import { enqueueUpload, processQueue } from "../../src/upload-queue";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { useRouter } from "expo-router";

export default function CaptureScreen() {
  const { t, fontFamilyBold } = useLocale();
  const [activeIndex, setActiveIndex] = useState(0);
  const typeMap = ["PHOTO", "VIDEO", "DOCUMENT"] as const;
  const activeType = typeMap[activeIndex];
  const [asset, setAsset] = useState<{ uri: string; mimeType: string; durationMs?: number } | null>(
    null
  );
  const [segments, setSegments] = useState<
    Array<{ uri: string; mimeType: string; durationMs?: number }>
  >([]);
  const [extendedMode, setExtendedMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handlePick = async () => {
    setError(null);
    try {
      if (activeType === "DOCUMENT") {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (!result.canceled && result.assets?.[0]) {
          const file = result.assets[0];
          setAsset({
            uri: file.uri,
            mimeType: file.mimeType ?? "application/octet-stream"
          });
        }
        return;
      }
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError("Camera permission denied");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes:
          activeType === "VIDEO"
            ? ImagePicker.MediaTypeOptions.Videos
            : ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        videoMaxDuration: activeType === "VIDEO" && extendedMode ? 1800 : undefined
      });
      if (!result.canceled && result.assets?.[0]) {
        const file = result.assets[0];
        const durationMs = file.duration ? Math.round(file.duration * 1000) : undefined;
        const next = {
          uri: file.uri,
          mimeType: file.mimeType ?? (activeType === "VIDEO" ? "video/mp4" : "image/jpeg"),
          durationMs
        };
        if (activeType === "VIDEO" && extendedMode) {
          setSegments((prev) => [...prev, next]);
        } else {
          setAsset(next);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to capture");
    }
  };

  const handleCapture = async () => {
    if (activeType === "VIDEO" && extendedMode) {
      if (segments.length === 0) {
        setError("Record at least one segment.");
        return;
      }
    } else if (!asset) {
      setError("Please capture or select a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (activeType === "VIDEO" && extendedMode) {
        const created = await apiFetch("/v1/evidence", {
          method: "POST",
          body: JSON.stringify({ type: activeType, mimeType: "video/mp4" })
        });
        for (let i = 0; i < segments.length; i += 1) {
          const seg = segments[i];
          const part = await apiFetch(`/v1/evidence/${created.id}/parts`, {
            method: "POST",
            body: JSON.stringify({
              partIndex: i,
              mimeType: seg.mimeType,
              durationMs: seg.durationMs
            })
          });
          await FileSystem.uploadAsync(part.upload.putUrl, seg.uri, {
            httpMethod: "PUT",
            headers: { "content-type": seg.mimeType },
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT
          });
        }
        await apiFetch(`/v1/evidence/${created.id}/complete`, {
          method: "POST",
          body: "{}"
        });
        router.push(`/evidence/${created.id}`);
      } else {
        enqueueUpload({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: activeType,
          uri: asset!.uri,
          mimeType: asset!.mimeType
        });
        await processQueue();
        router.push("/(tabs)");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const totalDuration = useMemo(() => {
    if (segments.length === 0) return 0;
    return segments.reduce((sum, seg) => sum + (seg.durationMs ?? 0), 0);
  }, [segments]);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>{t("capture")}</Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Tabs
          items={[t("photo"), t("video"), t("document")]}
          activeIndex={activeIndex}
          onSelect={(index) => {
            setActiveIndex(index);
            setAsset(null);
            setSegments([]);
            setExtendedMode(false);
          }}
        />
        {activeType === "VIDEO" ? (
          <Pressable
            style={[styles.captureBar, { backgroundColor: extendedMode ? colors.teal : colors.primaryNavy }]}
            onPress={() => setExtendedMode((prev) => !prev)}
          >
            <Text style={styles.uploadText}>
              {extendedMode ? "Extended mode ON (30 min segments)" : "Extended mode OFF"}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.preview}>
          <Text style={styles.previewText}>
            {activeType === "VIDEO" && extendedMode
              ? `Segments: ${segments.length} | Total ${(totalDuration / 1000 / 60).toFixed(1)} min`
              : asset
              ? "File selected"
              : "No file selected"}
          </Text>
        </View>
        <View style={styles.listCard}>
          <ListRow
            title={t("video")}
            subtitle="3 minutes ago"
            badge={<Badge tone="signed" label={t("statusSigned")} />}
          />
          <ListRow
            title={t("statusProcessing")}
            subtitle="Today, 09:45"
            badge={<Badge tone="processing" label={t("statusProcessing")} />}
          />
          <ListRow
            title={t("document")}
            subtitle="Yesterday"
            badge={<Badge tone="ready" label={t("statusReady")} />}
          />
        </View>
        <Pressable style={styles.captureBar} onPress={handlePick}>
          <View style={styles.captureCircle} />
        </Pressable>
        <Pressable
          style={[styles.captureBar, { backgroundColor: colors.teal }]}
          onPress={handleCapture}
          disabled={busy}
        >
          <Text style={styles.uploadText}>{busy ? "Uploading..." : "Upload & Sign"}</Text>
        </Pressable>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg
  },
  headerTitle: {
    fontSize: typography.size.h3,
    color: colors.textDark
  },
  headerIcon: {
    fontSize: 18,
    color: "#94A3B8"
  },
  preview: {
    height: 180,
    borderRadius: 18,
    backgroundColor: "#E2E8F0"
  },
  previewText: {
    color: "#64748b",
    padding: spacing.md
  },
  listCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  captureBar: {
    marginTop: spacing.md,
    borderRadius: 18,
    backgroundColor: colors.primaryNavy,
    paddingVertical: spacing.md,
    alignItems: "center"
  },
  captureCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.white
  },
  uploadText: {
    color: colors.white,
    fontWeight: "600"
  },
  errorText: {
    color: "#ef4444",
    paddingHorizontal: spacing.xl
  }
});
