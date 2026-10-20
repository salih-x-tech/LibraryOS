import type { NextRequest } from "next/server";
import { authMutation } from "@/server/auth-http";
export const runtime = "nodejs";
export function POST(request: NextRequest) { return authMutation(request, "login"); }
