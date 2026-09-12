import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AppSnapshot, OrbitEvent } from "../shared/types";
import { api } from "./api";

export function useOrbit() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [previews, setPreviews] = useState<Record<string, number>>({});
  const [activeEdge, setActiveEdge] = useState<string>();
  const currentProject = useRef(localStorage.getItem("orbit.project") || "");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const data = await api<AppSnapshot>(
        `/snapshot${currentProject.current ? `?projectId=${encodeURIComponent(currentProject.current)}` : ""}`,
      );
      if (ticket !== sequence.current) return;
      currentProject.current = data.project.id;
      localStorage.setItem("orbit.project", data.project.id);
      setSnapshot(data);
    } catch (e) {
      if (ticket !== sequence.current) return;
      if (
        currentProject.current &&
        (e as Error).message === "Workspace not found."
      ) {
        currentProject.current = "";
        void refresh();
        return;
      }
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const socket = io({ transports: ["websocket", "polling"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let edgeTimer: ReturnType<typeof setTimeout> | undefined;
    socket.on("connect", () => {
      setConnected(true);
      void refresh();
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("orbit:event", (event: OrbitEvent) => {
      if (event.projectId !== currentProject.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 65);
      if (event.type === "handoff") {
        setActiveEdge(event.edgeId);
        clearTimeout(edgeTimer);
        edgeTimer = setTimeout(() => setActiveEdge(undefined), 5000);
      }
    });
    socket.on(
      "orbit:preview",
      (event: { projectId: string; agentId: string; timestamp: number }) => {
        if (event.projectId === currentProject.current)
          setPreviews((p) => ({ ...p, [event.agentId]: event.timestamp }));
      },
    );
    return () => {
      socket.disconnect();
      clearTimeout(timer);
      clearTimeout(edgeTimer);
    };
  }, [refresh]);
  const selectProject = (id: string) => {
    currentProject.current = id;
    setSnapshot(undefined);
    setPreviews({});
    void refresh();
  };
  const perform = async <T>(operation: () => Promise<T>) => {
    try {
      const result = await operation();
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  return {
    snapshot,
    error,
    setError,
    connected,
    previews,
    activeEdge,
    refresh,
    selectProject,
    perform,
  };
}
