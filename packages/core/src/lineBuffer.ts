/**
 * Incremental newline splitter: feed chunks, get whole lines back.
 *
 * Every stdio protocol this bridge speaks is newline-delimited JSON — Codex's app-server, Claude
 * Code's `stream-json`, and the Pagr channel server's JSON-RPC — and each of them used to carry
 * its own three-line splitter. One implementation, one set of tests, no per-protocol drift over
 * what a trailing partial line means.
 */
export class LineBuffer {
  private buf = '';

  /** Whole lines completed by this chunk, in order. The trailing partial stays buffered. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i = this.buf.indexOf('\n');
    while (i >= 0) {
      out.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
      i = this.buf.indexOf('\n');
    }
    return out;
  }

  /** Whatever never got its newline (EOF). Null when it is empty or only whitespace. */
  flush(): string | null {
    const rest = this.buf;
    this.buf = '';
    return rest.trim() === '' ? null : rest;
  }
}
