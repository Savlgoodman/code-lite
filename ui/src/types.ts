export type SessionStatus = "idle" | "running" | "approval" | "error";

export interface AgentSummary {
  configMode?: string;
  id: string;
  label: string;
  mode?: string;
  runtimeId?: string;
}

export interface Session {
  agent?: AgentSummary | null;
  archived?: boolean;
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  /** 会话绑定的工作区绝对路径（普通会话指向 ~/.code-lite/workspace） */
  workspace?: string;
  /** "general" = 普通会话；"project" = 用户指定的项目工作区 */
  workspaceKind?: "general" | "project" | string;
}

/** 进入对话时加载的 agent 信息 */
export interface SessionAgentInfo {
  id: string;
  label: string;
  adapterKind: "acp" | "nanobot";
  status: "available" | "experimental" | "missing_dependency" | string;
}

/** 可选的权限/访问模式 —— 来自 ACP session/new.modes */
export interface SessionMode {
  id: string;
  label: string;
  isDefault: boolean;
}

/** 可选的模型 —— 来自 ACP session/new.models */
export interface SessionModel {
  id: string;
  label: string;
  description?: string | null;
  isCurrent: boolean;
}

/** 可选的配置选项 —— 来自 ACP session/new.configOptions */
export interface SessionConfigOption {
  id: string;
  label: string;
  type: "enum" | "boolean" | "number";
  values?: string[] | null;
  currentValue?: string | number | boolean | null;
  valueLabels?: Record<string, string> | null;
}

/** 斜杠命令 —— 来自 ACP available_commands_update */
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  command: string;
}

/** 进入对话时加载的完整能力描述 */
export interface SessionCapabilities {
  agent: SessionAgentInfo;
  modes: SessionMode[];
  models: SessionModel[];
  configOptions: SessionConfigOption[];
  commands: SlashCommand[];
  fastModeConfigOption?: SessionConfigOption | null;
  inputCapabilities?: SessionInputCapabilities;
  modelFastSupport?: Record<string, boolean>;
}

export interface SessionInputCapabilities {
  text: boolean;
  image?: {
    supported: boolean;
    acceptedMimeTypes: string[];
    maxImagesPerTurn: number;
    maxImageBytesPerImage: number;
    maxImageBytesPerTurn: number;
    maxWidth: number;
    maxHeight: number;
    autoResize: boolean;
    source?: string;
    caveats?: string[];
  };
}

export interface MessageAttachment {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  sha256: string;
  previewUrl?: string;
  wasCompressed?: boolean;
  createdAt?: string;
}

export type UserContentBlock = TextInputBlock | ImageInputBlock;

export interface TextInputBlock {
  type: "text";
  text: string;
}

export interface ImageInputBlock {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  source: {
    kind: "attachment";
    attachmentId: string;
  };
  name?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
  wasCompressed?: boolean;
}

export interface ChatMessage {
  agent?: AgentSummary | null;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  updatedAt?: number;
  model?: Record<string, unknown>;
  reasoning?: string;
  streaming?: boolean;
  error?: string;
  toolCalls: ToolCallItem[];
  usage?: UsageStats;
  plan?: PlanSnapshot | null;
  runtimeEvents?: RuntimeEventRecord[];
  attachments?: MessageAttachment[];
}

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry {
  id?: string;
  content: string;
  priority?: "high" | "medium" | "low" | string;
  status: PlanEntryStatus;
}

export interface PlanSnapshot {
  entries: PlanEntry[];
  id?: string;
  markdown?: string;
  source?: string;
  title?: string;
  uri?: string;
}

export interface RuntimeEventRecord {
  createdAt?: number;
  direction?: string;
  method?: string;
  modeId?: string;
  raw?: unknown;
  rpcKind?: string;
  type: string;
  updateKind?: string;
}

export interface ToolCallItem {
  id: string;
  name: string;
  argumentsText: string;
  resultText?: string;
  status: "pending" | "running" | "complete" | "error" | "approval";
  risk?: "low" | "medium" | "high" | "blocked";
  error?: string;
  anchorOffset?: number;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileDiffSummary {
  added: number;
  artifactPath?: string;
  changeType?: "create" | "modify" | "delete" | "clear" | string;
  diffId: string;
  nativeChangeKind?: string | null;
  path: string;
  removed: number;
  toolCallId?: string;
}

export interface FileDiffArtifact extends FileDiffSummary {
  contentIndex?: number;
  conversationId?: string;
  createdAt?: number;
  newText: string;
  oldText?: string | null;
  schemaVersion?: number;
  turnId?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId?: string;
  name: string;
  argumentsText: string;
  risk: "low" | "medium" | "high" | "blocked";
  purpose: string;
  impact: string;
  risks: string[];
  rollback: string;
  plan?: PlanSnapshot;
}

export interface InputRequest {
  inputRequestId: string;
  mode: "form" | "url" | string;
  message: string;
  schema?: Record<string, unknown>;
  toolCallId?: string | null;
}

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  source?: string;
}

