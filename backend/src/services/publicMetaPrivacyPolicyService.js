import { db } from '../config/database.js'
import { getAccountBusinessProfile } from './accountBusinessProfileService.js'

export const META_PRIVACY_POLICY_ROUTE = '/meta-privacy'

const POLICY_LAST_UPDATED = 'July 6, 2026'

function cleanString(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function normalizeEmail(value) {
  const email = cleanString(value, 180).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function normalizePublicUrl(value) {
  const raw = cleanString(value, 500)
  if (!raw) return ''

  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return parsed.href.replace(/\/+$/, '/')
  } catch {
    return ''
  }
}

function normalizeRoutePath(pathValue = '') {
  const clean = cleanString(pathValue || '/')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '')
  return (clean || '/').toLowerCase()
}

export function isMetaPrivacyPolicyPath(pathValue = '') {
  return normalizeRoutePath(pathValue) === META_PRIVACY_POLICY_ROUTE
}

function getNameFromOwner(owner = {}) {
  return cleanString(owner.business_name, 160) ||
    cleanString(owner.full_name, 160) ||
    cleanString([owner.first_name, owner.last_name].filter(Boolean).join(' '), 160)
}

async function getOwnerFallback() {
  return db.get(`
    SELECT email, full_name, first_name, last_name, business_name, username
    FROM users
    WHERE COALESCE(is_active, 1) = 1
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).catch(() => null)
}

function buildContactBlock({ businessName, email, phone, address, websiteUrl, currentWebsiteUrl }) {
  const rows = [
    `<strong>${escapeHtml(businessName)}</strong>`,
    `Website: <a href="${escapeHtml(currentWebsiteUrl)}">${escapeHtml(currentWebsiteUrl)}</a>`,
    websiteUrl && websiteUrl !== currentWebsiteUrl
      ? `Business website: <a href="${escapeHtml(websiteUrl)}">${escapeHtml(websiteUrl)}</a>`
      : '',
    email
      ? `Email: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
      : '',
    phone ? `Phone: ${escapeHtml(phone)}` : '',
    address ? `Address: ${escapeHtml(address)}` : ''
  ].filter(Boolean)

  return rows.map(row => `<p>${row}</p>`).join('\n')
}

function buildEmailContactText(email) {
  if (!email) {
    return 'through the contact channels available on this website'
  }

  return `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
}

export async function getMetaPrivacyPolicyContext({ host = '', protocol = 'https' } = {}) {
  const [profile, owner] = await Promise.all([
    getAccountBusinessProfile().catch(() => ({})),
    getOwnerFallback()
  ])

  const safeProtocol = cleanString(protocol, 10).toLowerCase() === 'http' ? 'http' : 'https'
  const cleanHost = cleanString(host, 250)
  const currentWebsiteUrl = cleanHost ? `${safeProtocol}://${cleanHost}/` : ''
  const websiteUrl = normalizePublicUrl(profile.website) || currentWebsiteUrl
  const businessName = cleanString(profile.name, 160) || getNameFromOwner(owner) || 'This business'
  const email = normalizeEmail(profile.email) || normalizeEmail(owner?.email)

  return {
    businessName,
    email,
    phone: cleanString(profile.phone, 80),
    address: cleanString(profile.address, 500),
    websiteUrl,
    currentWebsiteUrl: currentWebsiteUrl || websiteUrl || '/',
    lastUpdated: POLICY_LAST_UPDATED
  }
}

