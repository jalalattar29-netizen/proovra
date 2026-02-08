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
  return (
    <Tag className={`silver-watermark-section ${className}`.trim()} {...rest}>
      <img
        src="/brand/silver-watermark-combined.png"
        alt=""
        aria-hidden="true"
        className="silver-watermark-image"
      />
      <div className="silver-watermark-content">{children}</div>
    </Tag>
  );
}
