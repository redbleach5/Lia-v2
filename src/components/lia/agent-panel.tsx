'use client';

import { useChatStore } from '@/stores/chat-store';
import { useAgent } from '@/hooks/use-agent';
import {
  Rocket,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const STATUS_CONFIG: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  pending:              { label: 'ожидает',           icon: Clock,           color: 'text-text-dim' },
  planning:             { label: 'планирование',       icon: Loader2,         color: 'text-accent' },
  executing:            { label: 'выполнение',         icon: Loader2,         color: 'text-accent' },
  waiting_input:        { label: 'вопрос пользователю', icon: AlertCircle,    color: 'text-warning' },
  waiting_confirmation: { label: 'ждёт подтверждения',  icon: AlertCircle,    color: 'text-warning' },
  synthesizing:         { label: 'синтез ответа',      icon: Loader2,         color: 'text-accent' },
  done:                 { label: 'готово',             icon: CheckCircle2,    color: 'text-success' },
  failed:               { label: 'ошибка',             icon: XCircle,         color: 'text-destructive' },
  cancelled:            { label: 'отменено',           icon: XCircle,         color: 'text-text-dim' },
};

export function AgentPanel() {
  const tasks = useChatStore(s => s.agentTasks);
  const activeTaskId = useChatStore(s => s.activeTaskId);
  const { create, cancel, provideInput, selectTask } = useAgent();
  const isStreaming = useChatStore(s => s.isStreaming);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Rocket className="w-3.5 h-3.5 text-rose-500" />
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Агентские задачи
        </h3>
      </div>

      {tasks.length === 0 ? (
        <div className="text-xs text-text-dim py-4 text-center">
          Нет задач.
          <br />
          Выбери режим «Агент» в чате, чтобы поставить первую.
        </div>
      ) : (
        <div className="space-y-1.5">
          {tasks.map(task => (
            <TaskListItem
              key={task.id}
              task={task}
              isActive={task.id === activeTaskId}
              onSelect={() => selectTask(task.id)}
              onCancel={() => cancel(task.id)}
            />
          ))}
        </div>
      )}

      {/* Active task detail */}
      {activeTaskId && <ActiveTaskDetail />}

      {/* Input dialog for waiting_input */}
      <WaitingInputDialog
        onSubmit={(answer) => activeTaskId && provideInput(activeTaskId, answer)}
      />
    </div>
  );
}

