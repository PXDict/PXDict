// Outgoing email for Better Auth (verification, password reset, magic links, one-time codes). Only
// configured when SMTP_URL is set; every email-based sign-in method is hidden otherwise.
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpMailerOptions {
  /** smtp://user:pass@host:587 or smtps://user:pass@host:465. */
  url: string;
  /** The From header, e.g. "PXDict <dict@example.com>". */
  from: string;
}

export function createSmtpMailer({ url, from }: SmtpMailerOptions): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

/** Collects messages instead of sending them (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The newest message sent to `to`. */
  last(to: string): MailMessage | undefined {
    return this.sent.findLast((m) => m.to === to);
  }
}
