# Insurance Evidence Guide

**Audience:** claimants, field agents, third parties submitting evidence to a PROOVRA-powered insurance investigation.

---

## 1. What PROOVRA does for an insurance claim

PROOVRA helps your insurer's investigations team organise the evidence you submit for a claim. It records:

- the bytes of each file you upload (and a cryptographic hash so any later change is detectable),
- when and where it was captured (when your device shares that data),
- who handled it inside the insurer's team (a custody chain).

## 2. What PROOVRA does NOT do

- It does not decide whether the substance of your claim is accurate or not.
- It does not decide whether anyone is at fault.
- It does not make a legal-admissibility claim about your evidence.
- It does not share your evidence with anyone outside your insurer's investigation team without their explicit authorization.

PROOVRA's job is to make sure the evidence you submitted on day one is the same evidence the insurer's team is looking at on day ninety.

## 3. What you might be asked for

Depending on your claim type (auto, property, injury, cyber, or another category), you may be asked to upload a bounded set of evidence items. Common examples:

- a wide shot of the scene,
- close-up images of any damage,
- a vehicle identifier (plate or VIN), if relevant,
- a repair estimate or invoice,
- supporting documents you choose to share.

You will only be asked for evidence that is relevant to your claim type. PROOVRA never requires you to share medical content; if your claim involves an injury, sharing medical documentation is always optional.

## 4. Capture quality tips

- Capture in the original app PROOVRA's intake link opens. Re-uploaded screenshots lose useful provenance signals.
- Where appropriate, allow your device's location and timestamp to be embedded in the image.
- Keep the original file. Do not edit it before uploading.

## 5. If the investigator asks for more evidence

The investigator may send you a follow-up link asking for one or two specific items. The link is bounded:

- it points at the specific items the investigator requested,
- it expires after a configured period,
- it never asks you to provide anything outside that bounded list.

You can ignore a follow-up link; doing so does NOT automatically classify your claim as anything. The investigator will follow up via the normal communication channel your insurer uses.

## 6. Your privacy

- Your claimant name and contact information are treated as privacy-gated fields. They are redacted by default inside the investigator's workspace and only revealed to authorised reviewers.
- The evidence you upload is never used to train AI models.
- The evidence you upload is bounded to the case it belongs to.

## 7. Questions

If you have questions, contact your insurer directly. PROOVRA is the integrity platform — questions about the claim itself are handled by your insurance company.
