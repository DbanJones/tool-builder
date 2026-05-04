import { NewProjectForm } from "@/components/features/new-project/new-project-form";
import { ProjectsPicker } from "@/components/features/projects-picker/projects-picker";

// The home view doubles as a launcher: the create-project form is the
// primary, always-visible action; the existing-projects picker sits
// underneath as a collapsable card so the user can reopen prior work
// without losing focus on starting something new.

export function ReadyState() {
  return (
    <div className="w-full max-w-2xl space-y-4">
      <NewProjectForm
        title="Start something new"
        description="Name your project and choose where it lives. The Builder scaffolds the folder, initialises a git repo, and seeds the templates."
      />
      <ProjectsPicker
        title="Open an existing project"
        collapsable
        defaultOpen={true}
      />
    </div>
  );
}
