'use client';

// Workspace Panel — файловый браузер для агентского режима.
//
// Показывает дерево файлов созданных/изменённых агентом в его fsScope.
// Пользователь может кликнуть на файл и увидеть его содержимое.
// Обновляется автоматически при получении step_end событий.

import { useState, useEffect, useCallback } from 'react';
import { File, Folder, FolderOpen, RefreshCw, ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type TreeNode = {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: TreeNode[];
};

export function WorkspacePanel({ taskId }: { taskId: string | null }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agent/${taskId}/workspace`);
      if (!res.ok) return;
      const data = await res.json();
      setTree(data.tree ?? []);
      setHasWorkspace(data.hasWorkspace ?? false);
      if (selectedFile && data.fileContent !== undefined) {
        setFileContent(data.fileContent);
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, [taskId, selectedFile]);

  // Load tree on mount + when taskId changes
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 3 seconds when task is running
  useEffect(() => {
    if (!taskId) return;
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [taskId, refresh]);

  const loadFile = async (filePath: string) => {
    if (!taskId) return;
    setSelectedFile(filePath);
    try {
      const res = await fetch(`/api/agent/${taskId}/workspace?file=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const data = await res.json();
      setFileContent(data.fileContent);
    } catch {
      setFileContent(null);
    }
  };

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (!taskId) {
    return (
      <div className="text-[10px] text-text-dim italic px-2 py-4 text-center">
        Нет активной задачи
      </div>
    );
  }

  if (!hasWorkspace) {
    return (
      <div className="text-[10px] text-text-dim italic px-2 py-4 text-center">
        У задачи нет рабочей директории
      </div>
    );
  }

  const renderTree = (nodes: TreeNode[], level: number = 0): React.ReactNode => {
    return nodes.map(node => {
      const indent = level * 12;
      const isExpanded = expandedDirs.has(node.path);

      if (node.type === 'dir') {
        return (
          <div key={node.path}>
            <button
              onClick={() => toggleDir(node.path)}
              className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-2 rounded text-[11px] text-muted-foreground transition-colors"
              style={{ paddingLeft: indent + 8 }}
            >
              {isExpanded
                ? <ChevronDown className="w-3 h-3 shrink-0" />
                : <ChevronRight className="w-3 h-3 shrink-0" />
              }
              {isExpanded
                ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-accent" />
                : <Folder className="w-3.5 h-3.5 shrink-0 text-accent" />
              }
              <span className="truncate">{node.name}</span>
            </button>
            {isExpanded && node.children && renderTree(node.children, level + 1)}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          onClick={() => loadFile(node.path)}
          className={cn(
            'w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-2 rounded text-[11px] transition-colors',
            selectedFile === node.path ? 'bg-accent/10 text-accent' : 'text-muted-foreground',
          )}
          style={{ paddingLeft: indent + 20 }}
        >
          <File className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="truncate">{node.name}</span>
          {node.size !== undefined && (
            <span className="text-[9px] text-text-dim ml-auto">
              {node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(1)}K`}
            </span>
          )}
        </button>
      );
    });
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Файлы
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 rounded hover:bg-surface-2 text-text-dim hover:text-foreground transition-colors"
          title="Обновить"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      {/* File tree */}
      {tree.length === 0 ? (
        <div className="text-[10px] text-text-dim italic px-2 py-2">
          {loading ? 'Загрузка...' : 'Пока нет файлов'}
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded border border-border">
          {renderTree(tree)}
        </div>
      )}

      {/* File content viewer */}
      {selectedFile && fileContent !== null && (
        <div className="space-y-1">
          <div className="text-[10px] text-text-dim px-1 truncate">
            {selectedFile}
          </div>
          <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 text-[10px] font-mono leading-relaxed">
            <code>{fileContent}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
