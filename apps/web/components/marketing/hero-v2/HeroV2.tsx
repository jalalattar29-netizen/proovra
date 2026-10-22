import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  AudioLines,
  Camera,
  CarFront,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Ellipsis,
  FileCheck2,
  FileText,
  Fingerprint,
  Globe,
  ImageIcon,
  Layers,
  Link2,
  MapPin,
  Mic,
  Monitor,
  Play,
  Scale,
  ScanLine,
  Search,
  ShieldCheck,
  Users,
  UsersRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import { MARKETING_ASSETS, MARKETING_LINKS } from "../tokens";
import { HERO_V2_CSS } from "./heroV2.styles";

/*
 * One icon system for the whole hero: Lucide, one stroke weight. Icons are
 * sized by their container's CSS (in stage units inside the composition), so
 * the stroke stays proportional at every scale. The only exception is the
 * tick inside the small status discs, which needs a heavier stroke to read at
 * 10–13px.
 */
const STROKE = 1.75;
const TICK_STROKE = 2.75;

const ASSET = "/images/home/hero-v2";
const IMG = {
  city: `${ASSET}/background/hero-city-background.webp.png`,
  glow: `${ASSET}/evidence/evidence-glow.png.png`,
  pedestal: `${ASSET}/evidence/evidence-pedestal.png.png`,
  scene: `${ASSET}/evidence/evidence-main-scene.webp.png`,
  report: `${ASSET}/outputs/report-preview.webp.png`,
};

/** One reference pixel of the 1020 × 610 stage. */
const u = (n: number) => `calc(var(--u) * ${n})`;
const place = (left: number, top: number, width?: number, height?: number): CSSProperties => ({
  left: u(left),
  top: u(top),
  ...(width === undefined ? {} : { width: u(width) }),
  ...(height === undefined ? {} : { height: u(height) }),
});

/* ------------------------------------------------------------------ content */

type Source = {
  key: string;
  label: string;
  Icon: LucideIcon;
  image: string;
  formats: string[];
  /** object-position that keeps the subject in frame. */
  focus: string;
  /** Connector node on the flow line, in stage coordinates. */
  node: { x: number; y: number; Icon: LucideIcon; violet?: boolean };
  /** Where the line meets the evidence record's glass frame. */
  enter: number;
};

const SOURCE_TOP = [14, 122, 230, 338, 446];
const SOURCE_LEFT = 15;
const SOURCE_W = 198;
const SOURCE_H = 90;
/** Flow lines leave from the mid-height of the card's right edge (its hinge). */
const SOURCE_ANCHOR_Y = SOURCE_H / 2;
/*
 * Lines start and end a few units inside the cards they connect. They are
 * drawn beneath the cards, so the overlap is hidden, and it absorbs the small
 * edge movement the 3D tilts introduce — no line ever stops short of a card.
 */
const TUCK = 6;
/** The record's glass frame glows past its edge; end its lines safely beneath it. */
const RECORD_TUCK = 12;

const SOURCES: Source[] = [
  {
    key: "photo",
    label: "Photos & Videos",
    Icon: Camera,
    image: `${ASSET}/sources/source-photo-video.webp.png`,
    formats: ["JPG", "PNG", "MP4", "MOV"],
    focus: "50% 42%",
    node: { x: 302, y: 128, Icon: ImageIcon },
    enter: 158,
  },
  {
    key: "documents",
    label: "Documents",
    Icon: FileText,
    image: `${ASSET}/sources/source-documents.webp.png`,
    formats: ["PDF", "DOC", "XLS", "TXT"],
    focus: "45% 50%",
    node: { x: 300, y: 214, Icon: FileText, violet: true },
    enter: 226,
  },
  {
    key: "audio",
    label: "Audio Recordings",
    Icon: Mic,
    image: `${ASSET}/sources/source-audio-waveform.webp.png`,
    formats: ["MP3", "WAV", "M4A"],
    focus: "50% 50%",
    node: { x: 262, y: 286, Icon: AudioLines },
    enter: 290,
  },
  {
    key: "online",
    label: "Screenshots & Online Content",
    Icon: Monitor,
    image: `${ASSET}/sources/source-online-content.webp.png`,
    formats: ["URL", "HTML", "PNG"],
    focus: "50% 45%",
    node: { x: 302, y: 382, Icon: Link2 },
    enter: 352,
  },
  {
    key: "other",
    label: "Other Sources",
    Icon: Layers,
    image: `${ASSET}/sources/source-other-sources.webp.png`,
    formats: ["DRONE", "CCTV", "SCAN", "MORE"],
    focus: "50% 62%",
    node: { x: 254, y: 446, Icon: ScanLine, violet: true },
    enter: 414,
  },
];

