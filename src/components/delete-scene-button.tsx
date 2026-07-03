"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

export function DeleteSceneButton({ sceneId }: { sceneId: string }) {
  const router = useRouter();

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this scene?")) return;
    const res = await fetch(`/api/scenes/${sceneId}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Scene deleted");
      router.refresh();
    } else {
      toast.error("Failed to delete scene");
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleDelete}>
      <Trash2 className="w-4 h-4" />
    </Button>
  );
}