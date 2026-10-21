import type { NextRequest } from "next/server";
import { recoveryCompletion } from "@/server/recovery-http";
export const runtime = "nodejs";
export function POST(request: NextRequest) { return recoveryCompletion(request, "reset-password"); }