const RECORD = { left: 340, top: 10, width: 308, height: 530 };
const OUTPUT_LEFT = 715;
const OUTPUT = {
  verification: { top: 12, height: 158, leave: 128 },
  reports: { top: 178, height: 110, leave: 236 },
  sharing: { top: 298, height: 112, leave: 336 },
  workspace: { top: 420, height: 115, leave: 430 },
} as const;

const WORKFLOW = ["Capture", "Preserve", "Verify", "Manage", "Share"];

const SAMPLE_LINK = "https://verify.proovra.com/7f9k3a";

const AVATARS = [1, 2, 3, 4].map((n) => `${ASSET}/avatars/avatar-0${n}.webp.png`);

const ASSURANCES = ["No technical expertise required", "Secure by design", "Built for professionals"];

const INDUSTRIES = [
  {
    title: "Insurance Claims",
    body: "Substantiate claims with verifiable evidence.",
    Icon: CarFront,
    image: `${ASSET}/industries/industry-insurance.webp.png`,
    focus: "50% 62%",
    href: MARKETING_LINKS.industries.insurance,
  },
  {
    title: "Legal Matters",
    body: "Build cases on verifiable digital evidence.",
    Icon: Scale,
    image: `${ASSET}/industries/industry-legal.webp.png`,
    focus: "50% 38%",
    href: MARKETING_LINKS.industries.legal,
  },
  {
    title: "Investigations",
    body: "Preserve evidence with a clear custody record.",
    Icon: Search,
    image: `${ASSET}/industries/industry-investigations.webp.png`,
    focus: "50% 40%",
    href: MARKETING_LINKS.industries.investigations,
  },
  {
    title: "Compliance & Audits",
    body: "Support regulatory and internal requirements.",
    Icon: ShieldCheck,
    image: `${ASSET}/industries/industry-compliance.webp.png`,
    focus: "50% 45%",
    href: MARKETING_LINKS.industries.compliance,
  },
  {
    title: "Media & Journalism",
    body: "Capture and preserve original content.",
    Icon: Video,
    image: `${ASSET}/industries/industry-journalism.webp.png`,
    focus: "35% 38%",
    href: MARKETING_LINKS.industries.journalism,
  },
  {
    title: "Corporate Security",
    body: "Manage evidence across teams and departments.",
    Icon: UsersRound,
    image: `${ASSET}/industries/industry-corporate.webpindustry-corporate.webp.png`,
    focus: "50% 42%",
    href: MARKETING_LINKS.solutions.government,
  },
];

const AUDIENCE = [
  { label: "Legal", Icon: Scale },
  { label: "Investigations", Icon: Search },
  { label: "Compliance", Icon: ShieldCheck },
  { label: "Insurance", Icon: CarFront },
  { label: "Corporate Security", Icon: UsersRound },
  { label: "Media & Journalism", Icon: Video },
];

/* ------------------------------------------------------------- flow lines */

