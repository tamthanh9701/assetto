import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  return (
    <div className="flex h-screen">
      <AppSidebar user={session.user} />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}