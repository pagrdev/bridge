/** Exit codes: 0 ok · 1 error · 2 usage · 3 daemon not running · 4 not paired · 5 precondition */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  daemonDown: 3,
  notPaired: 4,
  precondition: 5,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const daemonDownError = (): CliError =>
  new CliError(
    'the pagr daemon is not running',
    EXIT.daemonDown,
    'start it with `pagr daemon install` (or `pagr daemon run` in the foreground)',
  );

export const notPairedError = (): CliError =>
  new CliError('this Mac is not paired with a Pagr account', EXIT.notPaired, 'run `pagr connect`');
