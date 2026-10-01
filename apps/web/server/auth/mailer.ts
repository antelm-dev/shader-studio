/**
 * Outbound mail for verification and password-reset links.
 *
 * Nothing here logs the link itself in production: a verification or reset URL
 * is a bearer credential, and log aggregation is not a place to keep one. In
 * development, where no SMTP server exists, printing it to the console is the
 * only way to complete the flow — and that console is the developer's own.
 */

import { createTransport, type Transporter } from 'nodemailer';

import type { MailConfig } from './auth-config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Kept separate so the development transport can print just the link. */
  link: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createMailer(config: MailConfig): Mailer {
  if (!config.url) return new ConsoleMailer();
  return new SmtpMailer(createTransport(config.url), config.from);
}

class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  async send(mail: Mail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
    } catch (error) {
      // The address is not echoed: a bounced delivery should not put a user's
      // email in the logs of every deployment that shares this code.
      console.error('[auth] failed to send a transactional email', error);
      throw error;
    }
  }
}

/** Development only: prints the link so a local flow can be completed by hand. */
class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n[auth] ${mail.subject} → ${mail.to}\n[auth] ${mail.link}\n`);
  }
}
