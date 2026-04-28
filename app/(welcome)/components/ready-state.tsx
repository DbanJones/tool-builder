import { CheckCircle2, FilePlus } from "lucide-react";
import Link from "next/link";

import { ProjectsPicker } from "@/components/features/projects-picker/projects-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The ready state on the welcome page doubles as a launcher: the picker
// lists every project in the DB so the novice can dive straight in, and
// the Create card sits next to it for new work.

export function ReadyState() {
  return (
    <div className="w-full max-w-2xl space-y-4">
      <ProjectsPicker
        title="Your projects"
        collapsable={false}
        persistKey="builder.welcome.projectsOpen"
        emptyContent={
          <Card>
            <CardHeader>
              <div className="mb-2 flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
                <CardTitle>Ready to build</CardTitle>
              </div>
              <CardDescription>
                Claude Code is installed and signed in. The Builder is ready to create your first
                project.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/new-project">
                <Button>
                  <FilePlus className="mr-1 h-4 w-4" aria-hidden="true" />
                  Create your first project
                </Button>
              </Link>
            </CardContent>
          </Card>
        }
      />
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Start something new</h3>
            <p className="text-xs text-muted-foreground">
              The Builder will scaffold a fresh folder + git repo + placeholder templates.
            </p>
          </div>
          <Link href="/new-project" className="shrink-0">
            <Button>
              <FilePlus className="mr-1 h-4 w-4" aria-hidden="true" />
              Create new project
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
