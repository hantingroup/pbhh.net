import process from 'node:process'
import { eq, sql } from 'drizzle-orm'
import nodemailer from 'nodemailer'
import { db, emails, notifications, users } from 'server/database'
import { bus } from '../events/bus'
import { isPrefEnabled } from '../notification/prefs'

interface ResolvedRecipient {
  status: 'resolved'
  username: string
  matchedBy: 'exact' | 'case-insensitive'
}

interface InvalidRecipient {
  status: 'invalid-domain' | 'not-found'
}

interface AmbiguousRecipient {
  status: 'ambiguous'
  candidates: string[]
}

type UnresolvedRecipient = InvalidRecipient | AmbiguousRecipient

export type MailRecipientResolution = ResolvedRecipient | UnresolvedRecipient

interface ParsedOutgoingRecipient {
  address: string
  kind: 'internal' | 'external'
  username?: string
}

interface MailRelayConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  fromAddress: string
  fromName?: string
}

interface SendMailSuccess {
  status: 'ok'
  internalCount: number
  externalCount: number
}

interface SendMailError {
  status: 'empty-recipients' | 'invalid-recipient' | 'ambiguous-recipient' | 'relay-unavailable' | 'external-send-failed'
}

export type SendMailResult = SendMailSuccess | SendMailError

let smtpTransport: nodemailer.Transporter | null | undefined

function parseRecipientAddress(address: string) {
  const trimmedAddress = address.trim()
  const atIndex = trimmedAddress.lastIndexOf('@')

  if (atIndex <= 0)
    return null

  const username = trimmedAddress.slice(0, atIndex)
  const domain = trimmedAddress.slice(atIndex + 1)

  if (!username || domain.toLowerCase() !== 'pbhh.net')
    return null

  return { username }
}

function splitRecipientAddresses(input: string) {
  return [...new Set(input
    .split(/[;；]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.includes('@') ? part : `${part}@pbhh.net`))]
}

function isValidExternalEmailAddress(address: string) {
  const trimmedAddress = address.trim()
  const atIndex = trimmedAddress.lastIndexOf('@')

  if (atIndex <= 0 || atIndex >= trimmedAddress.length - 1)
    return false

  const localPart = trimmedAddress.slice(0, atIndex)
  const domain = trimmedAddress.slice(atIndex + 1)

  if (!localPart || !domain)
    return false

  if (localPart.includes(' ') || domain.includes(' '))
    return false

  const domainParts = domain.split('.')
  return domainParts.length >= 2 && domainParts.every(part => part.length > 0)
}

function getMailRelayConfig(): MailRelayConfig | null {
  const host = process.env.SMTP_HOST?.trim()
  const fromAddress = process.env.SMTP_FROM_ADDRESS?.trim()

  if (!host || !fromAddress)
    return null

  const port = Number(process.env.SMTP_PORT || '587')
  const secure = process.env.SMTP_SECURE === 'true'
  const user = process.env.SMTP_USER?.trim() || undefined
  const pass = process.env.SMTP_PASS?.trim() || undefined
  const fromName = process.env.SMTP_FROM_NAME?.trim() || undefined

  return {
    host,
    port,
    secure,
    user,
    pass,
    fromAddress,
    fromName,
  }
}

function getSmtpTransport() {
  if (smtpTransport !== undefined)
    return smtpTransport

  const config = getMailRelayConfig()
  if (!config) {
    smtpTransport = null
    return smtpTransport
  }

  smtpTransport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass
      ? {
          user: config.user,
          pass: config.pass,
        }
      : undefined,
  })

  return smtpTransport
}

function resolveOutgoingRecipients(input: string): ParsedOutgoingRecipient[] | SendMailError {
  const addresses = splitRecipientAddresses(input)
  if (!addresses.length)
    return { status: 'empty-recipients' }

  const recipients: ParsedOutgoingRecipient[] = []

  for (const address of addresses) {
    const parsed = parseRecipientAddress(address)
    if (parsed) {
      const resolved = resolveMailRecipient(address)
      if (resolved.status === 'resolved') {
        recipients.push({
          address: `${resolved.username}@pbhh.net`,
          kind: 'internal',
          username: resolved.username,
        })
        continue
      }

      if (resolved.status === 'ambiguous')
        return { status: 'ambiguous-recipient' }

      return { status: 'invalid-recipient' }
    }

    if (!isValidExternalEmailAddress(address))
      return { status: 'invalid-recipient' }

    recipients.push({ address, kind: 'external' })
  }

  return recipients
}

export function resolveMailRecipient(address: string): MailRecipientResolution {
  const parsed = parseRecipientAddress(address)
  if (!parsed)
    return { status: 'invalid-domain' }

  const exactMatch = db.select({ username: users.username })
    .from(users)
    .where(eq(users.username, parsed.username))
    .get()

  if (exactMatch) {
    return {
      status: 'resolved',
      username: exactMatch.username,
      matchedBy: 'exact',
    }
  }

  const caseInsensitiveMatches = db.select({ username: users.username })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${parsed.username})`)
    .all()

  if (caseInsensitiveMatches.length === 1) {
    return {
      status: 'resolved',
      username: caseInsensitiveMatches[0]!.username,
      matchedBy: 'case-insensitive',
    }
  }

  if (caseInsensitiveMatches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: caseInsensitiveMatches.map(match => match.username),
    }
  }

  return { status: 'not-found' }
}

export async function sendMailFromUser(senderUsername: string, recipientsInput: string, subject: string, text: string): Promise<SendMailResult> {
  const recipients = resolveOutgoingRecipients(recipientsInput)
  if (!Array.isArray(recipients))
    return recipients

  const internalRecipients = recipients.filter(recipient => recipient.kind === 'internal')
  const externalRecipients = recipients.filter(recipient => recipient.kind === 'external')

  if (internalRecipients.some(recipient => recipient.username === senderUsername))
    return { status: 'invalid-recipient' }

  if (externalRecipients.length > 0) {
    const transport = getSmtpTransport()
    const config = getMailRelayConfig()
    if (!transport || !config)
      return { status: 'relay-unavailable' }

    try {
      await transport.sendMail({
        from: config.fromName
          ? `${config.fromName} <${config.fromAddress}>`
          : config.fromAddress,
        to: externalRecipients.map(recipient => recipient.address).join(', '),
        replyTo: `${senderUsername}@pbhh.net`,
        subject,
        text,
      })
    }
    catch {
      return { status: 'external-send-failed' }
    }
  }

  for (const recipient of internalRecipients)
    await deliverMailToUser(recipient.username!, `${senderUsername}@pbhh.net`, subject, text)

  return {
    status: 'ok',
    internalCount: internalRecipients.length,
    externalCount: externalRecipients.length,
  }
}

export async function deliverMailToUser(username: string, fromAddress: string, subject: string, text: string, html = '') {
  const user = await db.select({ username: users.username })
    .from(users)
    .where(eq(users.username, username))
    .get()

  if (!user)
    return null

  const [email] = await db.insert(emails).values({ username, fromAddress, subject, html, text }).returning({
    id: emails.id,
    subject: emails.subject,
    fromAddress: emails.fromAddress,
  })

  if (!email)
    return null

  if (!isPrefEnabled(username, 'mail'))
    return email

  await db.insert(notifications).values({
    username,
    type: 'mail',
    actorLabel: email.fromAddress,
    emailId: email.id,
  })

  bus.publish('net.pbhh.notify.mail.received', {
    recipientUsername: username,
    emailId: email.id,
    fromAddress: email.fromAddress,
    subject: email.subject,
  })

  return email
}
