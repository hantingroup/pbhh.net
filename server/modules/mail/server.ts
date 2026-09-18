import type { Awaitable } from '@/types'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { deliverMailToUser, resolveMailRecipient } from './service'

type EmailHandler = (data: {
  recipientUsername: string
  toAddress: string
  subject: string
  html: string
  text: string
  fromAddress: string
}) => Awaitable<void>

const handlers: EmailHandler[] = []

export function onEmail(handler: EmailHandler) {
  handlers.push(handler)
}

function getRecipientErrorMessage(address: string) {
  const result = resolveMailRecipient(address)

  if (result.status === 'invalid-domain')
    return 'Only existing @pbhh.net recipients are accepted'

  if (result.status === 'not-found')
    return `Recipient ${address} does not exist`

  if (result.status === 'ambiguous')
    return `Recipient ${address} is ambiguous; please match username casing exactly`

  return null
}

export const mailServer = new SMTPServer({
  authOptional: true,
  onRcptTo(address, _session, callback) {
    const errorMessage = getRecipientErrorMessage(address.address)
    if (errorMessage) {
      callback(new Error(errorMessage))
      return
    }

    callback()
  },
  async onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream)
      const toAddress = session.envelope.rcptTo[0]?.address ?? ''
      const recipient = resolveMailRecipient(toAddress)

      if (recipient.status !== 'resolved') {
        callback(new Error(getRecipientErrorMessage(toAddress) ?? `Recipient ${toAddress} does not exist`))
        return
      }

      const subject = parsed.subject ?? ''
      const html = typeof parsed.html === 'string' ? parsed.html : ''
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const fromAddress = parsed.from?.text ?? ''

      for (const handler of handlers) {
        await handler({
          recipientUsername: recipient.username,
          toAddress,
          subject,
          html,
          text,
          fromAddress,
        })
      }

      callback()
    }
    catch (err) {
      callback(err as Error)
    }
  },
})

// smtp-server funnels every socket error into SMTPServer._onError, which re-emits it
// here. An unhandled 'error' event throws, so a single scanner dropping its connection
// mid-write took the whole process down with ERR_SOCKET_CLOSED.
mailServer.on('error', (err: Error & { code?: string, remoteAddress?: string }) => {
  console.warn(`[mail] connection error from ${err.remoteAddress || 'unknown'}: ${err.code || err.message}`)
})

onEmail(async ({ recipientUsername, subject, html, text, fromAddress }) => {
  await deliverMailToUser(recipientUsername, fromAddress, subject, text, html)
})
