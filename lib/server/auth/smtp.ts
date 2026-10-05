import { connect as connectTls, type TLSSocket } from 'node:tls';
import { connect as connectNet, type Socket } from 'node:net';

import type { SmtpConfig } from './config';

/**
 * A minimal SMTP client, so magic-link mail needs no npm dependency.
 *
 * Covers exactly what a transactional sign-in email requires: implicit TLS
 * on port 465 (QQ/163/Aliyun direct) or STARTTLS upgrade on 587, AUTH LOGIN,
 * one HTML or plain-text message to one recipient. Multi-line replies are
 * handled per RFC 5321 (`250-` continues, `250 ` ends), message bodies are
 * dot-stuffed, headers are RFC 2047 base64 for UTF-8 subjects/names.
 */

const CRLF = '\r\n';
const COMMAND_TIMEOUT_MS = 20_000;

export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

/** One buffered line reader over the socket, so replies parse CRLF-terminated. */
function lineReader(socket: Socket): () => Promise<string> {
  let buffer = '';
  const queue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf(CRLF)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    }
  });
  return () =>
    new Promise<string>((resolve, reject) => {
      const next = queue.shift();
      if (next !== undefined) return resolve(next);
      const onLine = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      const timer = setTimeout(() => {
        const at = waiters.indexOf(onLine);
        if (at >= 0) waiters.splice(at, 1);
        reject(new SmtpError('SMTP reply timed out'));
      }, COMMAND_TIMEOUT_MS);
      waiters.push(onLine);
    });
}

/** Read a full (possibly multi-line) SMTP reply and return its status code. */
async function readReply(readLine: () => Promise<string>): Promise<{ code: number; text: string }> {
  let text = '';
  for (;;) {
    const line = await readLine();
    const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!match) throw new SmtpError(`malformed SMTP reply: ${line}`);
    text += (text ? '\n' : '') + match[3];
    if (match[2] !== '-') return { code: Number(match[1]), text };
  }
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * RFC 2045 §6.8 body encoding: base64 MIME content must be split into lines
 * of at most 76 characters; a single unwrapped line trips strict receivers
 * (QQ refuses the DATA phase with 500 'Line too long'). Headers keep using
 * plain base64() - an RFC 2047 encoded-word must stay on one line.
 */
function base64Body(value: string): string {
  const raw = base64(value);
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76));
  return lines.join(CRLF);
}

/** RFC 2047 encoded-word for UTF-8 header values (subject, display names). */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`;
}

/** Dot-stuff and CRLF-normalize the message body per RFC 5321 §4.5.2. */
function stuff(message: string): string {
  return message
    .replace(/\r?\n/g, CRLF)
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

function buildMessage(config: SmtpConfig, mail: OutboundMail): string {
  const headers = [
    `From: ${encodeHeader(config.fromName)} <${config.from}>`,
    `To: <${mail.to}>`,
    `Subject: ${encodeHeader(mail.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (mail.html) {
    const boundary = `----openmaic-${Date.now().toString(36)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return (
      headers.join(CRLF) +
      CRLF +
      CRLF +
      `--${boundary}` +
      CRLF +
      'Content-Type: text/plain; charset=utf-8' +
      CRLF +
      'Content-Transfer-Encoding: base64' +
      CRLF +
      CRLF +
      base64Body(mail.text) +
      CRLF +
      `--${boundary}` +
      CRLF +
      'Content-Type: text/html; charset=utf-8' +
      CRLF +
      'Content-Transfer-Encoding: base64' +
      CRLF +
      CRLF +
      base64Body(mail.html) +
      CRLF +
      `--${boundary}--`
    );
  }
  headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
  return headers.join(CRLF) + CRLF + CRLF + base64Body(mail.text);
}

/**
 * Send one message. Throws SmtpError with the server's own reply text on any
 * refusal, so route logs show the provider's reason (bad auth code, sender
 * not allowed, ...). The socket is always closed.
 */
export async function sendSmtpMail(config: SmtpConfig, mail: OutboundMail): Promise<void> {
  const implicitTls = config.port === 465;
  let socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(new SmtpError(`SMTP connect failed: ${error.message}`));
    const established = implicitTls
      ? connectTls(
          {
            host: config.host,
            port: config.port,
            timeout: COMMAND_TIMEOUT_MS,
            servername: config.host,
          },
          () => resolve(established),
        )
      : connectNet(
          { host: config.host, port: config.port, timeout: COMMAND_TIMEOUT_MS },
          () => resolve(established),
        );
    established.once('error', onError);
  });
  try {
    let readLine = lineReader(socket);
    const send = (line: string) => void socket.write(line + CRLF);
    const expect = async (wanted: number[], what: string) => {
      const reply = await readReply(readLine);
      if (!wanted.includes(reply.code)) {
        throw new SmtpError(`${what} refused (${reply.code}): ${reply.text}`);
      }
      return reply;
    };

    await expect([220], 'SMTP greeting');
    send(`EHLO openmaic.local`);
    await expect([250], 'EHLO');

    if (!implicitTls) {
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const upgraded = connectTls({ socket, servername: config.host }, () => resolve(upgraded));
        upgraded.once('error', (error) =>
          reject(new SmtpError(`STARTTLS upgrade failed: ${error.message}`)),
        );
      });
      readLine = lineReader(socket);
      send(`EHLO openmaic.local`);
      await expect([250], 'EHLO after STARTTLS');
    }

    send('AUTH LOGIN');
    await expect([334], 'AUTH LOGIN');
    send(base64(config.user));
    await expect([334], 'SMTP username');
    send(base64(config.pass));
    await expect([235], 'SMTP authentication');

    send(`MAIL FROM:<${config.from}>`);
    await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${mail.to}>`);
    await expect([250, 251], 'RCPT TO');
    send('DATA');
    await expect([354], 'DATA');
    socket.write(stuff(buildMessage(config, mail)) + CRLF + '.' + CRLF);
    await expect([250], 'message body');
    send('QUIT');
  } finally {
    socket.destroy();
  }
}