export interface BillingModelPrice {
  cachedReadCostPerToken?: number;
  cachedWriteCostPerToken?: number;
  currency: "USD" | string;
  inputCostPerToken?: number;
  litellmProvider?: string;
  mode?: string;
  outputCostPerToken?: number;
  sourceModelId: string;
}

export interface BillingPricesResult {
  currency: "USD" | string;
  expiresAt: number | null;
  fetchedAt: number | null;
  models: Record<string, BillingModelPrice>;
  source: string;
  stale: boolean;
}

export interface BillingUsageTotals {
  cachedReadTokens: number;
  cachedWriteTokens: number;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  turns: number;
  unknownCostTurns: number;
}

export interface BillingUsageModel extends BillingUsageTotals {
  key?: string;
  modelId: string;
  modelLabel: string;
  priceModelId?: string;
  runtime: string;
}

export interface BillingUsageSeriesPoint extends BillingUsageTotals {
  bucket: string;
  date?: string;
}

export interface BillingUsageEntry {
  agentId?: string;
  agentLabel?: string;
  confidence?: "measured" | "partial" | "estimated" | string;
  conversationId?: string;
  cost?: {
    baseEstimatedCostUsd?: number;
    billingMultiplier?: number;
    estimatedCostUsd?: number;
    matched?: boolean;
    priceModelId?: string;
  };
  createdAtIso?: string;
  fastMode?: {
    applied?: boolean | null;
    billingMultiplier?: number;
    configApplied?: boolean | null;
    displayRate?: string;
    enabled?: boolean;
    effective?: boolean | null;
    effectiveReason?: string | null;
    effectiveSource?: string | null;
    effectiveUnknown?: boolean | null;
    requested?: boolean;
    runtimeConfigId?: unknown;
    runtimeOptionPresent?: boolean | null;
    runtimeValue?: string;
    speedMode?: string;
  };
  id?: string;
  localDate?: string;
  localHour?: string;
  modelId?: string;
  modelLabel?: string;
  runtime?: string;
  timestamp?: number;
  turnId?: string;
  usage?: UsageStats;
  workspaceLabel?: string;
}

export interface BillingUsageSummary {
  currency: "USD" | string;
  date?: string;
  endDate?: string;
  models: BillingUsageModel[];
  recentEntries: BillingUsageEntry[];
  series: BillingUsageSeriesPoint[];
  startDate?: string;
  timezone?: string;
  totals: BillingUsageTotals;
}

export interface SystemProfileItem {
  label: string;
  value: string;
}

export interface SystemUsageMetric {
  detail?: string;
  id: "cpu" | "gpu" | "memory";
  label: string;
  value: number | null;
}

export interface SystemOverview {
  collectedAt: number;
  profile: SystemProfileItem[];
  usage: SystemUsageMetric[];
}

export interface ModelProviderModelsResult {
  endpoint: string;
  models: string[];
}

export type ModelProtocol = "openai" | "anthropic" | "openai_responses";
export type DefaultModelStrategy = "last_used" | "fixed";

export interface ModelCapabilities {
  audio: boolean;
  reasoning: boolean;
  text: boolean;
  tools: boolean;
  vision: boolean;
}

export interface ModelLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ModelGeneration {
  reasoningEffort: string;
  temperature: number;
}

export interface DiscoveredModel {
  id: string;
  label: string;
}

export interface ConfiguredModel {
  capabilities: ModelCapabilities;
  enabled: boolean;
  generation: ModelGeneration;
  id: string;
  label: string;
  limits: ModelLimits;
  model: string;
  modelPresetId: string;
  protocol: ModelProtocol;
  providerBaseUrl?: string;
  providerId: string;
  providerName?: string;
}

export interface ChatModelOption {
  id: string;
  label: string;
  model: string;
  providerId: string;
  providerName?: string;
  reasoningEffort?: string;
  source: "agent-runtime" | "product-config";
}

export interface AgentRuntimeModel {
  description?: string | null;
  id: string;
  label: string;
  source?: string;
}

export interface AgentRuntimeModelsResult {
  adapter: string;
  agentInfo?: Record<string, unknown> | null;
  command?: string[];
  currentModelId?: string | null;
  models: AgentRuntimeModel[];
}

export interface ConfiguredModelProvider {
  apiKeyPreview: string;
  baseUrl: string;
  discoveredModels: DiscoveredModel[];
  enabled: boolean;
  hasApiKey: boolean;
  id: string;
  lastModelsRefreshAt: number | null;
  models: ConfiguredModel[];
  modelsEndpoint: string;
  name: string;
  protocol: ModelProtocol;
}

