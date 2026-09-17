import type {
  AgentCapabilities,
  AgentConnectionStatus,
  ApprovalOption,
  AttachmentRef,
  Provider,
  SessionSummary,
  SessionSummaryV2,
} from '@pagr/protocol';
import type { LocalActionDetail } from '../deviceFloor.js';
import type { FrameBody, FrameQuestion } from '../frames.js';
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
  /**
   * A session's state. `SessionSummaryV2` so an adapter can say how much of it Pagr may drive —
   * a mirrored Codex TUI thread is `mirror_only`, `origin: 'terminal'`. Every added field is
   * optional, so an adapter that only knows v1 keeps compiling and keeps meaning what it meant.
   */
  | { kind: 'session'; session: SessionSummaryV2 }
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
      /** v2. The agent's own option list, in the agent's order. The phone renders exactly these. */
      options?: ApprovalOption[];
      /**
       * Where this request reached us. `mirror` means the agent asked EVERY subscriber and the
       * thread's owner (a terminal, an IDE) can answer it too: the bridge may relay it, but a
       * silence from the phone is never an answer, and the owner answering first wins.
       */
      source?: 'owned' | 'mirror';
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
      /** v2. Somebody answered it somewhere else — the phone dismisses rather than errors. */
      answeredElsewhere?: boolean;
    }
  /**
   * The agent asked the user a question (Codex `item/tool/requestUserInput`, Claude's
   * `AskUserQuestion`). The body is a `question` frame; `answerable: false` says only the Mac can
   * answer it, which is the honest answer for a thread we merely mirror.
   */
  | {
      kind: 'question_asked';
      sessionId: string;
      projectId: string;
      providerRequestId: string;
      questions: FrameQuestion[];
      answerable: boolean;
      reason?: string;
      /** Per question: the answer must never be echoed back or stored in the clear. */
      secret: boolean[];
      expiresAt: string;
    };

export interface CodingAgentAdapter {
  readonly provider: Provider;
  probe(): Promise<AgentConnectionStatus>;
  listSessions(): Promise<SessionSummaryV2[]>;
  startSession(input: StartSessionInput): Promise<SessionSummaryV2>;
  sendInstruction(
    input: SendInstructionInput,
  ): Promise<{ delivered: 'steered' | 'queued' | 'new_turn' }>;
  stopSession(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<SessionSummaryV2 | null>;
  respondToApproval(input: {
    approvalId: string;
    providerRequestId: string;
    decision: 'allow' | 'deny';
    /**
     * v2. The exact option the user chose, from `approval.requested.options`. `decision` stays
     * the truth for a v1 cloud that has never heard of options.
     */
    optionId?: string;
  }): Promise<void>;
  /**
   * Answer a question the agent asked. Indexes, not text: the options came from the agent.
   * Absent on an adapter whose agent cannot be asked questions.
   */
  answerQuestion?(input: {
    providerRequestId: string;
    answers: Array<{ questionIndex: number; optionIndexes: number[]; freeText?: string }>;
  }): Promise<void>;
  subscribe(emit: (e: AdapterEvent) => void): () => void;
  shutdown(): Promise<void>;
}

// Re-exported so adapter packages can import everything they need from one place.
export type {
  AgentCapabilities,
  AgentConnectionStatus,
  ApprovalOption,
  AttachmentRef,
  LocalActionDetail,
  Provider,
  SessionSummary,
  SessionSummaryV2,
};
