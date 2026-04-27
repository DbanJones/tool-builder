"use client";

import { Loader2, Send } from "lucide-react";
import { useEffect, useRef } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { QueuedQuestion } from "@/lib/chat/client";

// Unified chat column for /project/[id]. Renders the scrollback, the
// interview question pane (when a queued question is on screen), and the
// input box. Dispatch (chatSend vs orchestrator follow-up turn) is the
// parent's responsibility — this component is presentational + input.

export interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

export type ChatStatus =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "rate_limited"; message: string }
  | { kind: "error"; message: string };

interface ChatPanelProps {
  messages: readonly DisplayMessage[];
  status: ChatStatus;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  disabledReason: string | null;
  // Interview-only: the head question + buffered-answer count drive a
  // dedicated pane above the input. Hidden once the build has started.
  questionQueue: readonly QueuedQuestion[];
  bufferedAnswerCount: number;
  onOptionPick: (option: string) => void;
  onManualFlush: () => void;
  onEnterMyOwn: () => void;
  isPreparingBank: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatPanel({
  messages,
  status,
  input,
  onInputChange,
  onSend,
  disabled,
  disabledReason,
  questionQueue,
  bufferedAnswerCount,
  onOptionPick,
  onManualFlush,
  onEnterMyOwn,
  isPreparingBank,
  inputRef,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isStreaming = status.kind === "streaming";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  const head = questionQueue[0];

  return (
    <section className="flex min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {messages.length === 0 && status.kind === "idle" && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              Start by describing what you want to build, then send.
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}

          {isStreaming && messages[messages.length - 1]?.role === "user" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Claude is thinking...
            </div>
          )}

          {status.kind === "rate_limited" && (
            <Alert variant="destructive">
              <AlertTitle>Rate-limited</AlertTitle>
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          )}

          {status.kind === "error" && (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      {isPreparingBank && messages[messages.length - 1]?.role === "user" && (
        <div className="border-t bg-muted/40 px-6 py-3">
          <div
            className="mx-auto flex w-full max-w-2xl items-center gap-3 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <div>
              <strong className="text-foreground">Preparing question bank...</strong>{" "}
              28 fast-path questions will guide your spec.
            </div>
          </div>
        </div>
      )}

      {head && (
        <div className="border-t bg-muted/40 px-6 py-3">
          <div className="mx-auto w-full max-w-2xl">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {head.id} · question {bufferedAnswerCount + 1} of{" "}
                {bufferedAnswerCount + questionQueue.length} in this batch
              </p>
              {bufferedAnswerCount > 0 ? (
                <button
                  type="button"
                  onClick={onManualFlush}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                  title="Send the answers you've given so far without finishing the batch"
                >
                  Send my {bufferedAnswerCount} answer{bufferedAnswerCount === 1 ? "" : "s"} now
                </button>
              ) : null}
            </div>
            <p className="mb-3 text-sm font-medium">{head.text}</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
              {head.options.map((opt) => (
                <Button
                  key={opt}
                  type="button"
                  variant="outline"
                  size="sm"
                  title="Click to answer this question"
                  onClick={() => onOptionPick(opt)}
                >
                  {opt}
                </Button>
              ))}
              {head.options.length > 0 ? (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={onEnterMyOwn}
                  title="Type a freeform answer instead"
                >
                  Enter my own response
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <div className="border-t px-6 py-4">
        <div className="mx-auto flex w-full max-w-2xl gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={
              disabled
                ? (disabledReason ?? "Cannot send right now")
                : "Type a message..."
            }
            disabled={disabled}
            rows={2}
            className="block flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          />
          <Button
            type="button"
            disabled={disabled || input.trim().length === 0}
            onClick={onSend}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={"flex " + (isUser ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm " +
          (isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")
        }
      >
        {message.text}
      </div>
    </div>
  );
}