export function renderMetaPrivacyPolicyHtmlFromContext(context = {}) {
  const businessName = cleanString(context.businessName, 160) || 'This business'
  const email = normalizeEmail(context.email)
  const phone = cleanString(context.phone, 80)
  const address = cleanString(context.address, 500)
  const currentWebsiteUrl = normalizePublicUrl(context.currentWebsiteUrl) || '/'
  const websiteUrl = normalizePublicUrl(context.websiteUrl) || currentWebsiteUrl
  const contactTarget = buildEmailContactText(email)
  const contactBlock = buildContactBlock({ businessName, email, phone, address, websiteUrl, currentWebsiteUrl })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(businessName)} Privacy Policy</title>
  <meta name="description" content="Privacy Policy for ${escapeHtml(businessName)} and its Meta, Facebook, Instagram, CRM, advertising, website, and platform integrations.">
  <style>
    :root {
      color-scheme: light;
      --policy-bg: #f7f5ef;
      --policy-surface: #ffffff;
      --policy-text: #161616;
      --policy-muted: #626262;
      --policy-border: #dfd8ca;
      --policy-accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--policy-bg);
      color: var(--policy-text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.62;
    }
    main {
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 56px 0 72px;
    }
    article {
      background: var(--policy-surface);
      border: 1px solid var(--policy-border);
      border-radius: 8px;
      padding: clamp(28px, 5vw, 56px);
      box-shadow: 0 24px 70px rgba(27, 24, 18, .08);
    }
    h1, h2, h3 {
      line-height: 1.18;
      margin: 0 0 14px;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 3.5rem);
      letter-spacing: 0;
      margin-bottom: 10px;
    }
    h2 {
      font-size: clamp(1.25rem, 2.8vw, 1.75rem);
      margin-top: 38px;
    }
    h3 {
      font-size: 1.05rem;
      margin-top: 22px;
    }
    p { margin: 0 0 14px; }
    ul {
      margin: 10px 0 18px;
      padding-left: 1.3rem;
    }
    li { margin: 5px 0; }
    a {
      color: var(--policy-accent);
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .policy-eyebrow {
      color: var(--policy-muted);
      font-size: .95rem;
      margin-bottom: 28px;
    }
    .contact-block {
      border-top: 1px solid var(--policy-border);
      margin-top: 24px;
      padding-top: 18px;
    }
    .contact-block p {
      margin-bottom: 8px;
    }
    @media (max-width: 640px) {
      main {
        width: min(100% - 20px, 920px);
        padding: 20px 0 40px;
      }
      article {
        padding: 22px;
      }
    }
  </style>
</head>
<body>
  <main>
    <article>
      <h1>Privacy Policy</h1>
      <p class="policy-eyebrow">Last updated: ${escapeHtml(context.lastUpdated || POLICY_LAST_UPDATED)}</p>

      <p>This Privacy Policy describes how <strong>${escapeHtml(businessName)}</strong> collects, uses, stores, and protects information related to the use of our website, online services, CRM, business management tools, and integrations with third-party platforms, including Meta, Facebook, Instagram, and Meta Ads.</p>
      <p>By using our website, CRM, connected applications, forms, bookings, payments, communications, or related services, you agree to the practices described in this Privacy Policy.</p>

      <h2>1. Who We Are</h2>
      <p><strong>${escapeHtml(businessName)}</strong> operates this website and related digital services for business operations, client or patient acquisition, marketing, advertising, communication, automation, reporting, and commercial management.</p>
      <p>Our website is: <a href="${escapeHtml(currentWebsiteUrl)}">${escapeHtml(currentWebsiteUrl)}</a></p>
      ${websiteUrl && websiteUrl !== currentWebsiteUrl ? `<p>Our additional business website is: <a href="${escapeHtml(websiteUrl)}">${escapeHtml(websiteUrl)}</a></p>` : ''}
      <p>Through our website, CRM, and connected applications, we may help manage, analyze, and optimize advertising campaigns on platforms such as Meta, Facebook, and Instagram.</p>

      <h2>2. Information We Collect</h2>
      <p>We may collect and process information depending on the features used by the user, lead, client, patient, visitor, or account owner.</p>

      <h3>Information Provided Directly by the User</h3>
      <p>We may collect information such as:</p>
      <ul>
        <li>Full name</li>
        <li>Email address</li>
        <li>Phone number</li>
        <li>Business, clinic, company, or brand name</li>
        <li>Information submitted through contact forms, booking forms, lead forms, chats, payment forms, or support channels</li>
        <li>Information provided during onboarding, consulting, sales, support, or commercial processes</li>
        <li>Information required to create, manage, or follow up on an account, appointment, lead, opportunity, payment, or service request</li>
      </ul>

      <h3>Information Related to Advertising and Connected Accounts</h3>
      <p>When a user or client authorizes a connection with Meta, Facebook, Instagram, or Meta Ads, our platform may access information necessary to provide advertising management, measurement, and analysis features, such as:</p>
      <ul>
        <li>Advertising account IDs</li>
        <li>Facebook Page IDs</li>
        <li>Instagram Business Account IDs</li>
        <li>Campaigns, ad sets, and ads</li>
        <li>Advertising performance metrics</li>
        <li>Budgets, statuses, and campaign settings</li>
        <li>Ad creatives, copy, images, videos, or information associated with ads</li>
        <li>Information required to create, edit, manage, or analyze advertising campaigns authorized by the user</li>
      </ul>

      <h3>Technical Information</h3>
      <p>We may also collect technical information to operate, secure, and improve our services, such as:</p>
      <ul>
        <li>IP address</li>
        <li>Browser type</li>
        <li>Operating system</li>
        <li>Device information</li>
        <li>Date and time of access</li>
        <li>Activity logs within the platform</li>
        <li>Cookies or similar technologies necessary for sessions, security, analytics, attribution, and user experience</li>
      </ul>

      <h2>3. How We Use Information</h2>
      <p>We use the information collected for the following purposes:</p>
      <ul>
        <li>To provide online services, consulting, business operations, CRM features, and customer support</li>
        <li>To create and manage user, lead, client, patient, or business accounts</li>
        <li>To operate forms, appointments, payments, communication tools, automations, reports, and related platform features</li>
        <li>To allow users to connect their Meta, Facebook, or Instagram accounts</li>
        <li>To display advertising account and campaign information within the platform</li>
        <li>To create, edit, manage, or analyze campaigns, ad sets, or ads when authorized by the user</li>
        <li>To measure advertising performance</li>
        <li>To generate reports, metrics, and analytics</li>
        <li>To provide support, onboarding, and customer service</li>
        <li>To improve our website, CRM, platform, and services</li>
        <li>To protect the security, integrity, and functionality of our systems</li>
        <li>To comply with legal, contractual, security, or regulatory obligations</li>
      </ul>
      <p>We do not sell users' personal information.</p>

      <h2>4. Use of Data Obtained from Meta</h2>
      <p>When our platform connects with Meta, Facebook, Instagram, or Meta Ads, we only use data authorized by the user and permitted by the permissions approved by Meta.</p>
      <p>Data obtained from Meta is used only to provide the features requested by the user, such as viewing advertising accounts, managing campaigns, consulting performance metrics, creating ads, editing ads, responding to supported messages or comments, measuring events, or analyzing advertising results.</p>
      <p>We do not use data obtained from Meta for unauthorized purposes, and we do not sell or share such data with independent third parties for unrelated advertising, resale, or commercial use.</p>
      <p>The use of data obtained from Meta is also subject to Meta's applicable terms, policies, permissions, and platform requirements.</p>

      <h2>5. Sharing of Information</h2>
      <p>We may share information only in the following cases:</p>
      <ul>
        <li>With technology providers necessary to operate our website, CRM, platform, hosting, databases, analytics, storage, payment processing, messaging, or infrastructure</li>
        <li>With third-party platforms integrated into our services, such as Meta, when necessary to perform an action requested or authorized by the user</li>
        <li>With legal, regulatory, or governmental authorities when required by law, legal process, or to protect our rights, security, or integrity</li>
        <li>In connection with a merger, acquisition, restructuring, or transfer of assets, provided that this Privacy Policy continues to apply or users are notified of any material changes</li>
      </ul>
      <p>We do not sell personal information or share it with third parties for their independent commercial use.</p>

      <h2>6. Data Retention</h2>
      <p>We retain user information only for as long as necessary to provide our services, operate our CRM, fulfill commercial obligations, comply with legal requirements, resolve disputes, prevent fraud, maintain security, and fulfill the purposes described in this Privacy Policy.</p>
      <p>When a user disconnects their Meta, Facebook, or Instagram account, we will stop accessing new information from that connection unless the user authorizes the connection again.</p>

      <h2>7. User Data Deletion</h2>
      <p>Users may request deletion of their personal data and data associated with their account at any time.</p>
      <p>To request data deletion, please contact us at ${contactTarget} with the subject line <strong>Data Deletion Request</strong>.</p>
      <p>The request should include:</p>
      <ul>
        <li>Full name</li>
        <li>Email address associated with the account</li>
        <li>Description of the data the user wants deleted</li>
        <li>If applicable, information about the connected Meta, Facebook, or Instagram account</li>
      </ul>
      <p>After receiving the request, we may verify the identity of the requester and will process the deletion of applicable data within a reasonable timeframe, unless certain information must be retained for legal, tax, accounting, security, fraud prevention, or contractual reasons.</p>
      <p>Users may also remove or disconnect our application's access directly from their Facebook or Meta account settings under the connected apps and websites section.</p>

      <h2>8. User Rights</h2>
      <p>Depending on applicable law, users may have the right to:</p>
      <ul>
        <li>Access their personal information</li>
        <li>Correct inaccurate or incomplete information</li>
        <li>Request deletion of their personal information</li>
        <li>Request restriction of certain processing activities</li>
        <li>Object to certain uses of their data</li>
        <li>Withdraw consent for connected integrations</li>
        <li>Request information about how their data is used</li>
      </ul>
      <p>To exercise these rights, users may contact us at ${contactTarget}.</p>

      <h2>9. Information Security</h2>
      <p>We implement reasonable technical, administrative, and organizational measures to protect information against unauthorized access, loss, misuse, alteration, or disclosure.</p>
      <p>However, no digital system is completely secure. While we work to protect user information, we cannot guarantee absolute security.</p>

      <h2>10. Cookies and Similar Technologies</h2>
      <p>Our website, CRM, or platform may use cookies and similar technologies to:</p>
      <ul>
        <li>Maintain user sessions</li>
        <li>Remember user preferences</li>
        <li>Improve security</li>
        <li>Analyze platform usage</li>
        <li>Improve the user experience</li>
        <li>Support CRM, attribution, advertising-related functionality, and Meta integrations</li>
      </ul>
      <p>Users may configure their browser to block or delete cookies. However, doing so may affect the functionality of certain parts of the website, CRM, or platform.</p>

      <h2>11. Third-Party Services</h2>
      <p>Our website, CRM, or platform may contain links or integrations with third-party services, including Meta, Facebook, Instagram, payment providers, analytics services, storage providers, communication tools, or advertising platforms.</p>
      <p>The use of those third-party services is subject to their own privacy policies and terms. We are not responsible for the privacy practices of external third-party services.</p>

      <h2>12. Children's Privacy</h2>
      <p>Our services are not directed to children or minors. We do not knowingly collect personal information from children. If we become aware that we have collected personal information from a minor without proper authorization, we will take steps to delete that information.</p>

      <h2>13. Changes to This Privacy Policy</h2>
      <p>We may update this Privacy Policy from time to time. When changes are made, the updated version will be posted on this page with a new "Last updated" date.</p>
      <p>Continued use of our website, CRM, platform, or services after changes are posted means that the user accepts the updated Privacy Policy.</p>

      <h2>14. Contact</h2>
      <p>For questions, privacy requests, or data deletion requests, please contact us using the information below:</p>
      <div class="contact-block">
        ${contactBlock}
      </div>
    </article>
  </main>
</body>
</html>`
}

export async function renderMetaPrivacyPolicyHtml(options = {}) {
  return renderMetaPrivacyPolicyHtmlFromContext(await getMetaPrivacyPolicyContext(options))
}
