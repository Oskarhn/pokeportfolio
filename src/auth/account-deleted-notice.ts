/**
 * A one-shot, in-memory note that this tab just deleted the signed-in account, so the sign-in page
 * the route guard lands on can say so (P152). Deliberately not stored anywhere: no localStorage, no
 * sessionStorage, no URL parameter — the fact "an account was just deleted here" is not something
 * the browser should keep. It lives exactly as long as the single-page app does, which is long
 * enough to cross the guard's redirect to /login and no longer.
 *
 * It is read without being consumed (React may invoke a state initializer twice in development) and
 * cleared when the sign-in page unmounts.
 */
let accountJustDeleted = false

export function markAccountDeleted(): void {
  accountJustDeleted = true
}

export function accountWasJustDeleted(): boolean {
  return accountJustDeleted
}

export function clearAccountDeletedNotice(): void {
  accountJustDeleted = false
}
