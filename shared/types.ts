export type ProviderId = "openai" | "openrouter" | "gemini";
export interface ProviderConfig {
  provider: ProviderId;
  model: string;
}
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  available: boolean;
  envName: string;
  defaultModel: string;
  models: string[];
}
export type AgentStatus =
  | "Idle"
  | "Thinking"
  | "Navigating"
  | "Reading"
  | "Typing"
  | "Waiting"
  | "Needs Approval"
  | "Completed"
  | "Error";
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "handoff";
  text: string;
  timestamp: string;
  runId?: string;
}
export interface ObservableLogEvent {
  id: string;
  timestamp: string;
  agentId?: string;
  runId?: string;
  level: "info" | "error" | "success";
  message: string;
}
export interface Artifact {
  id: string;
  name: string;
  kind: "download" | "result";
  relativePath: string;
  createdAt: string;
}
export interface AgentResult {
  type: string;
  summary: string;
  data: Record<string, unknown>;
  sourceUrl: string;
}
export interface BrowserAgentRecord {
  id: string;
  name: string;
  url: string;
  preset: string;
  provider: ProviderConfig;
  position: { x: number; y: number };
  instructions: string;
  status: AgentStatus;
  currentAction: string;
  currentUrl: string;
  pageTitle: string;
  browserOpen: boolean;
  chatHistory: ChatMessage[];
  logs: ObservableLogEvent[];
  artifacts: Artifact[];
  lastResult?: AgentResult;
  activeRunId?: string;
  waitingForReply?: boolean;
  createdAt: string;
}
export interface AgentConnection {
  id: string;
  source: string;
  target: string;
  instruction: string;
}
export interface Workflow {
  id: string;
  name: string;
  startAgentId: string;
  instruction: string;
}
export interface AgentMessage {
  id: string;
  runId: string;
  sourceAgentId: string;
  targetAgentId: string;
  type: string;
  instruction: string;
  data: Record<string, unknown>;
  summary: string;
  timestamp: string;
}
export interface BrowserAction {
  selector: string;
  description: string;
  method: string;
  arguments: string[];
}
export interface ApprovalRequest {
  id: string;
  agentId: string;
  runId: string;
  title: string;
  description: string;
  url: string;
  action: BrowserAction | { method: "goto"; url: string };
  fingerprint: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  resolvedAt?: string;
}
export interface WorkflowRun {
  id: string;
  workflowId?: string;
  instruction: string;
  agentIds: string[];
  currentAgentId: string;
  status:
    | "running"
    | "waiting"
    | "completed"
    | "cancelled"
    | "error"
    | "interrupted";
  createdAt: string;
  finishedAt?: string;
  error?: string;
}
export interface ProjectState {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  agents: BrowserAgentRecord[];
  connections: AgentConnection[];
  workflows: Workflow[];
  viewport: { x: number; y: number; zoom: number };
  logs: ObservableLogEvent[];
  runs: WorkflowRun[];
  approvals: ApprovalRequest[];
  messages: AgentMessage[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  agentCount: number;
}
export interface AppSnapshot {
  project: ProjectState;
  projects: ProjectSummary[];
  providers: ProviderInfo[];
  workspacePath: string;
}
export interface OrbitEvent {
  projectId: string;
  type: "state" | "log" | "approval" | "handoff" | "browser";
  agentId?: string;
  edgeId?: string;
}
export const isBusy = (status: AgentStatus) =>
  [
    "Thinking",
    "Navigating",
    "Reading",
    "Typing",
    "Waiting",
    "Needs Approval",
  ].includes(status);
