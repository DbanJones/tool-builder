import { CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ReadyState() {
  return (
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
          <Button>Create your first project</Button>
        </Link>
      </CardContent>
    </Card>
  );
}
