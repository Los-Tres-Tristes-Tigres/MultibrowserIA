import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  BackgroundVariant,
  MarkerType,
  type Edge,
  type Connection,
  type Viewport,
} from "@xyflow/react";
import {
  MousePointer2,
  Hand,
  Minus,
  Plus,
  Maximize,
  X,
  Unplug,
  ArrowRight,
  Network,
} from "lucide-react";
import type { AppSnapshot } from "../../shared/types";
import { AgentNode, type FlowAgentNode } from "./AgentNode";
import { api } from "../api";

const nodeTypes = { browserAgent: AgentNode };
interface CanvasProps {
  snapshot: AppSnapshot;
  previews: Record<string, number>;
  activeEdge?: string;
  selectedId?: string;
  chatId?: string;
  onSelect(id?: string): void;
  onBrowser(id: string): void;
  onSettings(id: string): void;
  onChat(id: string, text: string): Promise<void>;
  onStop(id: string): void;
  onAdd(): void;
  refresh(): Promise<void>;
  report(error: string): void;
  onSaving(value: boolean): void;
}
function CanvasInner(props: CanvasProps) {
  const {
    snapshot: { project },
    previews,
    selectedId,
    chatId,
  } = props;
  const flow = useReactFlow<FlowAgentNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowAgentNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [pan, setPan] = useState(false);
  const [zoom, setZoom] = useState(project.viewport.zoom);
  const [edgeId, setEdgeId] = useState("");
  const [instruction, setInstruction] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  const previousChat = useRef("");
  const callbacks = useRef(props);
  callbacks.current = props;
  const stable = useRef({
    onBrowser: (id: string) => callbacks.current.onBrowser(id),
    onSettings: (id: string) => callbacks.current.onSettings(id),
    onChat: (id: string, text: string) => callbacks.current.onChat(id, text),
    onStop: (id: string) => callbacks.current.onStop(id),
  }).current;
  useEffect(() => {
    setNodes((old) =>
      project.agents.map((agent) => ({
        id: agent.id,
        type: "browserAgent",
        position:
          old.find((n) => n.id === agent.id)?.position || agent.position,
        dragHandle: ".drag-handle",
        selected: agent.id === selectedId,
        data: {
          agent,
          projectId: project.id,
          previewVersion: previews[agent.id] || 0,
          selectedTab: chatId === agent.id ? "Chat" : undefined,
          ...stable,
        },
      })),
    );
  }, [
    project.agents,
    project.id,
    previews,
    selectedId,
    chatId,
    setNodes,
    stable,
  ]);
  useEffect(() => {
    setEdges(
      project.connections.map((e) => ({
        ...e,
        type: "smoothstep",
        animated: e.id === props.activeEdge,
        className: e.id === props.activeEdge ? "edge-transfer" : "",
        style: {
          stroke: e.id === props.activeEdge ? "#31caff" : "#39809d",
          strokeWidth: e.id === props.activeEdge ? 3 : 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "#45bff4",
          width: 18,
          height: 18,
        },
      })),
    );
  }, [project.connections, props.activeEdge, setEdges]);
  useEffect(() => {
    if (chatId && chatId !== previousChat.current) {
      const a = project.agents.find((a) => a.id === chatId);
      if (a)
        void flow.fitView({
          nodes: [{ id: chatId }],
          duration: 400,
          maxZoom: 1,
          padding: 0.4,
        });
    }
    previousChat.current = chatId || "";
  }, [chatId, project.agents, flow]);
  const saveCanvas = useCallback(
    (viewport?: Viewport) => {
      const canvas = {
        positions: flow
          .getNodes()
          .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
        viewport: viewport || flow.getViewport(),
      };
      callbacks.current.onSaving(true);
      clearTimeout(debounce.current);
      const projectId = project.id;
      debounce.current = setTimeout(() => {
        pendingSave.current = pendingSave.current
          .catch(() => {})
          .then(() => api(`/projects/${projectId}/canvas`, "PATCH", canvas))
          .then(() => callbacks.current.onSaving(false))
          .catch((e) => {
            callbacks.current.onSaving(false);
            callbacks.current.report((e as Error).message);
          });
      }, 220);
    },
    [flow, project.id],
  );
  const connect = async (connection: Connection) => {
    try {
      await api(`/projects/${project.id}/connections`, "POST", {
        source: connection.source,
        target: connection.target,
        instruction: "",
      });
      await props.refresh();
    } catch (e) {
      props.report((e as Error).message);
    }
  };
  const selectedEdge = project.connections.find((e) => e.id === edgeId);
  const saveEdge = async (remove: boolean) => {
    try {
      await api(
        `/projects/${project.id}/connections/${edgeId}`,
        remove ? "DELETE" : "PATCH",
        remove ? undefined : { instruction },
      );
      setEdgeId("");
      await props.refresh();
    } catch (e) {
      props.report((e as Error).message);
    }
  };
  return (
    <main className="canvas-region">
      <ReactFlow<FlowAgentNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(connection) => void connect(connection)}
        defaultViewport={project.viewport}
        minZoom={0.15}
        maxZoom={2}
        panOnDrag={pan ? true : [1, 2]}
        selectionOnDrag={!pan}
        deleteKeyCode={null}
        nodesDraggable={!pan}
        onNodeClick={(_event, node) => {
          props.onSelect(node.id);
          setEdgeId("");
        }}
        onPaneClick={() => {
          props.onSelect(undefined);
          setEdgeId("");
        }}
        onNodeDragStop={() => saveCanvas()}
        onMoveEnd={(_event, viewport) => {
          setZoom(viewport.zoom);
          if (_event) saveCanvas(viewport);
        }}
        onEdgeClick={(_event, edge) => {
          setEdgeId(edge.id);
          setInstruction(
            project.connections.find((e) => e.id === edge.id)?.instruction ||
              "",
          );
        }}
        colorMode="dark"
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={23}
          size={1}
          color="#2b3842"
          bgColor="#10151a"
        />
        <MiniMap
          className="orbit-minimap"
          nodeColor={(node) =>
            (node.data as FlowAgentNode["data"]).agent.status ===
            "Needs Approval"
              ? "#f1bf52"
              : "#208fb9"
          }
          maskColor="#0c1118bb"
          bgColor="#111820"
          nodeBorderRadius={4}
          pannable
          zoomable
        />
      </ReactFlow>
      {project.agents.length === 0 && (
        <div className="canvas-empty">
          <Network size={43} strokeWidth={1.2} />
          <h2>Give your apps an agent.</h2>
          <p>
            Start with a browser. Connect another.
            <br />
            Let them work together.
          </p>
          <button className="button primary" onClick={props.onAdd}>
            <Plus size={17} />
            Add Browser Agent
          </button>
        </div>
      )}
      <div className="canvas-controls">
        <button
          className={!pan ? "active" : ""}
          onClick={() => setPan(false)}
          title="Select"
          aria-label="Select tool"
        >
          <MousePointer2 size={19} />
        </button>
        <button
          className={pan ? "active" : ""}
          onClick={() => setPan(true)}
          title="Pan"
          aria-label="Pan tool"
        >
          <Hand size={19} />
        </button>
        <span className="control-divider" />
        <button
          onClick={() =>
            void flow.zoomOut({ duration: 150 }).then(() => saveCanvas())
          }
          aria-label="Zoom out"
        >
          <Minus size={18} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          onClick={() =>
            void flow.zoomIn({ duration: 150 }).then(() => saveCanvas())
          }
          aria-label="Zoom in"
        >
          <Plus size={18} />
        </button>
        <span className="control-divider" />
        <button
          onClick={() =>
            void flow
              .fitView({ padding: 0.12, duration: 250, maxZoom: 1 })
              .then(() => saveCanvas())
          }
          title="Fit view"
          aria-label="Fit view"
        >
          <Maximize size={18} />
        </button>
      </div>
      {selectedEdge && (
        <div className="edge-inspector">
          <header>
            <h3>
              {project.agents.find((a) => a.id === selectedEdge.source)?.name}
              <ArrowRight size={14} />
              {project.agents.find((a) => a.id === selectedEdge.target)?.name}
            </h3>
            <button
              className="icon-button"
              aria-label="Close connection settings"
              onClick={() => setEdgeId("")}
            >
              <X size={16} />
            </button>
          </header>
          <label>
            Instructions for the next agent
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              placeholder="What should this agent do with the incoming result?"
            />
          </label>
          <footer>
            <button
              className="button ghost"
              onClick={() => void saveEdge(true)}
            >
              <Unplug size={14} />
              Disconnect
            </button>
            <button
              className="button primary"
              onClick={() => void saveEdge(false)}
            >
              Save
            </button>
          </footer>
        </div>
      )}
    </main>
  );
}
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
