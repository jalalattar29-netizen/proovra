"use client";

import {
  LayoutDashboard,
  Camera,
  FileCheck,
  Users,
  FileText,
  CreditCard,
  Settings,
  Shield,
  Home,
  Sparkles,
  DollarSign,
  Info,
  LogIn,
  Rocket,
  Fingerprint,
  CheckCircle2,
  Share2,
  Gavel,
  Newspaper,
  ClipboardCheck,
  Building2
} from "lucide-react";

const iconSize = 20;
const iconStroke = 1.8;

export const Icons = {
  Dashboard: () => <LayoutDashboard size={iconSize} strokeWidth={iconStroke} />,
  Capture: () => <Camera size={iconSize} strokeWidth={iconStroke} />,
  Evidence: () => <FileCheck size={iconSize} strokeWidth={iconStroke} />,
  Teams: () => <Users size={iconSize} strokeWidth={iconStroke} />,
  Reports: () => <FileText size={iconSize} strokeWidth={iconStroke} />,
  Billing: () => <CreditCard size={iconSize} strokeWidth={iconStroke} />,
  Settings: () => <Settings size={iconSize} strokeWidth={iconStroke} />,
  Security: () => <Shield size={iconSize} strokeWidth={iconStroke} />,
  Home: () => <Home size={iconSize} strokeWidth={iconStroke} />,
  Features: () => <Sparkles size={iconSize} strokeWidth={iconStroke} />,
  Pricing: () => <DollarSign size={iconSize} strokeWidth={iconStroke} />,
  About: () => <Info size={iconSize} strokeWidth={iconStroke} />,
  Login: () => <LogIn size={iconSize} strokeWidth={iconStroke} />,
  GetStarted: () => <Rocket size={iconSize} strokeWidth={iconStroke} />,
  Fingerprint: () => <Fingerprint size={iconSize} strokeWidth={iconStroke} />,
  Verify: () => <CheckCircle2 size={iconSize} strokeWidth={iconStroke} />,
  Share: () => <Share2 size={iconSize} strokeWidth={iconStroke} />,
  Lawyers: () => <Gavel size={iconSize} strokeWidth={iconStroke} />,
  Journalists: () => <Newspaper size={iconSize} strokeWidth={iconStroke} />,
  Compliance: () => <ClipboardCheck size={iconSize} strokeWidth={iconStroke} />,
  Enterprises: () => <Building2 size={iconSize} strokeWidth={iconStroke} />
};
