"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createProject, sanitiseProjectName } from "@/lib/project";

// Reusable create-project form. Used both on the welcome page (so "start
// something new" is one click instead of one navigation + one form) and on
// the dedicated /new-project route.

const FormSchema = z.object({
  name: z
    .string()
    .min(1, "Project name is required")
    .max(200, "Project name is too long (200 characters max)")
    .refine((n) => sanitiseProjectName(n) !== null, {
      message:
        "Project name needs at least one letter or digit (after stripping punctuation/emoji).",
    }),
  folder: z.string().min(1, "Folder is required"),
});

type FormValues = z.infer<typeof FormSchema>;

const SAFE_DEFAULT_FOLDER = "~/Documents/ClaudeBuilds";

function pickDefaultFolder(): string {
  if (typeof window === "undefined") return SAFE_DEFAULT_FOLDER;
  const last = window.localStorage.getItem("builder.lastProjectFolder");
  if (!last) return SAFE_DEFAULT_FOLDER;
  const lower = last.toLowerCase();
  const looksUnsafe =
    lower.includes("/tool builder") ||
    lower.includes("/src-tauri") ||
    lower.includes("/sidecar") ||
    lower.endsWith("/airtec/coding") ||
    lower.includes("/onedrive/") ||
    lower.includes("/icloud") ||
    lower.includes("library/cloudstorage");
  return looksUnsafe ? SAFE_DEFAULT_FOLDER : last;
}

export interface NewProjectFormProps {
  /** Heading shown at the top of the card. */
  title?: string;
  /** Description shown under the title. */
  description?: string;
}

export function NewProjectForm({
  title = "Create a new project",
  description = "The Builder will create a new folder for your project, initialise it as a git repository, and seed it with placeholder templates.",
}: NewProjectFormProps) {
  const router = useRouter();
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      folder: pickDefaultFolder(),
    },
  });

  const browseFolder = async (): Promise<void> => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked.length > 0) {
      setValue("folder", picked, { shouldValidate: true, shouldDirty: true });
      window.localStorage.setItem("builder.lastProjectFolder", picked);
    }
  };

  const watchedName = watch("name") ?? "";
  const sanitisedFolder = watchedName ? sanitiseProjectName(watchedName) : null;

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmissionError(null);
    const result = await createProject(values.name, values.folder);
    result.match(
      (project) => {
        router.push(`/project?id=${encodeURIComponent(project.id)}`);
      },
      (error) => {
        setSubmissionError(error.message);
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            void handleSubmit(onSubmit)(e);
          }}
          className="space-y-6"
          noValidate
        >
          <div className="space-y-2">
            <label htmlFor="name" className="text-sm font-medium">
              Project name
            </label>
            <input
              id="name"
              type="text"
              autoComplete="off"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-invalid={errors.name !== undefined}
              aria-describedby={errors.name ? "name-error" : "name-hint"}
              {...register("name")}
            />
            {errors.name ? (
              <p id="name-error" className="text-sm text-destructive">
                {errors.name.message}
              </p>
            ) : sanitisedFolder ? (
              <p id="name-hint" className="text-sm text-muted-foreground">
                Folder will be{" "}
                <span className="font-mono">{sanitisedFolder}</span>; the display name in the
                Builder stays <span className="font-mono">{watchedName}</span>.
              </p>
            ) : (
              <p id="name-hint" className="text-sm text-muted-foreground">
                Anything goes. Example: <span className="font-mono">PrepPilot</span> or{" "}
                <span className="font-mono">My Cool App</span>.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="folder" className="text-sm font-medium">
              Where to put it
            </label>
            <div className="flex gap-2">
              <input
                id="folder"
                type="text"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-invalid={errors.folder !== undefined}
                aria-describedby={errors.folder ? "folder-error" : "folder-hint"}
                {...register("folder")}
              />
              <Button type="button" variant="outline" onClick={() => void browseFolder()}>
                <FolderOpen className="mr-1 h-4 w-4" aria-hidden="true" />
                Browse
              </Button>
            </div>
            {errors.folder ? (
              <p id="folder-error" className="text-sm text-destructive">
                {errors.folder.message}
              </p>
            ) : (
              <p id="folder-hint" className="text-sm text-muted-foreground">
                Default is <span className="font-mono">~/Documents/ClaudeBuilds</span>; the
                project folder will be created inside. Your last choice is remembered.
              </p>
            )}
          </div>

          {submissionError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not create the project</AlertTitle>
              <AlertDescription>{submissionError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={isSubmitting} aria-live="polite">
            {isSubmitting ? (
              <>
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Creating...
              </>
            ) : (
              "Create project"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
