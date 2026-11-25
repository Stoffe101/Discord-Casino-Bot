/**
 * An error whose message is safe and friendly to show to a Discord user.
 * Anything else is treated as an internal error: logged with details, shown generically.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code: string = 'user_error',
    readonly title: string = 'Not quite',
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export class InsufficientFundsError extends UserError {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(
      `You need **${needed.toLocaleString('en-US')}** chips but only have **${available.toLocaleString('en-US')}** available.`,
      'insufficient_funds',
      'Not enough chips',
    );
    this.name = 'InsufficientFundsError';
  }
}

/** A control was used after the state it belonged to moved on (double-click, old message, etc.). */
export class StaleActionError extends UserError {
  constructor(message = 'That button is out of date — the table has already moved on.', title = 'The table moved on') {
    super(message, 'stale_action', title);
    this.name = 'StaleActionError';
  }
}

export class NotYourTurnError extends UserError {
  constructor(message = "It isn't your turn yet.") {
    super(message, 'not_your_turn', 'Hold on');
    this.name = 'NotYourTurnError';
  }
}

export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError;
}
