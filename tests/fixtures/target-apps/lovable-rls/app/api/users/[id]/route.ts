// Tea / Base44 reproduction: a Route Handler that exposes user records
// without any server-side authentication or authorization check. Anyone
// who can reach the URL can read any user.

import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  // Deliberately no getServerSession / supabase.auth.getUser / role check.
  // The defect: this is the API the rls-missing detector's data lives
  // behind.
  return NextResponse.json({ id: params.id, email: "leak@example.com" });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  return NextResponse.json({ deleted: params.id });
}
