import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json([], { status: 401 });
  const projects = await prisma.project.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json(projects);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name, description } = await req.json();
  const project = await prisma.project.create({
    data: { name, description, userId: session.user.id },
  });
  return NextResponse.json(project);
}