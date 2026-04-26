"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleEllipsis,
  FileText,
  Image as ImageIcon,
  Loader2,
  XCircle,
} from "lucide-react";
import { type DragEvent, useState } from "react";

import { classifyByName, type IngestedFile, type IngestedFileKind } from "@/lib/files/types";

interface FilePanelProps {
  files: readonly IngestedFile[];
  // The raw File[] is passed alongside so the parent can stream bytes through
  // the ingest orchestrator (which needs File.arrayBuffer for the base64 hop).
  // The two arrays are index-aligned: rawFiles[i] is the source of newFiles[i].
  onDrop: (newFiles: readonly IngestedFile[], rawFiles: readonly File[]) => void;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function formatBytes(n: number): string {
  if (n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function KindIcon({ kind }: { kind: IngestedFileKind }) {
  if (kind === "image") {
    return <ImageIcon className="h-4 w-4" aria-hidden="true" />;
  }
  return <FileText className="h-4 w-4" aria-hidden="true" />;
}

function StatusIcon({ file }: { file: IngestedFile }) {
  switch (file.status) {
    case "pending":
      return <CircleEllipsis className="h-4 w-4 text-muted-foreground" aria-label="Pending" />;
    case "processing":
      return (
        <Loader2
          className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-label="Processing"
        />
      );
    case "done":
      if (file.hasPiiWarning) {
        return <AlertTriangle className="h-4 w-4 text-yellow-600" aria-label="PII warning" />;
      }
      return <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Done" />;
    case "error":
      return <XCircle className="h-4 w-4 text-destructive" aria-label="Error" />;
  }
}

export function FilePanel({ files, onDrop }: FilePanelProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (): void => {
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragOver(false);
    const items = Array.from(e.dataTransfer.files);
    if (items.length === 0) return;
    const now = Date.now();
    const newFiles: IngestedFile[] = items.map((f) => ({
      id: makeId(),
      name: f.name,
      kind: classifyByName(f.name),
      size: f.size,
      status: "pending",
      droppedAt: now,
    }));
    onDrop(newFiles, items);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={
        "border-t px-6 py-3 transition-colors " +
        (isDragOver ? "bg-accent/50" : "bg-background")
      }
      aria-label="File ingestion panel"
    >
      <div className="mx-auto flex w-full max-w-2xl items-start gap-4">
        <div className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
          Files
          <p className="mt-1 text-[10px] normal-case tracking-normal text-muted-foreground">
            Drop PDFs, screenshots, schemas, CSVs.
          </p>
        </div>
        <ul className="flex-1 space-y-1" aria-live="polite">
          {files.length === 0 ? (
            <li
              className={
                "rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground " +
                (isDragOver ? "border-primary text-foreground" : "")
              }
            >
              {isDragOver ? "Drop to add" : "No files yet — drop one in to ingest"}
            </li>
          ) : (
            files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-1.5 text-xs"
              >
                <KindIcon kind={f.kind} />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
                <span
                  className="shrink-0 truncate text-muted-foreground"
                  title={f.statusMessage}
                >
                  {f.statusMessage ?? f.status}
                </span>
                <StatusIcon file={f} />
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
