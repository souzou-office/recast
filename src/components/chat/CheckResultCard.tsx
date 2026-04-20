"use client";

interface CheckResultItem {
  label: string;
  result: string;
  note?: string;
}

interface CheckResult {
  templateName: string;
  items: CheckResultItem[];
  createdAt: string;
}

interface Props {
  data: CheckResult;
}

export default function CheckResultCard({ data }: Props) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <img src="/logo.png" alt="recast" className="h-4" />
        <span className="rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent-fg)]">
          {data.templateName}
        </span>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-hover)] border-b border-[var(--color-border)]">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-fg-muted)] w-48">確認項目</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-fg-muted)]">結果</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--color-fg-muted)] w-52">注意事項</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, i) => (
              <tr key={i} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className="px-4 py-3 text-sm font-medium text-[var(--color-fg)] align-top">
                  {item.label}
                </td>
                <td className="px-4 py-3 text-sm text-[var(--color-fg)] align-top whitespace-pre-wrap leading-relaxed">
                  {item.result}
                </td>
                <td className="px-4 py-3 text-xs text-orange-600 align-top whitespace-pre-wrap">
                  {item.note || ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 text-[10px] text-[var(--color-fg-subtle)]">
        {new Date(data.createdAt).toLocaleString("ja-JP")}
      </p>
    </div>
  );
}