export interface ModelSettingsState {
  configPath: string;
  defaultModelId: string | null;
  defaultStrategy: DefaultModelStrategy;
  effectiveDefaultModelId: string | null;
  hasModels: boolean;
  lastUsedModelId: string | null;
  models: ConfiguredModel[];
  nanobotConfigPath: string;
  providers: ConfiguredModelProvider[];
}

export interface SavedModelProviderResult {
  configPath: string;
  model: string;
  modelPreset: string;
  provider: string;
  settings?: ModelSettingsState;
}

export interface AppAboutGitInfo {
  branch: string;
  commit: string;
  remote: string;
}

export interface AppDataUsageItem {
  bytes: number;
  label: string;
  path: string;
  size: string;
}

export interface AppAboutInfo {
  agentAdapter: string;
  appVersion: string;
  backendVersion: string;
  dataDir: string;
  dataDirBytes: number;
  dataDirSize: string;
  dataUsage: AppDataUsageItem[];
  git: AppAboutGitInfo;
  runtimeEnv: string;
  workspace: string;
}

export interface AgentRuntimeDetected {
  command?: string[];
  detail?: string;
  missingCommand?: string[] | null;
  ok: boolean;
  source?: string;
  version?: string | null;
}

export interface AgentRuntimeManagedPackage {
  installedAt?: number | null;
  installedVersion?: string | null;
  name: string;
  path?: string;
  requestedVersion?: string;
}

export interface AgentRuntimeExecutableConfig {
  selectedPath?: string;
  source: "sdk" | "system" | string;
}

export interface AgentRuntimeConfig {
  adapter: string;
  canActivate?: boolean;
  canConfigure: boolean;
  canInstall: boolean;
  codexPath?: string;
  command: string[];
  configMode: string;
  detected: AgentRuntimeDetected;
  distribution: string;
  enabled: boolean;
  id: "codex" | "claude_code" | "opencode" | "nanobot" | string;
  isActive: boolean;
  label: string;
  managedPackage?: AgentRuntimeManagedPackage;
  mode: string;
  runtimeExecutable?: AgentRuntimeExecutableConfig;
  status: string;
}

export interface AgentRuntimeSettingsState {
  activeAdapter: string;
  acpPackageRoot?: string;
  configPath: string;
  nodeDetected: AgentRuntimeDetected;
  npmDetected: AgentRuntimeDetected;
  runtimeRoot: string;
  runtimes: AgentRuntimeConfig[];
}

export interface AcpPackageInfo {
  command: string[];
  installed: boolean;
  installedVersion?: string | null;
  label: string;
  latestVersion?: string | null;
  needsUpdate: boolean;
  packageDir: string;
  packageDirExists: boolean;
  packageDirIsEmpty: boolean;
  packageName: string;
  requestedVersion?: string | null;
  runtimeId: string;
}

export interface AcpRuntimeVersionInfo {
  command: string[];
  detected: boolean;
  label: string;
  runtimeId: string;
  version?: string | null;
}

export interface RuntimeExecutableOption {
  detected: boolean;
  id: string;
  kind: "sdk" | "system" | string;
  label: string;
  path: string;
  source: string;
  version?: string | null;
}

export interface RuntimeExecutableInfo {
  label: string;
  latestVersion?: string | null;
  options: RuntimeExecutableOption[];
  runtimeId: string;
  sdkPath: string;
  sdkVersion?: string | null;
  selectedId: string;
  selectedPath: string;
  selectedSource: string;
  selectedVersion?: string | null;
}

export interface AcpPackageSettingsState {
  checkedAt?: number | null;
  nodeDetected: AgentRuntimeDetected;
  npmDetected: AgentRuntimeDetected;
  packageRoot: string;
  packageRootExists: boolean;
  packageRootIsEmpty: boolean;
  packages: AcpPackageInfo[];
  runtimeExecutables?: RuntimeExecutableInfo[];
  runtimeVersions: AcpRuntimeVersionInfo[];
}

export interface AcpRuntimeSessionStatus {
  acpServerKind: string;
  activePrompt: boolean;
  conversationId: string;
  nativeSessionId: string;
  runtime: string;
  state: string;
  workspace?: string;
}

export interface AcpRuntimeConnectionStatus {
  acpServerKind: string;
  activeSessions: number;
  configMode: string;
  conversationKey: string;
  latestActivityAt?: number | null;
  pid?: number | null;
  ready: boolean;
  rootPid?: number | null;
  spawnedAt?: string | null;
  runtime: string;
  sessions: AcpRuntimeSessionStatus[];
  workspace: string;
}

export interface AcpRuntimeStatus {
  connectionMode: string;
  connections: AcpRuntimeConnectionStatus[];
}