const sCurve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = x1 + (x2 - x1) / 2;
  return `C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

function sourcePath(i: number, dy = 0, spread = 0) {
  const src = SOURCES[i];
  const x0 = SOURCE_LEFT + SOURCE_W - TUCK;
  const y0 = SOURCE_TOP[i] + SOURCE_ANCHOR_Y + dy;
  const { x, y } = src.node;
  return `M ${x0} ${y0} ${sCurve(x0, y0, x, y + spread)} ${sCurve(x, y + spread, RECORD.left + RECORD_TUCK, src.enter + dy * 0.6)}`;
}

function outputPath(leave: number, top: number, height: number, dy = 0) {
  const x0 = RECORD.left + RECORD.width - RECORD_TUCK;
  const y1 = top + height / 2 + dy;
  return `M ${x0} ${leave + dy * 0.5} ${sCurve(x0, leave + dy * 0.5, OUTPUT_LEFT + TUCK, y1)}`;
}

function FlowLines() {
  const outputs = Object.values(OUTPUT);
  return (
    <svg className="hv2-flow" viewBox="0 0 1020 610" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hv2-in" gradientUnits="userSpaceOnUse" x1="213" y1="0" x2="340" y2="0">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="0.55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="hv2-in-soft" gradientUnits="userSpaceOnUse" x1="213" y1="0" x2="340" y2="0">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#60a5fa" />
        </linearGradient>
        <linearGradient id="hv2-out" gradientUnits="userSpaceOnUse" x1="648" y1="0" x2="715" y2="0">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="0.5" stopColor="#4f7dff" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
        <filter id="hv2-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Luminous band under each connection. */}
      <g fill="none" strokeWidth="12" strokeLinecap="round" opacity="0.22">
        {SOURCES.map((src, i) => (
          <path key={src.key} d={sourcePath(i)} stroke="url(#hv2-in)" />
        ))}
        {outputs.map((o) => (
          <path key={o.top} d={outputPath(o.leave, o.top, o.height)} stroke="url(#hv2-out)" />
        ))}
      </g>

      {/* Fibre strands either side of each connection. */}
      <g fill="none" stroke="url(#hv2-in-soft)" strokeWidth="1.3" opacity="0.85" filter="url(#hv2-glow)">
        {SOURCES.map((src, i) => (
          <g key={src.key}>
            <path d={sourcePath(i, -5, -6)} />
            <path d={sourcePath(i, 5, 6)} />
            <path d={sourcePath(i, -10, 9)} opacity="0.6" />
          </g>
        ))}
      </g>
      <g fill="none" stroke="url(#hv2-out)" strokeWidth="1.3" opacity="0.8" filter="url(#hv2-glow)">
        {outputs.map((o) => (
          <g key={o.top}>
            <path d={outputPath(o.leave, o.top, o.height, -7)} />
            <path d={outputPath(o.leave, o.top, o.height, 7)} />
          </g>
        ))}
      </g>

      {/* Primary connections. */}
      <g fill="none" strokeWidth="2.8" strokeLinecap="round" filter="url(#hv2-glow)">
        {SOURCES.map((src, i) => (
          <path key={src.key} id={`hv2-in-${i}`} d={sourcePath(i)} stroke="url(#hv2-in)" />
        ))}
        {outputs.map((o, i) => (
          <path key={o.top} id={`hv2-out-${i}`} d={outputPath(o.leave, o.top, o.height)} stroke="url(#hv2-out)" />
        ))}
      </g>

      {/* Terminals where each line meets a card. */}
      <g fill="#ffffff" stroke="#60a5fa" strokeWidth="1.4">
        {SOURCES.map((src, i) => (
          <circle key={src.key} cx={SOURCE_LEFT + SOURCE_W} cy={SOURCE_TOP[i] + SOURCE_ANCHOR_Y} r="2.6" />
        ))}
        {outputs.map((o) => (
          <circle key={o.top} cx={OUTPUT_LEFT} cy={o.top + o.height / 2} r="2.6" />
        ))}
      </g>

      {/* Evidence moving along each connection. */}
      <g className="hv2-pulses" fill="#e0f2fe" filter="url(#hv2-glow)">
        {SOURCES.map((src, i) => (
          <circle key={src.key} r="2.2">
            <animateMotion dur="3.6s" begin={`${i * 0.7}s`} repeatCount="indefinite">
              <mpath href={`#hv2-in-${i}`} />
            </animateMotion>
          </circle>
        ))}
        {outputs.map((o, i) => (
          <circle key={o.top} r="2">
            <animateMotion dur="2.4s" begin={`${1.2 + i * 0.6}s`} repeatCount="indefinite">
              <mpath href={`#hv2-out-${i}`} />
            </animateMotion>
          </circle>
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------- components */

function Tick() {
  return (
    <span className="hv2-pillMark">
      <Check strokeWidth={TICK_STROKE} aria-hidden="true" />
    </span>
  );
}

function StatusPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`hv2-pill ${className ?? ""}`}>
      <Tick />
      {children}
    </span>
  );
}

