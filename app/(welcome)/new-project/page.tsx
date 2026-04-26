"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createProject, sanitiseProjectName } from "@/lib/project";

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

export default function NewProjectPage() {
  const router = useRouter();
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { folder: "~/Documents/ClaudeBuilds" },
  });

  const watchedName = watch("name") ?? "";
  const sanitisedFolder = watchedName ? sanitiseProjectName(watchedName) : null;

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmissionError(null);
    const result = await createProject(values.name, values.folder);
    result.match(
      (project) => {
        router.push(`/interview?project=${encodeURIComponent(project.id)}`);
      },
      (error) => {
        setSubmissionError(error.message);
      },
    );
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Create your first project</CardTitle>
            <CardDescription>
              The Builder will create a new folder for your project, initialise it as a git
              repository, and seed it with placeholder templates.
            </CardDescription>
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
                <input
                  id="folder"
                  type="text"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-invalid={errors.folder !== undefined}
                  aria-describedby={errors.folder ? "folder-error" : "folder-hint"}
                  {...register("folder")}
                />
                {errors.folder ? (
                  <p id="folder-error" className="text-sm text-destructive">
                    {errors.folder.message}
                  </p>
                ) : (
                  <p id="folder-hint" className="text-sm text-muted-foreground">
                    Default is <span className="font-mono">~/Documents/ClaudeBuilds</span>; the
                    project folder will be created inside.
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Creating...
                  </>
                ) : (
                  "Create project"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
