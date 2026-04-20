"use client";

import type { ReactNode } from "react";
import { Children, Fragment, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 文字列中の 要確認 / （要確認） / *要確認* を赤文字 span に差し替える
function hiliteText(text: string): ReactNode {
  if (!text.includes("要確認")) return text;
  const parts = text.split(/(\*要確認\*|（要確認）|\(要確認\)|要確認)/);
  return parts.map((p, i) => {
    if (/要確認/.test(p)) {
      const clean = p.replace(/\*/g, "");
      return (
        <span key={i} className="text-red-600 font-medium">
          {clean}
        </span>
      );
    }
    return <Fragment key={i}>{p}</Fragment>;
  });
}

// ReactNode の全文字列子ノードを再帰的に処理
function walk(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return hiliteText(child);
    if (Array.isArray(child)) return walk(child);
    if (isValidElement(child)) return child;
    return child;
  });
}

export function WarnHighlightMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p>{walk(children)}</p>,
        li: ({ children }) => <li>{walk(children)}</li>,
        td: ({ children }) => <td>{walk(children)}</td>,
        th: ({ children }) => <th>{walk(children)}</th>,
        em: ({ children }) => {
          // 斜体が *要確認* に由来する場合は赤 span、そうでなければ通常 em
          const text = Children.toArray(children).map((c) => (typeof c === "string" ? c : "")).join("");
          if (/^要確認$/.test(text.trim())) {
            return <span className="text-red-600 font-medium">{text}</span>;
          }
          return <em>{walk(children)}</em>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