export interface AcpRuntimeDisconnectSummary {
  attemptedConnections: number;
  closedConnections: number;
  failedConnections: number;
}

export interface AcpRuntimeDisconnectResult {
  closed: boolean;
  connections: Array<{
    closed: boolean;
    pid?: number | null;
    reason: string;
    runtime: string;
    sessions: string[];
  }>;
  failed?: Array<{
    closed: boolean;
    pid?: number | null;
    runtime: string;
  }>;
  reason: string;
  runtime?: string;
  summary: AcpRuntimeDisconnectSummary;
}

export interface LogFileInfo {
  bytes: number;
  category: string;
  exists: boolean;
  name: string;
  path: string;
  size: string;
}

export interface LogFilesResult {
  files: LogFileInfo[];
  logsDir: string;
}

export interface LogEntry {
  category?: string;
  conversationId?: string;
  fields?: Record<string, unknown>;
  id?: string;
  level?: string;
  message?: string;
  nativeSessionId?: string;
  runtime?: string;
  source?: string;
  stage?: string;
  timestamp?: string;
  turnId?: string;
}

export interface LogTailResult {
  entries: LogEntry[];
  logsDir: string;
}

export type AgentEvent =
  | {
      type: "conversation.turn.started";
      conversationId: string;
      turnId: string;
      session: Session;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
    }
  | {
      type: "agent.run.started";
      conversationId: string;
      turnId: string;
      model?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.text.delta";
      conversationId: string;
      turnId: string;
      delta: string;
    }
  | {
      type: "agent.text.completed";
      conversationId: string;
      turnId: string;
      resuming?: boolean;
    }
  | {
      type: "agent.reasoning.delta";
      conversationId: string;
      turnId: string;
      delta: string;
    }
  | {
      type: "agent.reasoning.completed";
      conversationId: string;
      turnId: string;
      content?: string;
    }
  | {
      type: "agent.tool.started";
      conversationId: string;
      turnId: string;
      toolCallId: string;
      name: string;
      arguments?: unknown;
      metadata?: Record<string, unknown>;
      plan?: PlanSnapshot;
      risk?: ToolCallItem["risk"];
    }
  | {
      type: "agent.tool.delta";
      conversationId: string;
      turnId: string;
      toolCallId: string;
      name: string;
      status?: string;
      progress?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.tool.completed";
      conversationId: string;
      turnId: string;
      toolCallId: string;
      name: string;
      result?: unknown;
      metadata?: Record<string, unknown>;
      plan?: PlanSnapshot;
    }
  | {
      type: "agent.tool.failed";
      conversationId: string;
      turnId: string;
      toolCallId: string;
      name: string;
      error?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "approval.required";
      conversationId: string;
      turnId: string;
      approvalId: string;
      toolCallId?: string;
      name: string;
      arguments?: unknown;
      argumentsText?: string;
      risk: "low" | "medium" | "high" | "blocked";
      purpose: string;
      impact: string;
      risks: string[];
      rollback: string;
      plan?: PlanSnapshot;
    }
  | {
      type: "agent.input.required";
      conversationId: string;
      turnId: string;
      inputRequestId: string;
      mode: "form" | "url" | string;
      message: string;
      schema?: Record<string, unknown>;
      toolCallId?: string | null;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.input.completed";
      conversationId: string;
      turnId: string;
      inputRequestId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.plan.updated";
      conversationId: string;
      turnId: string;
      metadata?: Record<string, unknown>;
      plan: PlanSnapshot;
    }
  | {
      type: "agent.mode.updated";
      conversationId: string;
      turnId: string;
      metadata?: Record<string, unknown>;
      modeId: string;
    }
  | {
      type: "agent.command.available.updated";
      conversationId: string;
      turnId: string;
      commands: SlashCommand[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.config.updated";
      conversationId: string;
      turnId: string;
      configOptions: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.raw.update";
      conversationId: string;
      turnId: string;
      metadata?: Record<string, unknown>;
      raw?: unknown;
      updateKind: string;
    }
  | {
      type: "agent.raw.rpc";
      conversationId: string;
      turnId: string;
      direction?: string;
      method: string;
      metadata?: Record<string, unknown>;
      raw?: unknown;
      rpcKind?: string;
      updateKind?: string;
    }
  | {
      type: "agent.context.updated";
      conversationId: string;
      turnId: string;
      context: UsageStats;
    }
  | {
      type: "agent.session.updated";
      conversationId: string;
      turnId: string;
      session?: Session;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.run.completed";
      conversationId: string;
      turnId: string;
      model?: Record<string, unknown>;
      result?: unknown;
      session?: Session;
      usage?: unknown;
    }
  | {
      type: "agent.run.failed";
      conversationId: string;
      turnId: string;
      diagnostic?: Record<string, unknown>;
      error?: string;
      session?: Session;
    };
