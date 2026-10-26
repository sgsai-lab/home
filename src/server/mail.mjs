import nodemailer from 'nodemailer';

export function siteOrigin(env) {
  return (env.SITE_ORIGIN || 'https://www.sgsaitechnology.com').replace(/\/+$/, '');
}

export function smtpIsConfigured(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.CONTACT_FROM);
}

function transport(env) {
  const port = Number(env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000
  });
}

/** Contact and product-update enquiries to the SGS inbox. */
export async function sendNotification(submission, env) {
  if (!smtpIsConfigured(env)) throw new Error('Email delivery is not configured.');
  const lines = [
    `Source: ${submission.source}`,
    `Name: ${submission.name || '(not provided)'}`,
    `Email: ${submission.email}`,
    `Company: ${submission.company || '(not provided)'}`,
    '',
    submission.message
  ];
  await transport(env).sendMail({
    from: env.CONTACT_FROM,
    to: env.CONTACT_TO || 'hello@sgsaitechnology.com',
    replyTo: submission.email,
    subject: submission.source === 'product-updates' ? 'Website product update request' : 'Website contact enquiry',
    text: lines.join('\n')
  });
}

/** Account and workspace email to a single recipient. */
export async function sendTransactionalEmail({ to, subject, text }, env) {
  if (!smtpIsConfigured(env)) throw new Error('Email delivery is not configured.');
  await transport(env).sendMail({ from: env.CONTACT_FROM, to, subject, text });
}

const SIGNATURE = '\n\n— SGS AI Technology\nhttps://www.sgsaitechnology.com';

export const templates = {
  verifyEmail: (origin, token, name) => ({
    subject: 'Verify your email for SGS AI Technology',
    text: `Hi ${name},\n\nConfirm your email address to finish setting up your account:\n${origin}/verify-email/?token=${encodeURIComponent(token)}\n\nThe link expires in 24 hours. If you did not create an account, ignore this email.${SIGNATURE}`
  }),
  resetPassword: (origin, token, name) => ({
    subject: 'Reset your SGS AI Technology password',
    text: `Hi ${name},\n\nUse this link to choose a new password:\n${origin}/reset-password/?token=${encodeURIComponent(token)}\n\nThe link expires in 1 hour and can be used once. If you did not ask for this, you can ignore this email; your password is unchanged.${SIGNATURE}`
  }),
  invite: (origin, token, clientName, inviterName, role) => ({
    subject: `You're invited to ${clientName} on SGS AI Technology`,
    text: `Hello,\n\n${inviterName} invited you to join the ${clientName} workspace as ${role}. The workspace is where you follow your projects with SGS AI Technology and open the apps we built for you.\n\nAccept the invitation:\n${origin}/workspace/join/?token=${encodeURIComponent(token)}\n\nThe invitation expires in 7 days.${SIGNATURE}`
  }),
  accountCreated: (origin, token, name) => ({
    subject: 'Your SGS AI Technology account is ready',
    text: `Hi ${name},\n\nAn SGS AI Technology administrator created an account for you. Choose your password to sign in:\n${origin}/reset-password/?token=${encodeURIComponent(token)}\n\nThe link expires in 24 hours.${SIGNATURE}`
  })
};
