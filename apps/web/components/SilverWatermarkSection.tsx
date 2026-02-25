import type { ReactNode, HTMLAttributes } from "react";

type SilverWatermarkSectionProps = HTMLAttributes<HTMLElement> & {
  as?: "section" | "div" | "main";
  children: ReactNode;
};

export function SilverWatermarkSection({
  as = "section",
  className = "",
  children,
  ...rest
}: SilverWatermarkSectionProps) {
  const Tag = as;

  // غيّر الرقم لما تغيّر الصورة (cache-bust)
  const WM_VERSION = "20260225-1";

  return (
    <Tag className={`silver-watermark-section ${className}`.trim()} {...rest}>
      <img
        src={`/brand/silver-watermark-combined.png?v=${WM_VERSION}`}
        alt=""
        aria-hidden="true"
        className="silver-watermark-image watermark-neon"
      />
      <div className="silver-watermark-content">{children}</div>
    </Tag>
  );
}