// ============================================================================
// Task list item — compact card
// ============================================================================
function TaskListItem({ task, isActive, onSelect, onCancel }: {
  task: {
    id: string;
    goal: string;
    status: string;
    currentStep: number;
    maxSteps: number;
    error: string | null;
    resultSummary: string | null;
  };
  isActive: boolean;
  onSelect: () => void;
  onCancel: () => void;
}) {
  const config = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;
  const Icon = config.icon;
  const isActiveRunning = task.status === 'planning' || task.status === 'executing' || task.status === 'synthesizing';

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-md border bg-surface/50 p-2.5 transition-colors',
        isActive ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', config.color, isActiveRunning && 'animate-spin')} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium leading-tight line-clamp-2">
            {task.goal}
          </div>
          <div className={cn('text-[10px] mt-1 flex items-center gap-1', config.color)}>
            <span>{config.label}</span>
            {task.maxSteps > 0 && task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed' && (
              <>
                <span className="text-text-dim">·</span>
                <span className="font-mono">{task.currentStep}/{task.maxSteps}</span>
              </>
            )}
          </div>
        </div>
        {isActiveRunning && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="text-text-dim hover:text-destructive transition-colors p-1 rounded"
            title="Отменить"
          >
            <XCircle className="w-3 h-3" />
          </button>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Active task detail — full plan + steps + artifacts
// ============================================================================
function ActiveTaskDetail() {
  const plan = useChatStore(s => s.activeTaskPlan);
  const steps = useChatStore(s => s.activeTaskSteps);
  const status = useChatStore(s => s.activeTaskStatus);
  const result = useChatStore(s => s.activeTaskResult);
  const error = useChatStore(s => s.activeTaskError);
  const artifacts = useChatStore(s => s.activeTaskArtifacts);

  if (!plan && steps.length === 0 && !result && !error) return null;

  return (
    <div className="mt-4 rounded-md border border-border bg-background/50 overflow-hidden">
      {/* Plan */}
      {plan && (
        <div className="p-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
            План
          </div>
          <ol className="space-y-1">
            {plan.steps.map((step, i) => (
              <li key={i} className="text-[11px] flex gap-2">
                <span className="text-text-dim font-mono shrink-0">{i + 1}.</span>
                <span className="text-foreground/80">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Steps */}
      {steps.length > 0 && (
        <div className="p-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
            Шаги
          </div>
          <div className="space-y-2">
            {steps.map((s) => (
              <div key={s.step} className="text-[11px]">
                <div className="flex items-center gap-1.5 text-foreground">
                  <ChevronRight className="w-3 h-3 text-accent shrink-0" />
                  <span className="font-mono text-text-dim">#{s.step}</span>
                  {s.action && (
                    <span className="text-accent font-mono">{s.action}</span>
                  )}
                </div>
                {s.thought && (
                  <div className="text-text-dim ml-4 mt-0.5 line-clamp-2">
                    {s.thought.slice(0, 150)}
                  </div>
                )}
                {s.observation && (
                  <div className="text-muted-foreground ml-4 mt-0.5 line-clamp-3 text-[10px]">
                    → {s.observation.slice(0, 250)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Artifacts */}
      {artifacts.length > 0 && (
        <div className="p-3 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
            Артефакты
          </div>
          <div className="space-y-1">
            {artifacts.map((a, i) => (
              <a
                key={i}
                href={a.url}
                download={a.filename}
                className="flex items-center gap-2 text-[11px] hover:text-accent transition-colors"
              >
                <FileText className="w-3 h-3 shrink-0" />
                <span className="font-mono truncate">{a.filename}</span>
                <span className="ml-auto text-text-dim">скачать</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="p-3 border-b border-border bg-success/5">
          <div className="text-[10px] uppercase tracking-wider text-success mb-1.5 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Результат
          </div>
          <div className="text-[11px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {result}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 border-b border-border bg-destructive/5">
          <div className="text-[10px] uppercase tracking-wider text-destructive mb-1.5 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Ошибка
          </div>
          <div className="text-[11px] text-foreground/90 leading-relaxed">
            {error}
          </div>
        </div>
      )}

      {/* Status indicator */}
      {status && !result && !error && (
        <div className="p-2 flex items-center gap-2 text-[10px] text-text-dim">
          {status === 'planning' && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
          {status === 'executing' && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
          {status === 'synthesizing' && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
          <span className="uppercase tracking-wider">{STATUS_CONFIG[status]?.label ?? status}</span>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Waiting input dialog — appears when task is waiting_input
// ============================================================================
function WaitingInputDialog({ onSubmit }: { onSubmit: (answer: string) => void }) {
  const question = useChatStore(s => s.activeTaskQuestion);
  const [answer, setAnswer] = useState('');

  if (!question) return null;

  const handleSubmit = () => {
    if (!answer.trim()) return;
    onSubmit(answer.trim());
    setAnswer('');
  };

  return (
    <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <AlertCircle className="w-3.5 h-3.5 text-warning" />
        <span className="text-[10px] uppercase tracking-wider text-warning font-medium">
          Лия спрашивает
        </span>
      </div>
      <div className="text-xs text-foreground/90 mb-2 leading-relaxed">
        {question}
      </div>
      <textarea
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Ваш ответ…"
        rows={2}
        className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background placeholder:text-text-dim focus:outline-none focus:border-accent resize-none"
      />
      <div className="flex justify-end gap-1 mt-2">
        <button
          onClick={handleSubmit}
          disabled={!answer.trim()}
          className="px-2 py-1 text-[11px] rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          Ответить
        </button>
      </div>
    </div>
  );
}
