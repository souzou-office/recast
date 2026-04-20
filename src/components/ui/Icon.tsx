import * as LI from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Props = {
  name: keyof typeof LI;
  size?: number;
  className?: string;
};

// 薄いラッパー。strokeWidth=1.5 を全アイコンに強制適用する。
export function Icon({ name, size = 14, className }: Props) {
  const C = LI[name] as LucideIcon;
  if (!C) return null;
  return <C size={size} strokeWidth={1.5} className={className} />;
}