/*
 * One floating glass card per source: the photo fills it, the format chips sit
 * in its upper-right corner and the source name is a slim glass label on its
 * lower-left edge — both kept to the margins so the subject stays clear. In
 * the stage the whole card turns toward the evidence record (see .stage
 * .source), hinged on its right edge so the flow line's start never moves.
 */
function SourceCard({ source, style }: { source: Source; style?: CSSProperties }) {
  const { Icon } = source;
  return (
    <div className="hv2-source" style={style}>
      <div className="hv2-sourceMedia">
        <Image src={source.image} alt="" fill sizes="220px" style={{ objectPosition: source.focus }} />
      </div>
      <div className="hv2-sourceFormats">
        {source.formats.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>
      <span className="hv2-sourceLabel">
        <Icon strokeWidth={STROKE} aria-hidden="true" />
        {source.label}
      </span>
    </div>
  );
}

function RecordRow({
  Icon,
  title,
  value,
  trail,
}: {
  Icon: LucideIcon;
  title: ReactNode;
  value: string;
  trail?: ReactNode;
}) {
  return (
    <li className="hv2-recordRow">
      <span className="hv2-recordRowIcon">
        <Icon strokeWidth={STROKE} aria-hidden="true" />
      </span>
      <span className="hv2-recordRowText">
        <span className="hv2-recordRowTitle">{title}</span>
        <span className="hv2-recordRowValue">{value}</span>
      </span>
      {trail}
    </li>
  );
}

function EvidenceRecord({ style, priority }: { style?: CSSProperties; priority?: boolean }) {
  return (
    <div className="hv2-record" style={style}>
      <div className="hv2-recordFrame" />
      <div className="hv2-recordCard">
        <div className="hv2-recordHead">
          <span className="hv2-recordBrand">
            <img src={MARKETING_ASSETS.brand.mark} alt="" />
            PROOVRA
          </span>
          {/* Per-signal wording: the record's integrity check, not an overall verdict. */}
          <StatusPill>Integrity verified</StatusPill>
        </div>

        <div className="hv2-recordMedia">
          <Image src={IMG.scene} alt="" fill sizes="(min-width: 1024px) 260px, 320px" priority={priority} />
          <div className="hv2-recordMediaShade" />
          <span className="hv2-play">
            <Play strokeWidth={STROKE} fill="currentColor" aria-hidden="true" />
          </span>
        </div>

        <p className="hv2-recordName">IMG_7421.MP4</p>
        <p className="hv2-recordMeta">24.6 MB&nbsp;&nbsp;•&nbsp;&nbsp;3840 × 2160&nbsp;&nbsp;•&nbsp;&nbsp;00:28</p>

        <ul className="hv2-recordRows">
          <RecordRow
            Icon={Fingerprint}
            title="Cryptographic Hash"
            value="SHA-256 · 3f2a8e0c4f9…9d4c1b82"
            trail={
              <span className="hv2-recordRowTrail">
                <Copy strokeWidth={STROKE} aria-hidden="true" />
              </span>
            }
          />
          <RecordRow
            Icon={Clock}
            title="Timestamp (TSA)"
            value="Apr 14, 2025 10:24:17 UTC"
            trail={
              <span className={`hv2-recordRowTrail hv2-trailOk`}>
                <Check strokeWidth={2.25} aria-hidden="true" />
              </span>
            }
          />
          <RecordRow
            Icon={Link2}
            title="Chain of Custody"
            value="3 events"
            trail={
              <span className={`hv2-recordRowTrail hv2-trailAction`}>
                <ChevronRight strokeWidth={STROKE} aria-hidden="true" />
              </span>
            }
          />
          <RecordRow
            Icon={MapPin}
            title={
              <>
                Location <em>(optional)</em>
              </>
            }
            value="Essen, Germany"
            trail={
              <span className="hv2-miniMap">
                <MapPin strokeWidth={STROKE} aria-hidden="true" />
              </span>
            }
          />
          <RecordRow
            Icon={FileText}
            title="Verification Package"
            value="PDF report + QR code"
            trail={
              <span className={`hv2-recordRowTrail hv2-trailAction`}>
                <ChevronRight strokeWidth={STROKE} aria-hidden="true" />
              </span>
            }
          />
        </ul>

        <span className="hv2-recordButton">
          View Verification Page
          <ArrowRight strokeWidth={STROKE} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

function OutputCard({
  Icon,
  title,
  body,
  children,
  aside,
  bodyClassName,
  style,
}: {
  Icon: LucideIcon;
  title: string;
  body: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  bodyClassName?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`hv2-output hv2-glassCard`} style={style}>
      {aside}
      <div className="hv2-outputHead">
        <span className="hv2-badgeIcon">
          <Icon strokeWidth={STROKE} aria-hidden="true" />
        </span>
        <div>
          <p className="hv2-outputTitle">{title}</p>
          <p className={`hv2-outputBody ${bodyClassName ?? ""}`}>{body}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function VerificationOutput({ style }: { style?: CSSProperties }) {
  return (
    <OutputCard
      style={style}
      Icon={Globe}
      title="Verification Page"
      body={
        <>
          Independent verification
          <br />
          with full evidence details
        </>
      }
    >
      <div className="hv2-verifyRow">
        <div className="hv2-verifyThumb">
          <Image src={IMG.scene} alt="" fill sizes="200px" />
        </div>
        <div className="hv2-qr">
          <QRCodeSVG value={SAMPLE_LINK} level="M" bgColor="#ffffff" fgColor="#0b1433" />
        </div>
      </div>
    </OutputCard>
  );
}

function ReportsOutput({ style }: { style?: CSSProperties }) {
  return (
    <OutputCard
      style={style}
      Icon={FileCheck2}
      title="Professional Reports"
      bodyClassName="hv2-reportsBody"
      body={
        <>
          Generate detailed reports
          <br />
          with verification materials
        </>
      }
      aside={
        <div className="hv2-reportShot">
          <Image src={IMG.report} alt="" fill sizes="140px" />
          <span className="hv2-pdfTag">
            <FileText strokeWidth={STROKE} aria-hidden="true" />
            PDF
          </span>
        </div>
      }
    />
  );
}

function SharingOutput({ style }: { style?: CSSProperties }) {
  return (
    <OutputCard
      style={style}
      Icon={Link2}
      title="Secure Sharing"
      body={
        <>
          Share with clients, authorities
          <br />
          or stakeholders
        </>
      }
    >
      <div className="hv2-shareField">
        <span>{SAMPLE_LINK}</span>
        <span className="hv2-shareCopy">Copy</span>
      </div>
    </OutputCard>
  );
}

function WorkspaceOutput({ style }: { style?: CSSProperties }) {
  return (
    <OutputCard
      style={style}
      Icon={Users}
      title="Workspace Collaboration"
      body={
        <>
          Workspaces, permissions
          <br />
          and audit trails
        </>
      }
    >
      <div className="hv2-avatars">
        {AVATARS.map((src) => (
          <span key={src} className="hv2-avatar">
            <Image src={src} alt="" fill sizes="40px" />
          </span>
        ))}
        <span className="hv2-avatarMore">+8</span>
      </div>
    </OutputCard>
  );
}

function WorkflowLabels() {
  return (
    <>
      {WORKFLOW.map((step, i) => (
        <span key={step} style={{ display: "contents" }}>
          {i > 0 && <span className="hv2-pedestalDot" />}
          {step.toUpperCase()}
        </span>
      ))}
    </>
  );
}

/*
 * The pedestal's base has a curved front face. Measured on the asset as
 * placed in the stage (PEDESTAL below), centred on the evidence record
 * (x 494), each edge of that face is the lower half of an ellipse:
 *   upper edge — ends at y 548, dips 19 to y 567 at the front
 *   lower edge — ends at y 566, dips 32 to y 598 at the front
 * The face is tinted dark (multiply, so the asset's metal highlights still
 * read through) and the labels run along its mid-line.
 */
const PEDESTAL = { x: 213, y: 448, w: 562, h: 178 };
const FACE_TOP = { cx: 494, cy: 548, rx: 258, ry: 19 };
const FACE_BOTTOM = { cx: 494, cy: 566, rx: 262, ry: 32 };
const LABEL_ARC = { cx: 494, cy: 557, rx: 260, ry: 25 };

type Ellipse = { cx: number; cy: number; rx: number; ry: number };

/** Lower half of an ellipse, left → right (or right → left when reversed). */
const lowerArc = (e: Ellipse, reverse = false) =>
  reverse ? `A ${e.rx} ${e.ry} 0 0 1 ${e.cx - e.rx} ${e.cy}` : `A ${e.rx} ${e.ry} 0 0 0 ${e.cx + e.rx} ${e.cy}`;

const FACE_PATH = [
  `M ${FACE_TOP.cx - FACE_TOP.rx} ${FACE_TOP.cy}`,
  lowerArc(FACE_TOP),
  `L ${FACE_BOTTOM.cx + FACE_BOTTOM.rx} ${FACE_BOTTOM.cy}`,
  lowerArc(FACE_BOTTOM, true),
  "Z",
].join(" ");

function PedestalLabels() {
  return (
    <svg className="hv2-flow" viewBox="0 0 1020 610" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hv2-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24346b" />
          <stop offset="1" stopColor="#0a1438" />
        </linearGradient>
        <path id="hv2-label-arc" d={`M ${LABEL_ARC.cx - LABEL_ARC.rx} ${LABEL_ARC.cy} ${lowerArc(LABEL_ARC)}`} />
      </defs>
      <path className="hv2-pedestalFace" d={FACE_PATH} fill="url(#hv2-face)" />
      <text className="hv2-pedestalText" dominantBaseline="central">
        <textPath href="#hv2-label-arc" startOffset="50%" textAnchor="middle">
          {WORKFLOW.map((step, i) => (
            <tspan key={step}>
              {i > 0 && <tspan className="hv2-pedestalTextDot">{"  •  "}</tspan>}
              {step.toUpperCase()}
            </tspan>
          ))}
        </textPath>
      </text>
    </svg>
  );
}

/* Desktop composition, drawn in the reference's 1020 × 610 coordinates. */
function Stage() {
  return (
    <div className="hv2-stageWrap" aria-hidden="true">
      <div className="hv2-stage">
        <Image className={`hv2-at hv2-pedestal`} src={IMG.pedestal} alt="" width={1774} height={887} style={place(PEDESTAL.x, PEDESTAL.y, PEDESTAL.w, PEDESTAL.h)} sizes="620px" />
        <Image className={`hv2-at hv2-glow`} src={IMG.glow} alt="" width={1536} height={1024} style={place(114, 104, 760, 506)} sizes="800px" />
        <PedestalLabels />

        <FlowLines />

        {SOURCES.map((src, i) => (
          <SourceCard key={src.key} source={src} style={{ position: "absolute", ...place(SOURCE_LEFT, SOURCE_TOP[i]) }} />
        ))}

        {SOURCES.map(({ key, node: { x, y, Icon, violet } }) => (
          <span key={key} className={`hv2-at hv2-node ${violet ? "hv2-nodeViolet" : ""}`} style={place(x, y)}>
            <Icon strokeWidth={STROKE} aria-hidden="true" />
          </span>
        ))}

        <EvidenceRecord style={{ position: "absolute", ...place(RECORD.left, RECORD.top) }} priority />

        <VerificationOutput style={{ position: "absolute", ...place(OUTPUT_LEFT, OUTPUT.verification.top, undefined, OUTPUT.verification.height) }} />
        <ReportsOutput style={{ position: "absolute", ...place(OUTPUT_LEFT, OUTPUT.reports.top, undefined, OUTPUT.reports.height) }} />
        <SharingOutput style={{ position: "absolute", ...place(OUTPUT_LEFT, OUTPUT.sharing.top, undefined, OUTPUT.sharing.height) }} />
        <WorkspaceOutput style={{ position: "absolute", ...place(OUTPUT_LEFT, OUTPUT.workspace.top, undefined, OUTPUT.workspace.height) }} />
      </div>
    </div>
  );
}

/* Same cards, stacked for tablet and phone. */
function Stack() {
  return (
    <div className="hv2-stack" aria-hidden="true">
      <div className="hv2-stackRecord">
        <EvidenceRecord />
      </div>
      <div className="hv2-stackFlow">
        <WorkflowLabels />
      </div>
      <p className="hv2-stackHeading">Evidence sources</p>
      <div className="hv2-stackScroller">
        {SOURCES.map((src) => (
          <div key={src.key} className="hv2-stackSource">
            <SourceCard source={src} />
          </div>
        ))}
      </div>
      <p className="hv2-stackHeading">Outputs</p>
      <div className="hv2-stackOutputs">
        <div className="hv2-stackOutput">
          <VerificationOutput />
        </div>
        <div className="hv2-stackOutput">
          <ReportsOutput />
        </div>
        <div className="hv2-stackOutput">
          <SharingOutput />
        </div>
        <div className="hv2-stackOutput">
          <WorkspaceOutput />
        </div>
      </div>
    </div>
  );
}

export function HeroV2() {
  return (
    <section className="hv2-hero" aria-labelledby="hero-v2-title">
      {/* React hoists this into <head> once, keyed by href (see heroV2.styles.ts). */}
      <style href="proovra-hero-v2" precedence="default">
        {HERO_V2_CSS}
      </style>
      <div className="hv2-backdrop" aria-hidden="true">
        <Image className="hv2-city" src={IMG.city} alt="" width={1983} height={793} sizes="100vw" priority />
        <div className="hv2-backdropWash" />
      </div>

      <div className="hv2-inner">
        <div className="hv2-top">
          <div className="hv2-copy">
            <p className="hv2-eyebrow">Digital Evidence Operations Platform</p>
            {/* The production homepage copy, carried over verbatim from the hero this replaced. */}
            <h1 id="hero-v2-title" className="hv2-headline">
              <span className="hv2-headlineLines">
                Evidence integrity.
                <br />
                Verifiable facts.
                <br />
                Operational trust.
              </span>
              <span className="hv2-headlineAccent">Digital evidence infrastructure for high-trust operations.</span>
            </h1>
            <p className="hv2-lede">
              Digital evidence infrastructure for legal, insurance, investigation, compliance, and public-sector teams
              that require trusted records, verification, and audit-ready reporting.
            </p>
            <div className="hv2-ctas">
              <a
                href={MARKETING_LINKS.sampleReport}
                target="_blank"
                rel="noopener noreferrer"
                className="hv2-ctaPrimary"
              >
                View sample report
                <ArrowRight size={18} strokeWidth={STROKE} aria-hidden="true" />
              </a>
              <Link href={MARKETING_LINKS.requestDemo} className="hv2-ctaSecondary">
                Request a demo
              </Link>
            </div>
            <ul className="hv2-assurances">
              {ASSURANCES.map((label) => (
                <li key={label} className="hv2-assurance">
                  <span className="hv2-assuranceMark">
                    <Check size={13} strokeWidth={TICK_STROKE} aria-hidden="true" />
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <Stage />
          <Stack />
        </div>

        <ul className="hv2-industries" aria-label="Industries">
          {INDUSTRIES.map(({ title, body, Icon, image, focus, href }) => (
            <li key={title}>
              <Link href={href} className="hv2-industry">
                <span className="hv2-industryMedia">
                  <Image
                    src={image}
                    alt=""
                    fill
                    sizes="(min-width: 1200px) 17vw, (min-width: 768px) 32vw, 260px"
                    style={{ objectPosition: focus }}
                  />
                </span>
                <span className="hv2-industryBody">
                  <span className="hv2-industryIcon">
                    <Icon size={24} strokeWidth={STROKE} aria-hidden="true" />
                  </span>
                  <span>
                    <span className="hv2-industryTitle" style={{ display: "block" }}>
                      {title}
                    </span>
                    <span className="hv2-industryText" style={{ display: "block" }}>
                      {body}
                    </span>
                  </span>
                  <span className="hv2-industryArrow">
                    <ArrowRight size={12} strokeWidth={STROKE} aria-hidden="true" />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <div className="hv2-audience">
          <p className="hv2-audienceLabel">Built for professionals in</p>
          <ul className="hv2-audienceList">
            {AUDIENCE.map(({ label, Icon }) => (
              <li key={label} className="hv2-audienceItem">
                <Icon size={21} strokeWidth={STROKE} aria-hidden="true" />
                {label}
              </li>
            ))}
            <li className={`hv2-audienceItem hv2-audienceMore`}>
              <Ellipsis size={21} strokeWidth={STROKE} aria-hidden="true" />
              and more…
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
