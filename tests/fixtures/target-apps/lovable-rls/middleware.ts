// Stub middleware so the inventory's hasMiddleware flag flips for this
// fixture. Real apps would do auth/redirect/header work here.

import { NextResponse } from "next/server";

export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
