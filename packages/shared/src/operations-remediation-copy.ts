/**
 * OPERATIONS REMEDIATION COPY — the reviewed German and Arabic for every
 * reader-facing string the server's remediation registry can project
 * (guidance, unsafe reasons, deep-link labels, action labels and
 * descriptions).
 *
 * The server registry stays the ONE authority for what a condition offers and
 * for its English wording; this table only translates that exact English, in
 * the gettext manner, so a German or Arabic reader is never shown English
 * guidance. `services/api/test/operations-remediation-locales.test.ts` fails
 * when the registry can project a string that has no translation here, or
 * when this table carries a string the registry no longer projects.
 *
 * Locales in scope for Operations: en (the source), de, ar.
 */

type Translation = { readonly de: string; readonly ar: string };

export const REMEDIATION_TEXT_TRANSLATIONS: Readonly<Record<string, Translation>> = Object.freeze({
  // ---- deep-link and action labels ----------------------------------------
  "Open evidence record": { de: "Beweisdatensatz öffnen", ar: "فتح سجل الدليل" },
  "Open evidence library": { de: "Beweisbibliothek öffnen", ar: "فتح مكتبة الأدلة" },
  "Open integrations": { de: "Integrationen öffnen", ar: "فتح التكاملات" },
  "Open communications": { de: "Kommunikation öffnen", ar: "فتح الاتصالات" },
  "Open governance": { de: "Governance öffnen", ar: "فتح الحوكمة" },
  "Open Security Center": { de: "Sicherheitscenter öffnen", ar: "فتح مركز الأمان" },
  "Open Billing": { de: "Abrechnung öffnen", ar: "فتح الفوترة" },
  "Open the record's artifacts": { de: "Artefakte des Datensatzes öffnen", ar: "فتح مخرجات السجل" },
  "Open Review": { de: "Prüfung öffnen", ar: "فتح المراجعة" },
  "Open the record's integrity": { de: "Integrität des Datensatzes öffnen", ar: "فتح سلامة السجل" },
  "Open SSO health": { de: "SSO-Status öffnen", ar: "فتح حالة SSO" },
  "Open the record": { de: "Datensatz öffnen", ar: "فتح السجل" },
  "Open Automation": { de: "Automatisierung öffnen", ar: "فتح الأتمتة" },
  "Resume OTS anchoring": { de: "Blockchain-Verankerung fortsetzen", ar: "استئناف الترسيخ على سلسلة الكتل" },
  "Recover report or package": { de: "Bericht oder Paket wiederherstellen", ar: "استعادة التقرير أو الحزمة" },
  "Retry after exhausted failure": { de: "Nach ausgeschöpften Versuchen erneut versuchen", ar: "إعادة المحاولة بعد استنفاد المحاولات" },

  // ---- action descriptions ----------------------------------------------
  "Re-runs the OpenTimestamps upgrade for this record. Anchoring completes on Bitcoin's schedule, not ours, so this asks the pipeline to try again — it cannot make an anchor appear.": {
    de: "Führt die OpenTimestamps-Aktualisierung für diesen Datensatz erneut aus. Die Verankerung folgt dem Zeitplan von Bitcoin, nicht unserem; dies bittet die Verarbeitung, es erneut zu versuchen — einen Anker erzwingen kann es nicht.",
    ar: "يعيد تشغيل ترقية OpenTimestamps لهذا السجل. يكتمل الترسيخ وفق جدول Bitcoin لا جدولنا، لذا يطلب هذا من المعالجة المحاولة مجددًا — ولا يمكنه إظهار ترسيخ بالقوة.",
  },
  "Rebuilds exactly what is missing or failed for this record: only the verification package when the report exists (built from the stored report after its hash is verified), or the report and its package together when there is no report. Existing versions are never replaced.": {
    de: "Erstellt genau das neu, was für diesen Datensatz fehlt oder fehlgeschlagen ist: nur das Prüfpaket, wenn der Bericht existiert (aus dem gespeicherten Bericht nach Prüfung seines Hashwerts), oder Bericht und Paket zusammen, wenn es keinen Bericht gibt. Vorhandene Versionen werden nie ersetzt.",
    ar: "يعيد إنشاء ما ينقص هذا السجل أو ما فشل تحديدًا: حزمة التحقق وحدها إن وُجد التقرير (تُبنى من التقرير المخزّن بعد التحقق من بصمته)، أو التقرير وحزمته معًا إن لم يوجد تقرير. لا تُستبدل الإصدارات الموجودة أبدًا.",
  },
  "Automatic retries for this record's report or package were exhausted. This starts a new, audited attempt beside the failed one, which is kept as history. It does not override integrity checks, legal holds or workspace restrictions.": {
    de: "Die automatischen Wiederholungen für Bericht oder Paket dieses Datensatzes sind ausgeschöpft. Dies startet einen neuen, protokollierten Versuch neben dem fehlgeschlagenen, der als Verlauf erhalten bleibt. Integritätsprüfungen, Aufbewahrungssperren und Einschränkungen des Arbeitsbereichs werden dabei nicht umgangen.",
    ar: "استُنفدت المحاولات التلقائية لتقرير هذا السجل أو حزمته. يبدأ هذا محاولة جديدة مُدقَّقة إلى جانب المحاولة الفاشلة التي تبقى في السجل التاريخي. ولا يتجاوز فحوص السلامة أو الحجز القانوني أو قيود مساحة العمل.",
  },

  // ---- evidence integrity -------------------------------------------------
  "OpenTimestamps initialization has not started successfully for this record. PROOVRA retries this automatically on a scheduled sweep; no manual timestamp creation is required and none is offered. The evidence, its signature and its RFC 3161 timestamp are unaffected.": {
    de: "Die OpenTimestamps-Initialisierung für diesen Datensatz ist noch nicht erfolgreich angelaufen. PROOVRA wiederholt dies automatisch in einem geplanten Durchlauf; eine manuelle Zeitstempelerstellung ist weder nötig noch vorgesehen. Der Beweis, seine Signatur und sein RFC-3161-Zeitstempel sind nicht betroffen.",
    ar: "لم تبدأ تهيئة OpenTimestamps لهذا السجل بنجاح بعد. يعيد PROOVRA المحاولة تلقائيًا في فحص مجدول؛ لا حاجة إلى إنشاء طابع زمني يدويًا ولا يُتاح ذلك. الدليل وتوقيعه وطابعه الزمني وفق RFC 3161 لم تتأثر.",
  },
  "OpenTimestamps anchoring is taking longer than expected. Bitcoin anchoring is inherently slow and the upgrade ladder is still running inside its budget, so this resolves on its own. No manual action is available and none is required.": {
    de: "Die OpenTimestamps-Verankerung dauert länger als erwartet. Die Verankerung in Bitcoin ist von Natur aus langsam, und die Aktualisierungen laufen noch innerhalb ihres Budgets, daher löst sich dies von selbst. Eine manuelle Aktion ist weder verfügbar noch nötig.",
    ar: "يستغرق ترسيخ OpenTimestamps وقتًا أطول من المتوقع. الترسيخ على Bitcoin بطيء بطبيعته، ولا تزال محاولات الترقية جارية ضمن حدودها، لذا يُحل هذا تلقائيًا. لا يتوفر إجراء يدوي ولا حاجة إليه.",
  },
  "This record's RFC 3161 timestamp was not validated when it was finalized, so it is not presented as a trusted timestamp. The timestamp authority is never contacted again for a finalized record. If the authority's reply was kept and only its validation failed (for example, no trust anchor was configured), an operator can validate that kept reply once timestamp trust is configured. If no reply was received, a timestamp cannot be added after the fact. The record remains valid evidence either way.": {
    de: "Der RFC-3161-Zeitstempel dieses Datensatzes wurde beim Abschluss nicht validiert und wird daher nicht als vertrauenswürdiger Zeitstempel dargestellt. Die Zeitstempelstelle wird für einen abgeschlossenen Datensatz nie erneut kontaktiert. Wurde ihre Antwort aufbewahrt und ist nur die Validierung fehlgeschlagen (etwa weil kein Vertrauensanker konfiguriert war), kann ein Operator diese aufbewahrte Antwort validieren, sobald das Zeitstempelvertrauen konfiguriert ist. Wurde keine Antwort empfangen, kann kein Zeitstempel nachträglich hinzugefügt werden. Der Datensatz bleibt in jedem Fall gültiger Beweis.",
    ar: "لم يُتحقق من الطابع الزمني لهذا السجل وفق RFC 3161 عند إنهائه، لذا لا يُعرض كطابع زمني موثوق. لا يُتصل بجهة الطوابع الزمنية مجددًا لسجل منتهٍ. إن حُفظ رد الجهة وفشل التحقق منه فقط (مثلًا لعدم ضبط مرساة ثقة)، يمكن لمشغّل التحقق من ذلك الرد المحفوظ بعد ضبط ثقة الطوابع الزمنية. وإن لم يُستلم أي رد، فلا يمكن إضافة طابع زمني لاحقًا. يبقى السجل دليلًا صالحًا في الحالتين.",
  },
  "A trusted timestamp proves when a record existed. Requesting a new one now would date the record later than it really is, so the timestamp authority is never contacted again for finalized evidence. If a timestamp reply was received at finalization, support can validate that kept reply; nothing is requested again.": {
    de: "Ein vertrauenswürdiger Zeitstempel belegt, wann ein Datensatz existierte. Einen neuen jetzt anzufordern, würde den Datensatz später datieren, als er tatsächlich ist; daher wird die Zeitstempelstelle für abgeschlossene Beweise nie erneut kontaktiert. Wurde beim Abschluss eine Antwort empfangen, kann der Support diese aufbewahrte Antwort validieren; nichts wird erneut angefordert.",
    ar: "يُثبت الطابع الزمني الموثوق متى وُجد السجل. طلب طابع جديد الآن سيؤرخ السجل بتاريخ لاحق لحقيقته، لذا لا يُتصل بجهة الطوابع الزمنية مجددًا للأدلة المنتهية. إن استُلم رد عند الإنهاء، يمكن للدعم التحقق من ذلك الرد المحفوظ؛ ولا يُطلب شيء مجددًا.",
  },
  "This record has an unresolved integrity condition. Open the record to see which proof is missing.": {
    de: "Für diesen Datensatz besteht eine ungelöste Integritätsmeldung. Öffnen Sie den Datensatz, um zu sehen, welcher Nachweis fehlt.",
    ar: "لهذا السجل حالة سلامة غير محلولة. افتح السجل لمعرفة الإثبات الناقص.",
  },
  "The recorded OpenTimestamps proof does not match this record or could not be read, so re-running anchoring cannot repair it and none is offered. The evidence, its signature and its RFC 3161 timestamp are unaffected; the record is reported without a Bitcoin anchor.": {
    de: "Der gespeicherte OpenTimestamps-Nachweis passt nicht zu diesem Datensatz oder konnte nicht gelesen werden; eine erneute Verankerung kann ihn daher nicht reparieren und wird nicht angeboten. Der Beweis, seine Signatur und sein RFC-3161-Zeitstempel sind nicht betroffen; der Datensatz wird ohne Bitcoin-Anker berichtet.",
    ar: "إثبات OpenTimestamps المسجّل لا يطابق هذا السجل أو تعذّرت قراءته، لذا لا يمكن لإعادة الترسيخ إصلاحه ولا تُعرض. الدليل وتوقيعه وطابعه الزمني وفق RFC 3161 لم تتأثر؛ ويُصدر تقرير السجل دون ترسيخ على Bitcoin.",
  },

  // ---- category guidance -------------------------------------------------
  "A capture or upload did not complete. Re-capture from the record.": {
    de: "Eine Erfassung oder ein Upload wurde nicht abgeschlossen. Erfassen Sie den Inhalt über den Datensatz erneut.",
    ar: "لم يكتمل التقاط أو رفع. أعد الالتقاط من السجل.",
  },
  "A webhook delivery failed. The integrations surface owns delivery history and its own retry.": {
    de: "Eine Webhook-Zustellung ist fehlgeschlagen. Zustellverlauf und Wiederholung liegen bei den Integrationen.",
    ar: "فشل تسليم Webhook. سجل التسليم وإعادة المحاولة من اختصاص صفحة التكاملات.",
  },
  "An integration reported a failure. Its own surface owns the retry.": {
    de: "Eine Integration hat einen Fehler gemeldet. Die Wiederholung erfolgt auf ihrer eigenen Seite.",
    ar: "أبلغ تكامل عن فشل. إعادة المحاولة من اختصاص صفحته الخاصة.",
  },
  "A message could not be delivered. Delivery history lives with the message.": {
    de: "Eine Nachricht konnte nicht zugestellt werden. Der Zustellverlauf ist bei der Nachricht einsehbar.",
    ar: "تعذّر تسليم رسالة. سجل التسليم موجود مع الرسالة.",
  },
  "A governance condition needs review on the governance surface.": {
    de: "Eine Governance-Meldung muss im Governance-Bereich geprüft werden.",
    ar: "تحتاج حالة حوكمة إلى مراجعة في صفحة الحوكمة.",
  },
  "Security Center owns this condition. Operations shows it so the workspace's unresolved work is in one place.": {
    de: "Diese Meldung gehört zum Sicherheitscenter. Operations zeigt sie, damit die offene Arbeit des Arbeitsbereichs an einem Ort ist.",
    ar: "هذه الحالة من اختصاص مركز الأمان. تعرضها العمليات ليكون العمل غير المحلول لمساحة العمل في مكان واحد.",
  },
  "Storage reported a fault. This is platform infrastructure — no workspace action will change it, and it is being handled by the platform.": {
    de: "Der Speicher hat einen Fehler gemeldet. Das ist Plattform-Infrastruktur — keine Aktion im Arbeitsbereich ändert daran etwas, und die Plattform kümmert sich darum.",
    ar: "أبلغ التخزين عن عطل. هذه بنية تحتية للمنصة — لن يغيّرها أي إجراء في مساحة العمل، والمنصة تعالجها.",
  },
  "A database fault was recorded. This is platform infrastructure and needs no workspace action.": {
    de: "Ein Datenbankfehler wurde erfasst. Das ist Plattform-Infrastruktur und erfordert keine Aktion im Arbeitsbereich.",
    ar: "سُجّل عطل في قاعدة البيانات. هذه بنية تحتية للمنصة ولا تتطلب أي إجراء في مساحة العمل.",
  },
  "Background processing reported a fault. The platform owns the queue; the affected records recover when it does.": {
    de: "Die Hintergrundverarbeitung hat einen Fehler gemeldet. Die Warteschlange gehört der Plattform; die betroffenen Datensätze erholen sich mit ihr.",
    ar: "أبلغت المعالجة الخلفية عن عطل. قائمة الانتظار من اختصاص المنصة؛ وتتعافى السجلات المتأثرة عند تعافيها.",
  },
  "An AI-assisted step did not complete. Nothing evidential depends on it, and the record is unaffected.": {
    de: "Ein KI-gestützter Schritt wurde nicht abgeschlossen. Nichts Beweisrelevantes hängt davon ab, und der Datensatz ist nicht betroffen.",
    ar: "لم تكتمل خطوة بمساعدة الذكاء الاصطناعي. لا يعتمد عليها أي شيء استدلالي، والسجل لم يتأثر.",
  },
  "A reconciliation sweep reported a discrepancy. It re-runs on its own schedule.": {
    de: "Ein Abgleichslauf hat eine Abweichung gemeldet. Er läuft nach eigenem Zeitplan erneut.",
    ar: "أبلغ فحص مطابقة عن تباين. يُعاد تشغيله وفق جدوله الخاص.",
  },

  // ---- source guidance ----------------------------------------------------
  "Billing owns this. The payment provider has not yet confirmed that this storage add-on is stopped, so it may still be charging. PROOVRA retries automatically. Only the person who pays for the add-on can act: from their Billing page they can retry stopping it now or contact support. This closes on its own when the provider confirms the add-on is stopped; it cannot be closed by hand while the add-on may still be charging.": {
    de: "Dies gehört zur Abrechnung. Der Zahlungsanbieter hat noch nicht bestätigt, dass diese Speichererweiterung beendet ist; sie könnte also noch berechnet werden. PROOVRA wiederholt dies automatisch. Handeln kann nur die Person, die die Erweiterung bezahlt: Auf ihrer Abrechnungsseite kann sie das Beenden jetzt erneut versuchen oder den Support kontaktieren. Dies schließt sich von selbst, sobald der Anbieter das Beenden bestätigt; solange noch Kosten anfallen könnten, kann es nicht manuell geschlossen werden.",
    ar: "هذا من اختصاص الفوترة. لم يؤكد مزوّد الدفع بعد إيقاف إضافة التخزين هذه، لذا قد لا تزال تُحتسب. يعيد PROOVRA المحاولة تلقائيًا. لا يمكن التصرف إلا لمن يدفع ثمن الإضافة: من صفحة الفوترة الخاصة به يمكنه إعادة محاولة الإيقاف الآن أو التواصل مع الدعم. تُغلق هذه الحالة تلقائيًا عندما يؤكد المزوّد الإيقاف؛ ولا يمكن إغلاقها يدويًا ما دامت الإضافة قد تُحتسب.",
  },
  "This record's governance (for example a legal hold, a destruction review or unresolved storage drift) does not allow a verification package to be built. The record's governance panel shows which. This closes when the record becomes eligible or a package exists.": {
    de: "Die Governance dieses Datensatzes (etwa eine Aufbewahrungssperre, eine Vernichtungsprüfung oder eine ungeklärte Speicherabweichung) erlaubt kein Prüfpaket. Der Governance-Bereich des Datensatzes zeigt, welche. Dies schließt sich, sobald der Datensatz berechtigt ist oder ein Paket existiert.",
    ar: "حوكمة هذا السجل (مثل حجز قانوني أو مراجعة إتلاف أو انحراف تخزين غير محلول) لا تسمح ببناء حزمة تحقق. تُظهر لوحة حوكمة السجل السبب. تُغلق هذه الحالة عندما يصبح السجل مؤهلًا أو توجد حزمة.",
  },
  "More reports are waiting to be generated than the backlog threshold. They are processed in order; this closes when the waiting count falls below the threshold.": {
    de: "Mehr Berichte warten auf ihre Erstellung, als der Rückstau-Schwellenwert zulässt. Sie werden der Reihe nach verarbeitet; dies schließt sich, wenn die Anzahl unter den Schwellenwert fällt.",
    ar: "عدد التقارير المنتظرة للإنشاء يتجاوز حد التراكم. تُعالَج بالترتيب؛ وتُغلق هذه الحالة عندما ينخفض العدد عن الحد.",
  },
  "More verification packages are waiting to be built than the backlog threshold. They are processed in order; this closes when the waiting count falls below the threshold.": {
    de: "Mehr Prüfpakete warten auf ihre Erstellung, als der Rückstau-Schwellenwert zulässt. Sie werden der Reihe nach verarbeitet; dies schließt sich, wenn die Anzahl unter den Schwellenwert fällt.",
    ar: "عدد حزم التحقق المنتظرة للبناء يتجاوز حد التراكم. تُعالَج بالترتيب؛ وتُغلق هذه الحالة عندما ينخفض العدد عن الحد.",
  },
  "Signed records have gone longer than expected without a report. Generate their reports from the records; this closes when the count falls below the threshold.": {
    de: "Signierte Datensätze sind länger als erwartet ohne Bericht. Erstellen Sie ihre Berichte über die Datensätze; dies schließt sich, wenn die Anzahl unter den Schwellenwert fällt.",
    ar: "ظلت سجلات موقّعة دون تقرير أطول من المتوقع. أنشئ تقاريرها من السجلات؛ وتُغلق هذه الحالة عندما ينخفض العدد عن الحد.",
  },
  "Reviews have been waiting longer than the review window. Assign or complete them in Review; this closes when the waiting count falls below the threshold.": {
    de: "Prüfungen warten länger als das Prüffenster. Weisen Sie sie in der Prüfung zu oder schließen Sie sie ab; dies schließt sich, wenn die Anzahl unter den Schwellenwert fällt.",
    ar: "تنتظر مراجعات أطول من نافذة المراجعة. أسندها أو أكملها في المراجعة؛ وتُغلق هذه الحالة عندما ينخفض العدد عن الحد.",
  },
  "A review was escalated. This closes when the escalated review is completed.": {
    de: "Eine Prüfung wurde eskaliert. Dies schließt sich, wenn die eskalierte Prüfung abgeschlossen ist.",
    ar: "صُعّدت مراجعة. تُغلق هذه الحالة عند اكتمال المراجعة المصعّدة.",
  },
  "Comments and annotations have stayed unresolved longer than the coordination window. Resolve them on their records and cases; this closes when the unresolved count falls below the threshold.": {
    de: "Kommentare und Anmerkungen sind länger als das Abstimmungsfenster ungelöst. Lösen Sie sie bei ihren Datensätzen und Fällen; dies schließt sich, wenn die Anzahl unter den Schwellenwert fällt.",
    ar: "ظلت تعليقات وتوضيحات دون حل أطول من نافذة التنسيق. احسمها في سجلاتها وقضاياها؛ وتُغلق هذه الحالة عندما ينخفض العدد عن الحد.",
  },
  "The immutable-storage protection on this record's stored object did not match its retention or legal-hold state at the last reconciliation. The platform reconciler re-checks it; this closes when a reconciliation finds the protection in place. Packages for the record are withheld until then.": {
    de: "Der Schutz des unveränderlichen Speichers für das gespeicherte Objekt dieses Datensatzes entsprach beim letzten Abgleich nicht seinem Aufbewahrungs- oder Sperrstatus. Der Plattformabgleich prüft dies erneut; dies schließt sich, wenn ein Abgleich den Schutz vorfindet. Bis dahin werden Pakete für den Datensatz zurückgehalten.",
    ar: "لم تطابق حماية التخزين غير القابل للتعديل لكائن هذا السجل حالة الاحتفاظ أو الحجز القانوني عند آخر مطابقة. تعيد مطابقة المنصة فحصها؛ وتُغلق هذه الحالة عندما تجد مطابقةٌ الحماية قائمة. تُحجب حزم السجل حتى ذلك الحين.",
  },
  "Sign-ins through this identity provider have been failing. This closes on the first successful sign-in through it.": {
    de: "Anmeldungen über diesen Identitätsanbieter schlagen fehl. Dies schließt sich bei der ersten erfolgreichen Anmeldung darüber.",
    ar: "تفشل عمليات تسجيل الدخول عبر مزوّد الهوية هذا. تُغلق هذه الحالة عند أول تسجيل دخول ناجح عبره.",
  },
  "The upload service failed while starting or resuming an upload. The person uploading saw an error at the time and can try again; nothing needs to be done here unless it keeps happening, in which case contact support.": {
    de: "Der Upload-Dienst ist beim Starten oder Fortsetzen eines Uploads fehlgeschlagen. Die hochladende Person hat dabei eine Fehlermeldung gesehen und kann es erneut versuchen; hier ist nichts zu tun, es sei denn, es tritt wiederholt auf — dann wenden Sie sich an den Support.",
    ar: "أخفقت خدمة الرفع أثناء بدء رفع أو استئنافه. رأى من يرفع الملف رسالة خطأ حينها ويمكنه المحاولة مجددًا؛ لا حاجة لأي إجراء هنا ما لم يتكرر ذلك، وعندها تواصل مع الدعم.",
  },
  "No upload progress has been recorded for this record past the inactivity threshold. The person uploading can resume it; an upload that is not resumed is closed as abandoned. This closes on its own when the upload completes, is resumed or abandoned, or the record is finalized or deleted.": {
    de: "Für diesen Datensatz wurde über die Inaktivitätsschwelle hinaus kein Upload-Fortschritt erfasst. Die hochladende Person kann ihn fortsetzen; ein nicht fortgesetzter Upload wird als abgebrochen geschlossen. Dies schließt sich von selbst, wenn der Upload abgeschlossen, fortgesetzt oder abgebrochen wird oder der Datensatz abgeschlossen oder gelöscht wird.",
    ar: "لم يُسجَّل أي تقدم في رفع هذا السجل بعد تجاوز حد الخمول. يمكن لمن يرفع الملف استئنافه؛ والرفع الذي لا يُستأنف يُغلق كمتروك. تُغلق هذه الحالة تلقائيًا عند اكتمال الرفع أو استئنافه أو تركه، أو عند إنهاء السجل أو حذفه.",
  },
  "Automation stopped delivering to this webhook destination after repeated failed deliveries. Fix the receiving endpoint, then re-enable the destination in Automation; this closes when the destination is enabled again.": {
    de: "Die Automatisierung hat die Zustellung an dieses Webhook-Ziel nach wiederholten Fehlschlägen eingestellt. Beheben Sie den empfangenden Endpunkt und aktivieren Sie das Ziel in der Automatisierung erneut; dies schließt sich, sobald das Ziel wieder aktiviert ist.",
    ar: "أوقفت الأتمتة التسليم إلى وجهة Webhook هذه بعد إخفاقات متكررة. أصلح نقطة الاستقبال ثم أعد تفعيل الوجهة في الأتمتة؛ وتُغلق هذه الحالة عند إعادة تفعيلها.",
  },
  "Search indexing for this workspace is failing or behind. Records are unaffected; search results may be incomplete until indexing catches up, which the platform retries automatically.": {
    de: "Die Suchindizierung dieses Arbeitsbereichs schlägt fehl oder hinkt hinterher. Datensätze sind nicht betroffen; Suchergebnisse können unvollständig sein, bis die Indizierung aufholt, was die Plattform automatisch erneut versucht.",
    ar: "فهرسة البحث لمساحة العمل هذه تفشل أو متأخرة. السجلات لم تتأثر؛ وقد تكون نتائج البحث ناقصة حتى تلحق الفهرسة، وتعيد المنصة المحاولة تلقائيًا.",
  },
  "This is history recorded by an earlier version of Operations. There is nothing to repair here. Uploads are now checked one at a time, and a genuinely stalled upload appears as its own condition.": {
    de: "Dies ist ein Verlaufseintrag einer früheren Version von Operations. Hier ist nichts zu reparieren. Uploads werden jetzt einzeln geprüft, und ein tatsächlich feststeckender Upload erscheint als eigene Meldung.",
    ar: "هذا سجل تاريخي سجّله إصدار سابق من العمليات. لا يوجد ما يُصلح هنا. تُفحص عمليات الرفع الآن كلٌّ على حدة، ويظهر الرفع المتوقف فعلًا كحالة مستقلة.",
  },
});

