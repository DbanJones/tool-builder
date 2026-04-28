"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleEllipsis,
  FileSpreadsheet,
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
  if (kind === "spreadsheet" || kind === "data") {
    return <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />;
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
        "flex min-h-0 flex-1 flex-col transition-colors " +
        (isDragOver ? "bg-accent/40" : "bg-background")
      }
      aria-label="File ingestion panel"
    >
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Files {files.length > 0 ? `· ${files.length}` : ""}
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Drop PDFs, screenshots, schemas, CSVs, or spreadsheets (.xlsx). Anywhere on the
          workspace works too.
        </p>
      </div>
      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-6">
          <div
            className={
              "w-full rounded-md border border-dashed px-4 py-8 text-center text-xs transition-colors " +
              (isDragOver
                ? "border-primary bg-primary/5 text-foreground"
                : "border-muted-foreground/30 text-muted-foreground")
            }
          >
            {isDragOver ? "Drop to add" : "No files yet — drop one in to ingest"}
          </div>
        </div>
      ) : (
        <ul className="flex-1 space-y-1.5 overflow-auto px-4 py-3" aria-live="polite">
          {files.map((f) => (
            <li
              key={f.id}
              className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm"
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  <KindIcon kind={f.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{f.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatBytes(f.size)}
                    <span className="mx-1">·</span>
                    <span title={f.statusMessage}>{f.statusMessage ?? f.status}</span>
                  </p>
                </div>
                <span className="mt-0.5 shrink-0">
                  <StatusIcon file={f} />
                </span>
              </div>
              {f.summary ? (
                <p className="mt-1.5 line-clamp-3 whitespace-pre-line border-t pt-1.5 text-[10px] text-muted-foreground">
                  {f.summary}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
