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
        <span className="text-xs font-medium text-gray-500">recast</span>
        <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
          {data.templateName}
        </span>
      </div>

      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 w-48">確認項目</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">結果</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 w-52">注意事項</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, i) => (
              <tr key={i} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-3 text-sm font-medium text-gray-800 align-top">
                  {item.label}
                </td>
                <td className="px-4 py-3 text-sm text-gray-700 align-top whitespace-pre-wrap leading-relaxed">
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

      <p className="mt-1.5 text-[10px] text-gray-400">
        {new Date(data.createdAt).toLocaleString("ja-JP")}
      </p>
    </div>
  );
}
