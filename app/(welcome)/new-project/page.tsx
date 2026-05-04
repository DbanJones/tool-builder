"use client";

import { NewProjectForm } from "@/components/features/new-project/new-project-form";
import { ProjectsPicker } from "@/components/features/projects-picker/projects-picker";

// /new-project mirrors the welcome layout: create form expanded as the
// primary action, existing-projects picker collapsable underneath.
// Effectively a deeper-linkable alias of the home view; if we ever drop
// this route, the + button in the tab bar can point to / instead.

export default function NewProjectPage() {
  return (
    <main className="flex min-h-full justify-center overflow-y-auto bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        <NewProjectForm />
        <ProjectsPicker
          title="Open an existing project"
          collapsable
          defaultOpen={false}
        />
      </div>
    </main>
  );
}
