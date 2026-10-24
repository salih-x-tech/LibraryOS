import type { NextRequest } from "next/server";
import { recoveryRequest } from "@/server/recovery-http";
export const runtime = "nodejs";
export function POST(request: NextRequest) { return recoveryRequest(request, "verify-email"); }
