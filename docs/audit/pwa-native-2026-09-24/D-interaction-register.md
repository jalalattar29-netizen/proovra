# D — COMPLETE INTERACTION REGISTER

**Audited SHA:** `10668edbe4ac189ff965a09c7e8be17953d83f4a`
**Machine source:** `interaction-register.json` (485 controls).

Every interactive control on every applicable native screen, with what its handler is
**wired to** — resolved by following named handlers up to 3 levels inside the file.

**No control is marked passing because an `onPress` exists.** A handler whose effect
cannot be reached in-file is `UNVERIFIED`, not a pass. And no verdict here is a
runtime claim: this is source evidence that a handler is bound and what it calls. That
a tap reaches the server on a real device is **UNVERIFIED for all 485 controls**
(0 simulator runs, 0 device runs).

| Wired to | Controls |
|---|---:|
| `LOCAL_STATE` | 184 |
| `NAVIGATION` | 140 |
| `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | 69 |
| `EXTERNAL_HANDLER_UNRESOLVED` | 33 |
| `API_CALL+LOCAL_STATE` | 32 |
| `FEEDBACK_OR_DIALOG+LOCAL_STATE` | 13 |
| `API_CALL+LOCAL_STATE+NAVIGATION` | 7 |
| `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | 5 |
| `FEEDBACK_OR_DIALOG` | 1 |
| `LOCAL_STATE+NAVIGATION` | 1 |

| Verdict | Controls |
|---|---:|
| WIRED_SOURCE_INFERRED | 452 |
| UNVERIFIED (handler leaves the file) | 33 |


## `/evidence` — 39 controls

