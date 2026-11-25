// Turns API failures into a message for the user.
import { ApiError, isNetworkError } from "../api/app";
import { t, type MessageKey } from "../i18n";

/** Better Auth and gateway error codes with a translated message. */
const known: Record<string, MessageKey> = {
  invalid_email_or_password: "error.invalidCredentials",
  invalid_username_or_password: "error.invalidCredentials",
  invalid_password: "error.invalidPassword",
  invalid_code: "error.invalidCode",
  invalid_two_factor_code: "error.invalidCode",
  invalid_backup_code: "error.invalidCode",
  invalid_otp: "error.invalidCode",
  otp_expired: "error.codeExpired",
  too_many_attempts: "error.tooManyRequests",
  password_too_short: "error.passwordTooShort",
  password_too_long: "error.passwordTooLong",
  user_already_exists: "error.userExists",
  user_already_exists_use_another_email: "error.userExists",
  username_is_already_taken: "error.usernameTaken",
  username_is_already_taken_please_try_another: "error.usernameTaken",
  invalid_username: "error.invalidUsername",
  username_too_short: "error.invalidUsername",
  username_too_long: "error.invalidUsername",
  email_not_verified: "error.emailNotVerified",
  invalid_invite: "error.invalidInvite",
  registration_closed: "error.registrationClosed",
  invite_required: "error.inviteRequired",
  banned: "error.banned",
  invalid_token: "error.invalidToken",
  credential_account_not_found: "error.noPassword",
  failed_to_unlink_last_account: "error.lastAccount",
};

export function errorMessage(err: unknown): string {
  if (isNetworkError(err)) return t("error.offline");
  if (err instanceof ApiError) {
    const key = known[err.code];
    if (key) return t(key);
    if (err.status === 429) return t("error.tooManyRequests");
    if (err.status === 403 && err.message) return err.message;
    if (err.status >= 500) return t("error.server");
  }
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return t("error.cancelled");
  }
  return t("error.generic");
}
