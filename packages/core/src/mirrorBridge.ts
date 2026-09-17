import type { ProjectStatus } from '@pagr/protocol';

/**
 * Where the transcript mirror asks "which project is this, and may I say so?".
 *
 * The mirror lives in `@pagr/bridge-adapter-claude` and the answer lives in the daemon's
 * `ProjectRegistry` and `Dispatcher`. They are in one process but in different packages, and the
 * adapter is constructed before the daemon exists, so they meet here — exactly as the Claude
 * channel and the daemon meet at `getChannelBridge()`.
 *
 * Two rules this seam exists to keep:
 *
 *   - **The adapter never learns the device salt.** It asks for a project and is handed ids. The
 *     salt that derives them stays in `ProjectRegistry`.
 *   - **`path` never leaves the Mac.** It is here because the mirror has to decide which
 *     transcripts belong to which project and what to call a directory on the phone; the frame
 *     and the summary carry the id and the display name, never the path.
 *
 * Unwired — an adapter with no daemon, and every test that does not opt in — `projectFor` answers
 * null for everything, which turns the mirror off rather than guessing at project ids.
 */

/** `=0` turns the whole mirror off: no discovery, no tailing, no frames. */
export const MIRROR_ENV = 'PAGR_MIRROR';
/**
 * `=0` keeps the pre-B5 behaviour, where a session whose directory is in no registered project is
 * not reported at all. Left on, such a session is reported with control `none` and no frames.
 */
export const MIRROR_UNREGISTERED_ENV = 'PAGR_MIRROR_UNREGISTERED';

/** The project a mirrored session belongs to, as the daemon sees it. */
export interface MirrorProject {
  projectId: string;
  /** LOCAL ONLY: the registered project root, or the session's own directory when there is none. */
  path: string;
  displayName: string;
  status: ProjectStatus;
  /**
   * A `project.register_handle` handle for an unregistered directory, so one tap on the phone
   * registers it. Absent when the directory is already a project, or when remote project pick is
   * off on this Mac (`PAGR_REMOTE_PROJECT_PICK=0`) — in which case there is nothing to offer.
   */
  handle?: string;
}

/** What `pagr doctor` prints for the mirror line. Counts and ages; never a path. */
export interface MirrorStatus {
  enabled: boolean;
  /** Sessions being mirrored right now. */
  sessions: number;
  /** Transcript files being followed across all of them. */
  filesWatched: number;
  /** When the mirror last produced a frame, or null if it has produced none. */
  lastFrameAt: string | null;
  /** Record types this bridge has no frame for. A non-zero count means Claude Code moved on. */
  unknownRecordTypes: number;
}

export interface MirrorBridge {
  /**
   * True once a daemon has installed its own implementation.
   *
   * The adapter is built before the daemon is, and a mirror that started reading `~/.claude`
   * before anybody could tell it which directories are projects would be doing a stranger's
   * filesystem walk for nothing — and would do it in every test that constructs an adapter. So
   * the mirror idles until this flips, and the next poll picks the work up.
   */
  readonly wired: boolean;
  /** The project for a session's working directory, or null when the mirror must stay quiet. */
  projectFor(cwd: string): MirrorProject | null;
  /** The mirror publishes its own status here; `pagr doctor` reads it back through the daemon. */
  report(status: MirrorStatus): void;
  /** The last reported status, or null when no mirror is running in this process. */
  status(): MirrorStatus | null;
}

class UnwiredMirrorBridge implements MirrorBridge {
  readonly wired = false;
  private last: MirrorStatus | null = null;
  projectFor(): MirrorProject | null {
    return null;
  }
  report(status: MirrorStatus): void {
    this.last = status;
  }
  status(): MirrorStatus | null {
    return this.last;
  }
}

let shared: MirrorBridge = new UnwiredMirrorBridge();

export function getMirrorBridge(): MirrorBridge {
  return shared;
}

/** The daemon installs the registry-backed implementation at startup. */
export function setMirrorBridge(bridge: MirrorBridge): void {
  shared = bridge;
}

/** Back to the unwired default. Daemon shutdown and tests. */
export function resetMirrorBridge(): void {
  shared = new UnwiredMirrorBridge();
}
