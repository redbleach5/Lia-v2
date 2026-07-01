'use client';

// ============================================================================
// MarkdownRenderer — рендер markdown через react-markdown + remark-gfm.
// ============================================================================
//
// Заменяет stub-парсер из Phase 0 (только code fences + inline code).
// Теперь поддерживает: headings, lists, tables, blockquotes, links,
// bold/italic, strikethrough, code blocks (с кнопкой copy), inline code.
//
// react-markdown v10 использует "components" prop для кастомизации рендера
// каждого элемента. Мы кастомизируем code/pre/a для соответствия дизайну.
//
// Memoized — не ре-рендерится при стриминговом обновлении последнего сообщения
// (если текст не изменился).

import { memo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

type MarkdownRendererProps = {
  content: string;
  className?: string;
};

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('space-y-2 break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks (fenced) и inline code
          code: ({ className: codeClassName, children, ...props }) => {
            // react-markdown v10: code внутри pre = block, иначе inline
            const isInline = !codeClassName;
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-surface-2 text-xs font-mono text-accent"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            // Block code — оборачиваем в CodeBlock с кнопкой copy
            const lang = /language-(\w+)/.exec(codeClassName || '')?.[1] ?? 'text';
            const codeStr = String(children).replace(/\n$/, '');
            return <CodeBlock language={lang} code={codeStr} />;
          },
          // Pre — react-markdown оборачивает block code в <pre>.
          // Мы уже рендерим CodeBlock внутри code, поэтому pre делаем passthrough.
          pre: ({ children }) => <>{children}</>,
          // Links — открываем в новой вкладке, добавляем target/rel
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline hover:text-accent/80 transition-colors"
            >
              {children}
            </a>
          ),
          // Headings
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-medium mt-2 mb-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-xs font-medium mt-2 mb-1">{children}</h4>,
          // Lists
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="text-sm">{children}</li>,
          // Blockquote
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          // Table (GFM)
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse border border-border">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-surface-2/50 px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
          // Horizontal rule
          hr: () => <hr className="border-border my-3" />,
          // Paragraph — по умолчанию, но добавляем leading-relaxed
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          // Strong/em/del
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through text-text-dim">{children}</del>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// ============================================================================
// CodeBlock — блок кода с кнопкой copy.
// ============================================================================
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // clipboard API может не работать в небезопасном контексте — игнорируем
    });
  }, [code]);

  return (
    <div className="rounded-md border border-border bg-background/50 overflow-hidden my-2">
      <div className="px-3 py-1.5 border-b border-border bg-surface-2/50 flex items-center justify-between">
        <span className="text-[10px] font-mono text-text-dim uppercase">{language}</span>
        <button
          onClick={handleCopy}
          className="text-[10px] text-text-dim hover:text-foreground transition-colors"
        >
          {copied ? 'скопировано' : 'копировать'}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
