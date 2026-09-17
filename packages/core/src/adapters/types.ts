import type {
  AgentCapabilities,
  AgentConnectionStatus,
  AttachmentRef,
  Provider,
  SessionSummary,
} from '@pagr/protocol';
import type { LocalActionDetail } from '../deviceFloor.js';
import type { FrameBody } from '../frames.js';
import type { JournalMeta } from '../journal.js';

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
      /**
       * Unredacted local facts (command, paths, cwd) for the device floor to classify against.
       * Stays on the Mac: `preview` is what the cloud is told. Optional so an adapter that cannot
       * produce it still works — the floor then falls back to the preview and the hints, which are
       * also computed locally.
       */
      local?: LocalActionDetail;
      expiresAt: string;
    }
  /**
   * One transcript frame: an assistant message, a tool call, a diff, a terminal block.
   *
   * The adapter produces the BODY and says where it read it; everything else — the sequence
   * number, the journal line, the seal, whether a v1 gateway means it stays local — belongs to
   * the dispatcher (`emitFrame`). An adapter never seals and never numbers.
   */
  | {
      kind: 'frame';
      sessionId: string;
      projectId: string;
      body: FrameBody;
      meta: JournalMeta;
      /**
       * The provider's own id for the record this came from. Supplying it is what makes a
       * transcript that is read twice produce one frame instead of two.
       */
      providerRecordId?: string;
      /** When it happened, if the provider said; otherwise the dispatcher's clock. */
      at?: string;
      /** Plaintext one-liner for the iMessage thread; only sent when iMessage is linked. */
      imessage?: string;
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
export type {
  AgentCapabilities,
  AgentConnectionStatus,
  AttachmentRef,
  LocalActionDetail,
  Provider,
  SessionSummary,
};
