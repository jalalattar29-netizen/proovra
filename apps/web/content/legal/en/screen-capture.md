# How Screen Capture Works

Last Updated: 2026-10-01

This page explains how PROOVRA's screen capture channels preserve what a device or browser displayed, what they record, how integrity is established after ingestion, and what screen capture does and does not establish.

It covers three channels: screen capture and continuous screen recording in the PROOVRA Android app, screen recording in the PROOVRA iOS app, and browser screen recording on the PROOVRA web Capture page. It is read together with the Privacy Policy, the Data Retention Policy, the Evidence Handling Policy, the Verification Methodology, the Verification Disclaimer, and the Direct Web Capture page.

## 1. WHAT SCREEN CAPTURE IS

Screen capture preserves the image your screen showed, as your device's operating system or browser handed it to PROOVRA.

- **Android.** The app asks Android for screen-capture permission (MediaProjection). Android shows its own consent dialog, and continuous recording runs with a visible notification for as long as it records. A single screen capture records one image; continuous recording records video in consecutive segments.
- **iOS.** The app starts a screen broadcast through Apple's broadcast picker (ReplayKit). iOS shows its own recording indicator for as long as the broadcast runs.
- **Web browser.** The Capture page asks your browser to share a screen, window, or tab. The browser shows its own sharing dialog and indicator. The recording is added to your capture session as a video file and finalized through the same path as any other upload.

Capture starts only when you start it and grant the operating system's or browser's permission. You can stop it at any time, and the operating system or browser can end it (for example when you revoke permission, lock the device, or close the shared tab).

## 2. WHAT IS RECORDED

Depending on the channel, screen capture may record:

- the screen image (a still image, or video segments) as the operating system or browser delivered it
- the time PROOVRA received each part (server time), alongside the start and stop times your device reports from its own clock
- for continuous recording, a manifest that lists each segment in order with its digest, so a missing, duplicated, or reordered segment is detectable
- the limitations the app or browser detected — for example a recording that was cut short, a segment that failed to upload, or a capture surface the browser reported (screen, window, or tab)
- technical metadata produced during processing, such as content type, size, duration, and resolution

The mobile channels record the screen only; they do not record microphone or device audio. Browser screen recording includes audio only if you explicitly allow audio sharing in the browser's dialog, and the record states whether audio was included.

Screen capture records what was displayed. Anything visible on the screen while capture runs — including notifications, messages, and personal data of other people — can be included. Deciding whether it is lawful and appropriate to record a screen remains your responsibility.

## 3. HOW INTEGRITY IS ESTABLISHED AFTER INGESTION

After the bytes reach PROOVRA, the canonical evidence lifecycle applies:

- PROOVRA **independently recomputes the digest** of every uploaded part on the server rather than trusting a digest declared by the device or browser;
- for continuous recording, the server checks the uploaded segments against the manifest, and a recording with gaps is recorded as incomplete rather than presented as whole;
- the recorded integrity state is established when the capture is completed on the server — it covers the bytes from the moment PROOVRA received them, not how they were produced on the device.

From that point the material is handled like any other Evidence Record under the Evidence Handling Policy and the Verification Methodology, including retention and legal hold.

## 4. THE TRUST BOUNDARY — WHAT SCREEN CAPTURE DOES NOT ESTABLISH

PROOVRA records how and when material was received and preserved. It does not establish that the content is true, who authored it, the identity of people shown, or that events occurred as depicted.

For screen capture specifically:

- **No device or operating-system attestation.** PROOVRA does not receive a cryptographic statement from the operating system or browser that the image is an unaltered screen image. A modified device, app, or browser cannot be ruled out.
- **Content is not proven true.** An app, website, or account shown on screen is not proven genuine, and a message shown is not proven to have been sent or received.
- **Browser capture surface is browser-reported.** Whether a web recording shows a whole screen, a window, or a tab is what the browser reported; PROOVRA does not verify it.
- **Continuity is bounded.** A continuous recording shows what was recorded while it ran. Periods before it started, after it stopped, or while the operating system paused it are not covered.

Legal admissibility and evidentiary weight require separate review.

## 5. PRIVACY AND RETENTION

Screen capture is always user-initiated. PROOVRA does not record screens in the background and does not monitor device use.

Screen recordings are personal data where they show identifiable people. They are processed under the Privacy Policy, retained under the Data Retention Policy and your workspace's retention settings, and can be placed under legal hold like any other Evidence Record.

You are responsible for having a lawful basis for recording and for obtaining any consent required under applicable recording, surveillance, privacy, telecommunications, and personality-rights laws.

## 6. CONTACT

Questions about this page can be sent through the Support page. Privacy requests follow the process described on the Privacy Requests page.