`apps/mobile/app/(tabs)/evidence.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 117 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onPress` | **UNVERIFIED** |
| 118 | `onLongPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onLongPress` | **UNVERIFIED** |
| 186 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onClose` | **UNVERIFIED** |
| 280 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(preview.url)` | wired |
| 333 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onOpenReport` | **UNVERIFIED** |
| 361 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onOpenPackage` | **UNVERIFIED** |
| 375 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onShareVerification` | **UNVERIFIED** |
| 384 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onOpenRecord` | **UNVERIFIED** |
| 1104 | `onPress` | `LOCAL_STATE` | `() => setScope(s.key)` | wired |
| 1123 | `onChangeText` | `API_CALL+LOCAL_STATE` | `onSearch` | wired |
| 1127 | `onPress` | `LOCAL_STATE` | `() => setTypeFilter("ALL")` | wired |
| 1129 | `onPress` | `LOCAL_STATE` | `() => setTypeFilter(tf)` | wired |
| 1131 | `onPress` | `LOCAL_STATE` | `() => setSort((s) => nextSort(s))` | wired |
| 1132 | `onPress` | `LOCAL_STATE` | `() => setShowFilters((v) => !v)` | wired |
| 1139 | `onPress` | `LOCAL_STATE` | `() => setStatusFilter("ALL")` | wired |
| 1141 | `onPress` | `LOCAL_STATE` | `() => setStatusFilter(st)` | wired |
| 1146 | `onPress` | `LOCAL_STATE` | `() => setSourceFilter("ALL")` | wired |
| 1148 | `onPress` | `LOCAL_STATE` | `() => setSourceFilter(sf)` | wired |
| 1153 | `onPress` | `LOCAL_STATE` | `() => setReportFilter("ALL")` | wired |
| 1155 | `onPress` | `LOCAL_STATE` | `() => setReportFilter(rf)` | wired |
| 1158 | `onPress` | `LOCAL_STATE` | `clearFilters` | wired |
| 1170 | `onPress` | `LOCAL_STATE` | `() => applyView(v)` | wired |
| 1171 | `onLongPress` | `LOCAL_STATE` | `() => openViewManager(v)` | wired |
| 1175 | `onPress` | `LOCAL_STATE` | `() => setShowSaveView((s) => !s)` | wired |
| 1176 | `onPress` | `LOCAL_STATE` | `() => { setSelectionMode((m) => !m); setSelected(new Set()); }` | wired |
| 1181 | `onChangeText` | `LOCAL_STATE` | `setNewViewName` | wired |
| 1181 | `onSubmitEditing` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void saveView()` | wired |
| 1187 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void saveView()` | wired |
| 1204 | `onChangeText` | `LOCAL_STATE` | `setRenameDraft` | wired |
| 1217 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void renameView()` | wired |
| 1228 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void makeViewDefault()` | wired |
| 1235 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `deleteView` | wired |
| 1255 | `onPress` | `LOCAL_STATE` | `() => setCaseChooserOpen(false)` | wired |
| 1278 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => addSelectionToCase(caseOption)` | wired |
| 1292 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => runBulk(a)` | wired |
| 1306 | `onPress` | `NAVIGATION` | `() => router.push("/capture")` | wired |
| 1319 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => (selectionMode ? toggleSelected(item.id) : openInspector(item.id))` | wired |
| 1324 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => restore(item)` | wired |
| 1335 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => void reload(true, cursor)` | **UNVERIFIED** |

## `/settings` — 32 controls

`apps/mobile/app/(tabs)/settings.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 108 | `onChangeText` | `LOCAL_STATE` | `setNameValue` | wired |
| 108 | `onSubmitEditing` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void saveName()` | wired |
| 111 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void saveName()` | wired |
| 112 | `onPress` | `LOCAL_STATE` | `() => { setEditingName(false); setNameValue(nameShown); }` | wired |
| 120 | `onPress` | `LOCAL_STATE` | `() => { setNameValue(nameShown); setEditingName(true); }` | wired |
| 127 | `onPress` | `LOCAL_STATE` | `() => void setDeviceTimezone()` | wired |
| 136 | `onPress` | `LOCAL_STATE` | `() => setLocaleMode("auto")` | wired |
| 142 | `onPress` | `LOCAL_STATE` | `() => { setLocaleMode("manual"); setLocale(lng); }` | wired |
| 159 | `onValueChange` | `LOCAL_STATE` | `onToggleTelemetry` | wired |
| 164 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/privacy")` | wired |
| 169 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/reviewer-criteria")` | wired |
| 174 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/spaces")` | wired |
| 179 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/organizations")` | wired |
| 184 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/workspace-people")` | wired |
| 195 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/ai")` | wired |
| 200 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/notifications")` | wired |
| 205 | `onPress` | `NAVIGATION` | `() => router.push("/legal-acceptance")` | wired |
| 216 | `onPress` | `NAVIGATION` | `() => router.push("/legal/terms")` | wired |
| 217 | `onPress` | `NAVIGATION` | `() => router.push("/legal/privacy")` | wired |
| 221 | `onPress` | `NAVIGATION` | `() => router.push("/legal")` | wired |
| 226 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/support")` | wired |
| 228 | `onPress` | `NAVIGATION` | `() => router.push("/verify")` | wired |
| 232 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/trust-center")` | wired |
| 249 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/security")` | wired |
| 259 | `onPress` | `NAVIGATION` | `() => router.push("/teams")` | wired |
| 264 | `onPress` | `NAVIGATION` | `() => router.push("/evidence-requests")` | wired |
| 269 | `onPress` | `NAVIGATION` | `() => router.push("/intake-links")` | wired |
| 276 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/billing")` | wired |
| 288 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/operations/quotas")` | wired |
| 293 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/operations/batch-analysis")` | wired |
| 298 | `onPress` | `LOCAL_STATE+NAVIGATION` | `() => void doLogout()` | wired |
| 308 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onPress` | **UNVERIFIED** |

## `/evidence/[id]` — 29 controls

`apps/mobile/app/(stack)/evidence/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 614 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 662 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 682 | `onPress` | `LOCAL_STATE` | `() => { setLabelDraft(c.displayTitle?.trim() \|\| c.originalFileName?.trim() \|\| ""); set` | wired |
| 714 | `onChangeText` | `LOCAL_STATE` | `setLabelDraft` | wired |
| 727 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void renameRecord()` | wired |
| 742 | `onPress` | `LOCAL_STATE` | `() => setLinkTypePicker(true)` | wired |
| 747 | `onChangeText` | `LOCAL_STATE` | `setLinkNote` | wired |
| 773 | `onPress` | `LOCAL_STATE` | `() => setLinkTarget({ id: cand.id, title: cand.title })` | wired |
| 782 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void createLink()` | wired |
| 796 | `onPress` | `LOCAL_STATE` | `() => { setLinkType(t); setLinkTypePicker(false); }` | wired |
| 809 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { setTab(tb.key); if (tb.key === "duplicates" && duplicates === null) void loadDupli` | wired |
| 849 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Unlock", { buildPath: buildEvidenceUnlockPath })` | **UNVERIFIED** |
| 851 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Lock", { buildPath: buildEvidenceLockPath })` | **UNVERIFIED** |
| 854 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Archive", { buildPath: buildEvidenceArchivePath })` | **UNVERIFIED** |
| 857 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Restore", { buildPath: buildEvidenceUnarchivePath })` | **UNVERIFIED** |
| 873 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | `openOriginal` | wired |
| 876 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Move to Trash", { buildPath: buildEvidencePath, method: "DELETE", destruc` | **UNVERIFIED** |
| 940 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void shareVerification()` | wired |
| 1020 | `onPress` | `NAVIGATION` | `() => router.push(`/evidence/${rel.linkedId}`)` | wired |
| 1021 | `onLongPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `linkRefusal ? undefined : () => removeLink(rel)` | wired |
| 1044 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { setLinking(true); void loadLinkCandidates(); }` | wired |
| 1062 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(reportUrl)` | wired |
| 1082 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { if (generationNeedsConfirmation(reportState === "READY" ? "REGENERATE" : "GENERATE` | wired |
| 1156 | `onPress` | `NAVIGATION` | `() => router.push(`/(stack)/evidence/${m.evidenceId}` as never)` | wired |
| 1171 | `onConfirm` | `API_CALL+LOCAL_STATE` | `() => void requestGeneration()` | wired |
| 1215 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(m.viewUrl as string)` | wired |
| 1268 | `onChangeText` | `LOCAL_STATE` | `setDraft` | wired |
| 1278 | `onChange` | `LOCAL_STATE` | `(v: string) => setVisibility(v as EvidenceCommentVisibility)` | wired |
| 1288 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void postComment()` | wired |

## `/share/[id]` — 29 controls

`apps/mobile/app/(stack)/evidence/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 614 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 662 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 682 | `onPress` | `LOCAL_STATE` | `() => { setLabelDraft(c.displayTitle?.trim() \|\| c.originalFileName?.trim() \|\| ""); set` | wired |
| 714 | `onChangeText` | `LOCAL_STATE` | `setLabelDraft` | wired |
| 727 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void renameRecord()` | wired |
| 742 | `onPress` | `LOCAL_STATE` | `() => setLinkTypePicker(true)` | wired |
| 747 | `onChangeText` | `LOCAL_STATE` | `setLinkNote` | wired |
| 773 | `onPress` | `LOCAL_STATE` | `() => setLinkTarget({ id: cand.id, title: cand.title })` | wired |
| 782 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void createLink()` | wired |
| 796 | `onPress` | `LOCAL_STATE` | `() => { setLinkType(t); setLinkTypePicker(false); }` | wired |
| 809 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { setTab(tb.key); if (tb.key === "duplicates" && duplicates === null) void loadDupli` | wired |
| 849 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Unlock", { buildPath: buildEvidenceUnlockPath })` | **UNVERIFIED** |
| 851 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Lock", { buildPath: buildEvidenceLockPath })` | **UNVERIFIED** |
| 854 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Archive", { buildPath: buildEvidenceArchivePath })` | **UNVERIFIED** |
| 857 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Restore", { buildPath: buildEvidenceUnarchivePath })` | **UNVERIFIED** |
| 873 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | `openOriginal` | wired |
| 876 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => runAction("Move to Trash", { buildPath: buildEvidencePath, method: "DELETE", destruc` | **UNVERIFIED** |
| 940 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void shareVerification()` | wired |
| 1020 | `onPress` | `NAVIGATION` | `() => router.push(`/evidence/${rel.linkedId}`)` | wired |
| 1021 | `onLongPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `linkRefusal ? undefined : () => removeLink(rel)` | wired |
| 1044 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { setLinking(true); void loadLinkCandidates(); }` | wired |
| 1062 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(reportUrl)` | wired |
| 1082 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { if (generationNeedsConfirmation(reportState === "READY" ? "REGENERATE" : "GENERATE` | wired |
| 1156 | `onPress` | `NAVIGATION` | `() => router.push(`/(stack)/evidence/${m.evidenceId}` as never)` | wired |
| 1171 | `onConfirm` | `API_CALL+LOCAL_STATE` | `() => void requestGeneration()` | wired |
| 1215 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(m.viewUrl as string)` | wired |
| 1268 | `onChangeText` | `LOCAL_STATE` | `setDraft` | wired |
| 1278 | `onChange` | `LOCAL_STATE` | `(v: string) => setVisibility(v as EvidenceCommentVisibility)` | wired |
| 1288 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void postComment()` | wired |

## `/capture` — 26 controls

`apps/mobile/app/(stack)/capture.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 1306 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 1317 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void resumeSession(resumable)` | wired |
| 1318 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void discardRecovered()` | wired |
| 1341 | `onPress` | `FEEDBACK_OR_DIALOG` | `() => { if (isRecording) { addToast("Stop the current recording before changing type", "wa` | wired |
| 1373 | `onValueChange` | `LOCAL_STATE` | `setUseLocation` | wired |
| 1402 | `onPress` | `NAVIGATION` | `() => router.push("/screen-capture")` | wired |
| 1408 | `onPress` | `NAVIGATION` | `() => router.push("/continuous-capture")` | wired |
| 1416 | `onPress` | `NAVIGATION` | `() => router.push("/continuous-capture")` | wired |
| 1440 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `isRecording ? handleStopAudioRecording : handleStartAudioRecording` | wired |
| 1454 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `handleTakePhoto` | wired |
| 1459 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `isRecording ? handleStopRecording : handleStartRecording` | wired |
| 1462 | `onPress` | `LOCAL_STATE` | `() => setCameraOpen(false)` | wired |
| 1466 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `openPickerOrCamera` | wired |
| 1512 | `onPress` | `LOCAL_STATE` | `() => { setNoteDraft(item.privateNote ?? ""); setPlanningItem(item); }` | wired |
| 1521 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => removeFromSession(item.id)` | wired |
| 1530 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `openPickerOrCamera` | wired |
| 1536 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `handleStartAudioRecording` | wired |
| 1543 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `openPickerOrCamera` | wired |
| 1550 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `completeSession` | wired |
| 1552 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void discardSession()` | wired |
| 1575 | `onPress` | `FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => { setMixedOrigin(null); void completeSession(); }` | wired |
| 1583 | `onPress` | `LOCAL_STATE` | `() => setMixedOrigin(null)` | wired |
| 1602 | `onPress` | `LOCAL_STATE` | `() => { if (!planningItem) return; // The ROLE string is what readiness reads first: a // ` | wired |
| 1632 | `onChangeText` | `LOCAL_STATE` | `setNoteDraft` | wired |
| 1641 | `onPress` | `LOCAL_STATE` | `() => { if (planningItem) { applyPlan(planningItem.id, { privateNote: noteDraft.trim() \|\` | wired |
| 1652 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => Linking.openSettings()` | **UNVERIFIED** |

## `/people` — 25 controls

`apps/mobile/app/(stack)/workspace-people.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 466 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 508 | `onPress` | `LOCAL_STATE` | `() => { setDraftName(overview.name ?? ""); setRenaming(true); }` | wired |
| 533 | `onPress` | `LOCAL_STATE` | `canChangeRole(m, overview.canManageMembers) ? () => setRoleFor(m) : undefined` | wired |
| 557 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void loadMore()` | wired |
| 574 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 584 | `onChange` | `LOCAL_STATE` | `setRole` | wired |
| 591 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void invite()` | wired |
| 630 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void resend(i.id)` | wired |
| 637 | `onPress` | `LOCAL_STATE` | `() => setRevoking(i)` | wired |
| 674 | `onPress` | `LOCAL_STATE` | `() => setUnlinking(c)` | wired |
| 687 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void openLinkPicker()` | wired |
| 727 | `onPress` | `LOCAL_STATE` | `() => setTransferring(true)` | wired |
| 743 | `onPress` | `LOCAL_STATE` | `() => setCancellingClosure(true)` | wired |
| 766 | `onPress` | `LOCAL_STATE` | `() => setClosing(true)` | wired |
| 794 | `onPress` | `LOCAL_STATE` | `() => { setTransferring(false); setTransferTarget(m); }` | wired |
| 810 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void transferOwnership()` | wired |
| 828 | `onChangeText` | `LOCAL_STATE` | `setPhrase` | wired |
| 844 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void requestClosure()` | wired |
| 855 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void cancelClosure()` | wired |
| 888 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => { if (roleFor) void changeRole(roleFor, r); }` | wired |
| 906 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void linkCase(c)` | wired |
| 919 | `onChangeText` | `LOCAL_STATE` | `setDraftName` | wired |
| 928 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void rename()` | wired |
| 939 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void unlinkCase()` | wired |
| 955 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void revoke()` | wired |

## `/teams/[id]` — 25 controls

`apps/mobile/app/(stack)/workspace-people.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 466 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 508 | `onPress` | `LOCAL_STATE` | `() => { setDraftName(overview.name ?? ""); setRenaming(true); }` | wired |
| 533 | `onPress` | `LOCAL_STATE` | `canChangeRole(m, overview.canManageMembers) ? () => setRoleFor(m) : undefined` | wired |
| 557 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void loadMore()` | wired |
| 574 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 584 | `onChange` | `LOCAL_STATE` | `setRole` | wired |
| 591 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void invite()` | wired |
| 630 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void resend(i.id)` | wired |
| 637 | `onPress` | `LOCAL_STATE` | `() => setRevoking(i)` | wired |
| 674 | `onPress` | `LOCAL_STATE` | `() => setUnlinking(c)` | wired |
| 687 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void openLinkPicker()` | wired |
| 727 | `onPress` | `LOCAL_STATE` | `() => setTransferring(true)` | wired |
| 743 | `onPress` | `LOCAL_STATE` | `() => setCancellingClosure(true)` | wired |
| 766 | `onPress` | `LOCAL_STATE` | `() => setClosing(true)` | wired |
| 794 | `onPress` | `LOCAL_STATE` | `() => { setTransferring(false); setTransferTarget(m); }` | wired |
| 810 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void transferOwnership()` | wired |
| 828 | `onChangeText` | `LOCAL_STATE` | `setPhrase` | wired |
| 844 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void requestClosure()` | wired |
| 855 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void cancelClosure()` | wired |
| 888 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => { if (roleFor) void changeRole(roleFor, r); }` | wired |
| 906 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void linkCase(c)` | wired |
| 919 | `onChangeText` | `LOCAL_STATE` | `setDraftName` | wired |
| 928 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void rename()` | wired |
| 939 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void unlinkCase()` | wired |
| 955 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void revoke()` | wired |

## `/cases/[id]` — 20 controls

`apps/mobile/app/(stack)/case/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 325 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 331 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 349 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void changeStatus(s)` | wired |
| 371 | `onPress` | `LOCAL_STATE` | `() => setChangingStatus((v) => !v)` | wired |
| 374 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void exportZip()` | wired |
| 388 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void openAdd()` | wired |
| 403 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void attach(e.id)` | wired |
| 407 | `onPress` | `LOCAL_STATE` | `() => setAvailable(null)` | wired |
| 420 | `onPress` | `NAVIGATION` | `() => router.push(`/(stack)/evidence/${item.id}` as never)` | wired |
| 423 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => removeFromCase(item)` | wired |
| 445 | `onChangeText` | `LOCAL_STATE` | `setNoteText` | wired |
| 445 | `onSubmitEditing` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void addNote()` | wired |
| 447 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void addNote()` | wired |
| 468 | `onPress` | `LOCAL_STATE` | `() => void setNoteResolved(note, !note.resolved)` | wired |
| 477 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void deleteNote(note)` | wired |
| 513 | `onPress` | `LOCAL_STATE` | `() => { setNameDraft(name); setRenaming(true); }` | wired |
| 525 | `onPress` | `LOCAL_STATE` | `() => setDeleting(true)` | wired |
| 535 | `onChangeText` | `LOCAL_STATE` | `setNameDraft` | wired |
| 544 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void renameCase()` | wired |
| 558 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | `() => void deleteCase()` | wired |

## `/operations/batch-analysis` — 12 controls

`apps/mobile/app/(stack)/operations/batch-analysis.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 154 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onExport` | **UNVERIFIED** |
| 168 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `onCancel` | **UNVERIFIED** |
| 320 | `onPress` | `LOCAL_STATE` | `() => setComposing(true)` | wired |
| 328 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 350 | `onPress` | `LOCAL_STATE` | `() => setComposing(true)` | wired |
| 388 | `onChangeText` | `LOCAL_STATE` | `setName` | wired |
| 398 | `onChangeText` | `LOCAL_STATE` | `setDescription` | wired |
| 409 | `onChangeText` | `LOCAL_STATE` | `setSearch` | wired |
| 411 | `onSubmitEditing` | `API_CALL+LOCAL_STATE` | `() => void loadCandidates()` | wired |
| 432 | `onPress` | `LOCAL_STATE` | `() => toggle(row.id)` | wired |
| 446 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void create()` | wired |
| 463 | `onConfirm` | `API_CALL+LOCAL_STATE` | `() => void cancel()` | wired |

## `/organizations/[id]` — 12 controls

`apps/mobile/app/(stack)/organizations/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 285 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 419 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void loadMoreAudit()` | wired |
| 443 | `onPress` | `LOCAL_STATE` | `() => setLeaving(true)` | wired |
| 453 | `onPress` | `LOCAL_STATE` | `() => setTransferring(true)` | wired |
| 469 | `onPress` | `LOCAL_STATE` | `() => setCancellingClosure(true)` | wired |
| 497 | `onPress` | `LOCAL_STATE` | `() => setClosing(true)` | wired |
| 523 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | `() => void leave()` | wired |
| 547 | `onPress` | `LOCAL_STATE` | `() => { setTransferring(false); setTransferTarget(m); }` | wired |
| 563 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void transfer()` | wired |
| 581 | `onChangeText` | `LOCAL_STATE` | `setPhrase` | wired |
| 602 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void requestClosure()` | wired |
| 613 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void cancelClosure()` | wired |

## `/settings/reviewer-criteria` — 12 controls

`apps/mobile/app/(stack)/settings/reviewer-criteria.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 199 | `onPress` | `LOCAL_STATE` | `() => setCreating(true)` | wired |
| 204 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 230 | `onPress` | `LOCAL_STATE` | `() => setCreating(true)` | wired |
| 283 | `onPress` | `LOCAL_STATE` | `() => setPending({ set, action })` | wired |
| 298 | `onPress` | `LOCAL_STATE` | `() => setEditing((cur) => (cur === set.id ? null : set.id))` | wired |
| 318 | `onPress` | `API_CALL+LOCAL_STATE` | `() => { if (usage[set.id]) { setUsage((prev) => { const next = { ...prev }; delete next[se` | wired |
| 374 | `onChangeText` | `LOCAL_STATE` | `setNewName` | wired |
| 384 | `onChangeText` | `LOCAL_STATE` | `setNewDescription` | wired |
| 395 | `onChangeText` | `LOCAL_STATE` | `setNewTitle` | wired |
| 403 | `onChange` | `LOCAL_STATE` | `setNewRows` | wired |
| 405 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void create()` | wired |
| 420 | `onConfirm` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void run()` | wired |

## `/evidence-requests/[id]` — 11 controls

`apps/mobile/app/(stack)/evidence-request/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 167 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 168 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 178 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 237 | `onPress` | `LOCAL_STATE` | `() => { setReviewing(resp); setDecision(null); setReviewNote(""); }` | wired |
| 251 | `onPress` | `NAVIGATION` | `() => router.push("/capture")` | wired |
| 270 | `onPress` | `LOCAL_STATE` | `() => setPending(t)` | wired |
| 348 | `onChangeText` | `LOCAL_STATE` | `setNote` | wired |
| 359 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void runTransition()` | wired |
| 392 | `onPress` | `LOCAL_STATE` | `() => setDecision(d)` | wired |
| 405 | `onChangeText` | `LOCAL_STATE` | `setReviewNote` | wired |
| 416 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void reviewResponse()` | wired |

## `/auth` — 9 controls

`apps/mobile/app/(stack)/auth.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 75 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 85 | `onChangeText` | `LOCAL_STATE` | `setPassword` | wired |
| 89 | `onSubmitEditing` | `LOCAL_STATE` | `() => void submit()` | wired |
| 99 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => void resendVerification(email.trim())` | **UNVERIFIED** |
| 103 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 105 | `onPress` | `NAVIGATION` | `() => router.push("/register")` | wired |
| 106 | `onPress` | `NAVIGATION` | `() => router.push("/forgot-password")` | wired |
| 123 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.promptGoogle` | **UNVERIFIED** |
| 130 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.signInApple` | **UNVERIFIED** |

## `/auth/callback/ui` — 9 controls

`apps/mobile/app/(stack)/auth.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 75 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 85 | `onChangeText` | `LOCAL_STATE` | `setPassword` | wired |
| 89 | `onSubmitEditing` | `LOCAL_STATE` | `() => void submit()` | wired |
| 99 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => void resendVerification(email.trim())` | **UNVERIFIED** |
| 103 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 105 | `onPress` | `NAVIGATION` | `() => router.push("/register")` | wired |
| 106 | `onPress` | `NAVIGATION` | `() => router.push("/forgot-password")` | wired |
| 123 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.promptGoogle` | **UNVERIFIED** |
| 130 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.signInApple` | **UNVERIFIED** |

## `/inbox` — 9 controls

`apps/mobile/app/(tabs)/notifications.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 158 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void markAllRead()` | wired |
| 168 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/notifications")` | wired |
| 173 | `onChange` | `LOCAL_STATE` | `setFilter` | wired |
| 194 | `onPress` | `LOCAL_STATE` | `() => setFilter("all")` | wired |
| 210 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => open(item)` | wired |
| 222 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void act(item, item.isRead ? "unread" : "read")` | wired |
| 228 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void act(item, "archive")` | wired |
| 241 | `onPress` | `LOCAL_STATE` | `() => setSnoozing(item)` | wired |
| 262 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void snooze(choice.hours)` | wired |

## `/login` — 9 controls

`apps/mobile/app/(stack)/auth.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 75 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 85 | `onChangeText` | `LOCAL_STATE` | `setPassword` | wired |
| 89 | `onSubmitEditing` | `LOCAL_STATE` | `() => void submit()` | wired |
| 99 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => void resendVerification(email.trim())` | **UNVERIFIED** |
| 103 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 105 | `onPress` | `NAVIGATION` | `() => router.push("/register")` | wired |
| 106 | `onPress` | `NAVIGATION` | `() => router.push("/forgot-password")` | wired |
| 123 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.promptGoogle` | **UNVERIFIED** |
| 130 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `oauth.signInApple` | **UNVERIFIED** |

## `/notifications` — 9 controls

`apps/mobile/app/(tabs)/notifications.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 158 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void markAllRead()` | wired |
| 168 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/settings/notifications")` | wired |
| 173 | `onChange` | `LOCAL_STATE` | `setFilter` | wired |
| 194 | `onPress` | `LOCAL_STATE` | `() => setFilter("all")` | wired |
| 210 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => open(item)` | wired |
| 222 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void act(item, item.isRead ? "unread" : "read")` | wired |
| 228 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void act(item, "archive")` | wired |
| 241 | `onPress` | `LOCAL_STATE` | `() => setSnoozing(item)` | wired |
| 262 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void snooze(choice.hours)` | wired |

## `/cases` — 8 controls

`apps/mobile/app/(tabs)/cases.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 122 | `onPress` | `LOCAL_STATE` | `() => setCreating((v) => !v)` | wired |
| 141 | `onChangeText` | `LOCAL_STATE` | `setNewName` | wired |
| 141 | `onSubmitEditing` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => void create()` | wired |
| 143 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => void create()` | wired |
| 150 | `onChangeText` | `LOCAL_STATE` | `setQuery` | wired |
| 159 | `onPress` | `LOCAL_STATE` | `() => setStatusFilter(f)` | wired |
| 179 | `onPress` | `LOCAL_STATE` | `() => setCreating(true)` | wired |
| 189 | `onPress` | `NAVIGATION` | `() => router.push(`/case/${c.id}`)` | wired |

## `/collaboration-teams` — 8 controls

`apps/mobile/app/(tabs)/teams.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 139 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/workspace-people")` | wired |
| 155 | `onChangeText` | `LOCAL_STATE` | `setNewName` | wired |
| 164 | `onChange` | `LOCAL_STATE` | `setNewType` | wired |
| 174 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void create()` | wired |
| 179 | `onPress` | `LOCAL_STATE` | `() => { setCreating(false); setNewName(""); }` | wired |
| 186 | `onPress` | `LOCAL_STATE` | `() => setCreating(true)` | wired |
| 220 | `onPress` | `NAVIGATION` | `() => router.push(`/collaboration-team/${team.id}`)` | wired |
| 227 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load(cursor, teams)` | wired |

## `/home` — 7 controls

`apps/mobile/app/(tabs)/index.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 280 | `onPress` | `NAVIGATION` | `() => router.push("/search")` | wired |
| 295 | `onPress` | `NAVIGATION` | `() => router.push("/capture")` | wired |
| 323 | `onPress` | `API_CALL+LOCAL_STATE` | `load` | wired |
| 355 | `onPress` | `NAVIGATION` | `p.href ? () => router.push(p.href as never) : undefined` | wired |
| 376 | `onPress` | `NAVIGATION` | `() => router.push("/capture")` | wired |
| 393 | `onPress` | `NAVIGATION` | `() => router.push(`/evidence/${item.id}`)` | wired |
| 415 | `onPress` | `NAVIGATION` | `() => router.push(`/case/${c.id}`)` | wired |

## `/intake-links` — 7 controls

`apps/mobile/app/(stack)/intake-links.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 193 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 219 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => revoke(item)` | wired |
| 224 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void openSubmissions(item)` | wired |
| 284 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void toggleArchive(item, archived)` | wired |
| 290 | `onPress` | `LOCAL_STATE` | `() => setRevealing(item)` | wired |
| 323 | `onChangeText` | `LOCAL_STATE` | `setRevealReason` | wired |
| 333 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE` | `() => void reveal()` | wired |

## `/intake/[token]` — 7 controls

`apps/mobile/app/(stack)/intake/[token].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 184 | `onChangeText` | `LOCAL_STATE` | `setPseudonym` | wired |
| 194 | `onChangeText` | `LOCAL_STATE` | `setDisplayName` | wired |
| 205 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 212 | `onPress` | `LOCAL_STATE` | `() => void submitIdentity()` | wired |
| 234 | `onPress` | `LOCAL_STATE` | `() => void acceptConsent()` | wired |
| 236 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |
| 267 | `onPress` | `NAVIGATION` | `() => router.push( `/intake/capture?token=${encodeURIComponent(token ?? "")}` + `&sid=${en` | wired |

## `/portal/[token]/work/[workflowId]` — 7 controls

`apps/mobile/app/(stack)/portal/work/[workflowId].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 152 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 163 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 195 | `onChangeText` | `LOCAL_STATE` | `setDraft` | wired |
| 206 | `onPress` | `LOCAL_STATE` | `() => void send()` | wired |
| 222 | `onChangeText` | `LOCAL_STATE` | `setNote` | wired |
| 236 | `onPress` | `LOCAL_STATE` | `() => setPending(d)` | wired |
| 252 | `onConfirm` | `LOCAL_STATE` | `() => void decide()` | wired |

## `/register` — 7 controls

`apps/mobile/app/(stack)/register.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 56 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `() => void resendVerification(sentTo)` | **UNVERIFIED** |
| 57 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |
| 71 | `onChangeText` | `LOCAL_STATE` | `setDisplayName` | wired |
| 74 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 77 | `onChangeText` | `LOCAL_STATE` | `setPassword` | wired |
| 90 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 93 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |

## `/search` — 6 controls

`apps/mobile/app/(stack)/search.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 165 | `onChangeText` | `LOCAL_STATE` | `setQ` | wired |
| 179 | `onPress` | `LOCAL_STATE` | `() => setQ(sug)` | wired |
| 188 | `onChange` | `LOCAL_STATE` | `setFilter` | wired |
| 196 | `onChange` | `LOCAL_STATE` | `setRecency` | wired |
| 212 | `onChange` | `LOCAL_STATE` | `(v: string) => setMode(v as SearchMode)` | wired |
| 266 | `onPress` | `NAVIGATION` | `navigable ? () => open(row) : undefined` | wired |

## `/org-invites/[token]/accept` — 5 controls

`apps/mobile/app/(stack)/org-invite/[token].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 115 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |
| 155 | `onPress` | `NAVIGATION` | `() => router.replace("/(tabs)")` | wired |
| 159 | `onPress` | `NAVIGATION` | `() => router.replace("/(tabs)/teams")` | wired |
| 180 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => void accept()` | wired |
| 181 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |

## `/reports` — 5 controls

`apps/mobile/app/(stack)/reports.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 133 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 151 | `onChange` | `LOCAL_STATE` | `setFilter` | wired |
| 181 | `onPress` | `LOCAL_STATE` | `() => setFilter("all")` | wired |
| 222 | `onPress` | `API_CALL+FEEDBACK_OR_DIALOG+LOCAL_STATE+NAVIGATION` | `() => void retrieve(row.evidenceId)` | wired |
| 227 | `onPress` | `NAVIGATION` | `() => router.push(`/evidence/${row.evidenceId}`)` | wired |

## `/auth/mfa-challenge` — 4 controls

`apps/mobile/app/(stack)/mfa.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 56 | `onChangeText` | `LOCAL_STATE` | `setCode` | wired |
| 59 | `onSubmitEditing` | `LOCAL_STATE` | `() => void submit()` | wired |
| 62 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 67 | `onPress` | `LOCAL_STATE` | `() => { setUseRecovery((v) => !v); setCode(""); setError(null); }` | wired |

## `/collaboration-teams/[teamId]` — 4 controls

`apps/mobile/app/(stack)/collaboration-team/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 82 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 83 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 90 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 160 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/workspace-people")` | wired |

## `/collaboration-teams/[teamId]/collaboration` — 4 controls

`apps/mobile/app/(stack)/collaboration-team/[id].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 82 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 83 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 90 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 160 | `onPress` | `NAVIGATION` | `() => router.push("/(stack)/workspace-people")` | wired |

## `/forgot-password` — 4 controls

`apps/mobile/app/(stack)/forgot-password.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 46 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |
| 52 | `onChangeText` | `LOCAL_STATE` | `setEmail` | wired |
| 54 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |
| 56 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |

## `/intake/[token]/capture` — 4 controls

`apps/mobile/app/(stack)/intake/capture.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 164 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 177 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |
| 206 | `onPress` | `LOCAL_STATE` | `() => void pick()` | wired |
| 225 | `onPress` | `LOCAL_STATE` | `() => void send()` | wired |

## `/portal/[token]` — 4 controls

`apps/mobile/app/(stack)/portal/[token].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 173 | `onChangeText` | `LOCAL_STATE` | `setMfaCode` | wired |
| 183 | `onPress` | `LOCAL_STATE` | `() => void authenticate(mfaCode.trim())` | wired |
| 233 | `onPress` | `NAVIGATION` | `() => router.push(`/portal/work/${a.workflowId}`)` | wired |
| 265 | `onPress` | `NAVIGATION` | `() => void signOut()` | wired |

## `/trust` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center/ai-disclosure` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center/methodology` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center/security` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center/status` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/trust-center/subprocessors` — 4 controls

`apps/mobile/app/(stack)/trust-center.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 109 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 200 | `onPress` | `API_CALL+LOCAL_STATE` | `() => void load()` | wired |
| 216 | `onPress` | `LOCAL_STATE` | `() => setOpen(a)` | wired |
| 259 | `onPress` | `LOCAL_STATE` | `() => setShowVersions((v) => !v)` | wired |

## `/verify` — 4 controls

`apps/mobile/app/verify.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 89 | `onChangeText` | `LOCAL_STATE` | `setManual` | wired |
| 89 | `onSubmitEditing` | `API_CALL+LOCAL_STATE` | `submitManual` | wired |
| 91 | `onPress` | `API_CALL+LOCAL_STATE` | `submitManual` | wired |
| 181 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(d.publicUrl as string)` | wired |

## `/verify/[token]` — 4 controls

`apps/mobile/app/verify.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 89 | `onChangeText` | `LOCAL_STATE` | `setManual` | wired |
| 89 | `onSubmitEditing` | `API_CALL+LOCAL_STATE` | `submitManual` | wired |
| 91 | `onPress` | `API_CALL+LOCAL_STATE` | `submitManual` | wired |
| 181 | `onPress` | `NAVIGATION` | `() => void Linking.openURL(d.publicUrl as string)` | wired |

## `/workspaces` — 4 controls

`apps/mobile/app/(stack)/spaces.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 79 | `onPress` | `EXTERNAL_HANDLER_UNRESOLVED` | `active \|\| busy ? undefined : onSwitch` | **UNVERIFIED** |
| 135 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 224 | `onPress` | `NAVIGATION` | `() => router.push("/organizations")` | wired |
| 229 | `onPress` | `NAVIGATION` | `() => router.push("/workspace-people")` | wired |

## `/collaboration-teams/invites/[token]/accept` — 3 controls

`apps/mobile/app/(stack)/invite/[token].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 95 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |
| 110 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => void accept()` | wired |
| 111 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |

## `/invite/[token]` — 3 controls

`apps/mobile/app/(stack)/invite/[token].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 95 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |
| 110 | `onPress` | `API_CALL+LOCAL_STATE+NAVIGATION` | `() => void accept()` | wired |
| 111 | `onPress` | `NAVIGATION` | `() => router.replace("/")` | wired |

## `/reset-password` — 3 controls

`apps/mobile/app/(stack)/reset-password.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 53 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |
| 59 | `onChangeText` | `LOCAL_STATE` | `setPassword` | wired |
| 66 | `onPress` | `LOCAL_STATE` | `() => void submit()` | wired |

## `/support` — 3 controls

`apps/mobile/app/(stack)/support.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 43 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 63 | `onPress` | `NAVIGATION` | `() => { if (path) { router.push(path); return; } if (route.destination.kind === "email") {` | wired |
| 90 | `onPress` | `NAVIGATION` | `() => router.push(`/legal/${ref.slug}`)` | wired |

## `/abuse-reporting` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/auth/mfa-recovery/verify` — 2 controls

`apps/mobile/app/(stack)/mfa-recovery-verify.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 124 | `onPress` | `NAVIGATION` | `() => state.sessionPresent ? router.replace("/(tabs)") : router.replace("/(stack)/auth")` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |

## `/data-retention` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/legal/[slug]` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/organizations` — 2 controls

`apps/mobile/app/(stack)/organizations/index.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 74 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 105 | `onPress` | `NAVIGATION` | `() => router.push(`/organizations/${org.organizationId}`)` | wired |

## `/portal` — 2 controls

`apps/mobile/app/(stack)/portal/index.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 53 | `onChangeText` | `LOCAL_STATE` | `setToken` | wired |
| 65 | `onPress` | `NAVIGATION` | `() => router.push(`/portal/${encodeURIComponent(token.trim())}`)` | wired |

## `/privacy` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/settings/legal/[slug]` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/subprocessors` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/terms` — 2 controls

`apps/mobile/app/(stack)/legal/[slug].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 112 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
| 137 | `onPress` | `NAVIGATION` | `() => router.replace("/legal")` | wired |

## `/auth/verify-email` — 1 controls

`apps/mobile/app/(stack)/verify-email.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 46 | `onPress` | `NAVIGATION` | `() => router.replace("/(stack)/auth")` | wired |

## `/billing` — 1 controls

`apps/mobile/app/(stack)/billing.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 88 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |

## `/operations/quotas` — 1 controls

`apps/mobile/app/(stack)/operations/quotas.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 138 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |

## `/portal/accept/[grantId]` — 1 controls

`apps/mobile/app/(stack)/portal/accept/[grantId].tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 110 | `onPress` | `NAVIGATION` | `() => router.replace(`/portal/${encodeURIComponent(phase.token)}`)` | wired |

## `/pricing` — 1 controls

`apps/mobile/app/(stack)/billing.tsx`

| Line | Prop | Wired to | Handler | Verdict |
|---:|---|---|---|---|
| 88 | `onPress` | `NAVIGATION` | `() => router.back()` | wired |
