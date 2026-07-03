import { prisma } from "./prisma";

const DAILY_LIMIT = process.env.NODE_ENV === "production" ? 20 : 100;

export async function checkRateLimit(userId: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const used = await prisma.generation.count({
    where: {
      scene: { project: { userId } },
      createdAt: { gte: today },
    },
  });

  return {
    allowed: used < DAILY_LIMIT,
    used,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - used),
  };
}