/**
 * The reader's text for a remediation string. English, an unknown locale, or a
 * string with no reviewed translation renders the server's own English — the
 * gate keeps the last case from happening.
 */
export function localizeRemediationText(locale: string | null | undefined, text: string | null | undefined): string | null {
  if (text == null) return null;
  const loc = typeof locale === "string" ? locale.toLowerCase().slice(0, 2) : "en";
  if (loc !== "de" && loc !== "ar") return text;
  return REMEDIATION_TEXT_TRANSLATIONS[text]?.[loc] ?? text;
}

/** The reader-facing fields of a projected remediation (web and mobile shapes). */
type LocalizableRemediation = {
  guidance: string | null;
  unsafeReason: string | null;
  deepLink: { label: string } | null;
  actions: ReadonlyArray<{ label: string; description: string }>;
};

/**
 * The server's projected remediation in the reader's language. Only the words
 * change: ids, hrefs, permissions and every decision stay exactly as projected.
 */
export function localizeProjectedRemediation<T extends LocalizableRemediation>(locale: string | null | undefined, r: T): T {
  const t = (s: string) => localizeRemediationText(locale, s) ?? s;
  return {
    ...r,
    guidance: r.guidance == null ? r.guidance : t(r.guidance),
    unsafeReason: r.unsafeReason == null ? r.unsafeReason : t(r.unsafeReason),
    deepLink: r.deepLink ? { ...r.deepLink, label: t(r.deepLink.label) } : r.deepLink,
    actions: r.actions.map((a) => ({ ...a, label: t(a.label), description: t(a.description) })),
  };
}
