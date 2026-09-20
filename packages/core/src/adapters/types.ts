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
import type { CodexThread } from '../handoff/receiver.js';
import type { JournalMeta } from '../journal.js';
import type { RunOnceInput, RunOnceResult } from './runOnce.js';

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
  | {
      kind: 'session';
      session: SessionSummaryV2;
      /**
       * The bridge did not start this one — it is the person's own terminal or IDE session, found
       * by the permission hook or the transcript mirror. It can be reported and its prompts can be
       * relayed; it cannot be instructed, stopped or resumed (`Dispatcher.assertOurSession`).
       */
      adopted?: boolean;
      /**
       * The session's working directory. Stays on this Mac: it is recorded so `pagr sessions` can
       * name the folder and so the working-tree rules still apply, and it is never part of any
       * event that leaves the device.
       */
      localCwd?: string;
    }
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
      /**
       * v2. The agent's own option list, in the agent's order. The phone renders exactly these.
       * Omitted by an adapter that only knows allow/deny; the phone then falls back to the two
       * options every agent has.
       */
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
      /**
       * The agent's last word of this turn: an assistant message that calls no tool.
       *
       * Both agents end a turn that way, so the adapter can say it at the moment it produces the
       * frame rather than the dispatcher inferring it from a status change that arrives later.
       * It decides which single frame of a turn carries the plaintext `imessage` line — without
       * it the thread would get one message per paragraph the model wrote.
       */
      endsTurn?: boolean;
    }
  | {
      kind: 'approval_resolved_locally';
      approvalId: string;
      resolution: 'allowed' | 'denied' | 'timed_out' | 'canceled';
      /**
       * v2. Somebody answered it somewhere else — the phone dismisses rather than errors. What
       * the adapter observed, never what it did: a `tool_result` arriving for a prompt Pagr never
       * answered, or a mirrored thread's owner answering first.
       */
      answeredElsewhere?: boolean;
      /** Where that answer came from, when the adapter knows. Defaults to the provider itself. */
      source?: 'terminal' | 'provider';
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
      /**
       * The provider's own id for the `question` frame the dispatcher journals. Supplying it is
       * what makes an adapter that ALSO emits the frame itself (Codex does, from its item stream)
       * produce one journal line rather than two.
       */
      providerRecordId?: string;
      /** Frame metadata for that frame. Defaults to `{ source: 'stdio' }`. */
      meta?: JournalMeta;
    }
  /**
   * A question ended without the phone answering it: the agent withdrew the request, our own
   * timer denied it, or somebody answered it in the terminal. What the adapter OBSERVED, never
   * what it did — the dispatcher consumes the pending entry and tells the phone.
   */
  | {
      kind: 'question_resolved_locally';
      sessionId: string;
      providerRequestId: string;
      resolution: 'answered' | 'timed_out' | 'canceled';
      answeredElsewhere?: boolean;
      source?: 'terminal' | 'provider';
      reason?: string;
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
     * the truth for a v1 cloud that has never heard of options, and an adapter that is handed an
     * option it does not recognise must behave exactly as it did before options existed.
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
  /**
   * One bounded, headless run: a prompt in, a file on disk and whatever the agent printed out.
   *
   * Never a session — see `runOnce.ts`. Optional, because an adapter whose agent cannot be run
   * headlessly is still a perfectly good adapter; the handoff engine falls back to the
   * sender-writes path (spec §3) when the receiver has none.
   */
  runOnce?(input: RunOnceInput): Promise<RunOnceResult>;
  /**
   * One session's raw transcript, for a provider that keeps it inside a server instead of in a
   * file on this Mac.
   *
   * Codex is the only one: its threads live in the app-server, so the receiver-writes path
   * (`handoff/receiver.ts`) asks for the thread itself and dumps it to `PAGR_HOME/tmp` for the
   * length of one headless run. Claude has no need of it — its transcript is already a `.jsonl`
   * on disk — so the method is optional, and an adapter without one simply cannot be handed off
   * FROM through the receiver path (`no_transcript`, never a throw).
   *
   * Nothing read here is sealed or sent. The shape is structural on purpose: `core` describes
   * only the fields a dump walks, and the adapter owns the real type.
   */
  readThread?(providerSessionId: string): Promise<CodexThread | null | undefined>;
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
