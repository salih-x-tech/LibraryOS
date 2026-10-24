import type { NextRequest } from "next/server";
import { profileHttp } from "@/server/profile-http";
export const runtime = "nodejs";
export function GET(request: NextRequest) { return profileHttp(request); }
export function PATCH(request: NextRequest) { return profileHttp(request); }
