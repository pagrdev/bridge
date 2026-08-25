import type {
  AgentCapabilities,
  AgentConnectionStatus,
  AttachmentRef,
  Provider,
  SessionSummary,
} from '@pagr/protocol';

export interface LocalProject {
  projectId: string;
  path: string;
  displayName: string;
}

export interface StartSessionInput {
  sessionId: string;
  project: LocalProject;
  instruction: string;
  localImagePaths: string[];
  readOnly: boolean;
  displayName?: string;
}

export interface SendInstructionInput {
  sessionId: string;
  instruction: string;
  mode: 'auto' | 'steer' | 'queue';
  localImagePaths: string[];
}

export type AdapterEvent =
  | { kind: 'session'; session: SessionSummary }
  | {
      kind: 'session_event';
      sessionId: string;
      projectId: string;
      type:
        | 'started'
        | 'progress'
        | 'agent_message'
        | 'needs_input'
        | 'completed'
        | 'failed'
        | 'stopped'
        | 'queued_followup'
        | 'followup_delivered';
      summary: string;
      providerEventId?: string;
    }
  | {
      kind: 'approval_requested';
      approvalId: string;
      sessionId: string;
      projectId: string;
      providerRequestId: string;
      actionType: 'command_execution' | 'file_change' | 'permission' | 'tool_use' | 'other';
      preview: string;
      hints: Partial<{
        touchesOutsideProject: boolean;
        networkAccess: boolean;
        destructive: boolean;
        gitPush: boolean;
        packageInstall: boolean;
        secretsTouch: boolean;
        productionHint: boolean;
      }>;
      expiresAt: string;
    }
  | {
      kind: 'approval_resolved_locally';
      approvalId: string;
      resolution: 'allowed' | 'denied' | 'timed_out' | 'canceled';
    };

export interface CodingAgentAdapter {
  readonly provider: Provider;
  probe(): Promise<AgentConnectionStatus>;
  listSessions(): Promise<SessionSummary[]>;
  startSession(input: StartSessionInput): Promise<SessionSummary>;
  sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }>;
  stopSession(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<SessionSummary | null>;
  respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
  }): Promise<void>;
  subscribe(emit: (e: AdapterEvent) => void): () => void;
  shutdown(): Promise<void>;
}

// Re-exported so adapter packages can import everything they need from one place.
export type { AgentCapabilities, AgentConnectionStatus, AttachmentRef, Provider, SessionSummary };
