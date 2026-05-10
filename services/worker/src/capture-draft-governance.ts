import * as prismaPkg from "@prisma/client";

export function shouldExpireCaptureDraft(params: {
  status: prismaPkg.CaptureSessionStatus | null | undefined;
  expiresAtUtc: Date | null | undefined;
  now?: Date;
}): boolean {
  const now = params.now ?? new Date();
  return (
    params.status === prismaPkg.CaptureSessionStatus.DRAFT &&
    params.expiresAtUtc instanceof Date &&
    params.expiresAtUtc.getTime() < now.getTime()
  );
}
