/**
 * The one place the frontend states Papertrail's password requirement.
 *
 * Mirrors `backend/app/accounts/password_policy.py`. The backend is the
 * authority -- it re-validates every one of these paths -- so this exists to
 * tell people the rule before they submit, and to keep the four password forms
 * (Change Password, Reset Password, Account Settings, Create Reviewer) from
 * drifting apart in wording or in the number they enforce.
 */

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 256

export const PASSWORD_REQUIREMENTS_TEXT =
  `Use at least ${MIN_PASSWORD_LENGTH} characters. A passphrase of a few unrelated `
  + 'words is easier to remember and harder to guess than a short password with '
  + 'symbol substitutions.'

export const PASSWORD_TOO_SHORT_MESSAGE =
  `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`

export function passwordMeetsPolicy(value: string): boolean {
  return value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH
}
